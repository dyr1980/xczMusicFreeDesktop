import { hideModal, showModal } from "@/renderer/components/Modal";
import PluginTable from "./components/plugin-table";
import "./index.scss";
import { getUserPreference } from "@/renderer/utils/user-perference";
import { toast } from "react-toastify";
import A from "@/renderer/components/A";
import { Trans, useTranslation } from "react-i18next";
import { dialogUtil } from "@shared/utils/renderer";
import PluginManager from "@shared/plugin-manager/renderer";
import { useState } from "react";
import PQueue from "p-queue";

// 判断是否为网络临时错误（需要重试）
function isTemporaryNetworkError(err: unknown): boolean {
    if (!err) return false;
    const msg = ((err as Error).message || "").toLowerCase();
    return msg.includes("timeout")
        || msg.includes("connect")
        || msg.includes("network")
        || msg.includes("500")
        || msg.includes("502")
        || msg.includes("503")
        || msg.includes("504");
}

export default function PluginManagerView() {
    const { t } = useTranslation();
    const [isUpdating, setIsUpdating] = useState(false);
    const [progressText, setProgressText] = useState("");

    const MAX_RETRY = 2;
    const RETRY_DELAY = 800;

    // 带重试包装函数
    async function installWithRetry(url: string): Promise<{
        success: boolean;
        retried: boolean;
        error?: Error;
    }> {
        let attempt = 0;
        let retried = false;
        while (attempt <= MAX_RETRY) {
            try {
                await PluginManager.installPluginFromRemote(url);
                return { success: true, retried };
            } catch (err) {
                attempt++;
                if (attempt > MAX_RETRY || !isTemporaryNetworkError(err)) {
                    return { success: false, retried, error: err as Error };
                }
                retried = true;
                console.warn(`订阅源 ${url} 第${attempt}次失败，${RETRY_DELAY}ms后重试`, err);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            }
        }
        return { success: false, retried, error: new Error("未知错误") };
    }

    // ============ 核心：读取已保存订阅，一键安装所有插件 ============
    const handleUpdateAllSubscriptions = async () => {
        // 1. 读取用户在“订阅设置”里保存的所有订阅链接
        const subscription = getUserPreference("subscription");
        if (!subscription?.length) {
            toast.warn(t("plugin_management_page.no_subscription"));
            return;
        }

        setIsUpdating(true);
        setProgressText(`正在更新 0/${subscription.length} 个订阅源...`);

        // 2. 并发控制：最多同时请求 4 个订阅源
        const queue = new PQueue({ concurrency: 4 });

        let successCount = 0;      // 直接成功
        let retrySuccessCount = 0; // 重试后成功
        let failCount = 0;         // 最终失败
        const failReasons: string[] = [];
        const total = subscription.length;

        // 3. 把每个订阅源作为独立任务加入队列
        subscription.forEach((sub) => {
            queue.add(async () => {
                // 调用 PluginManager.installPluginFromRemote(url)
                // 如果 url 是订阅源 JSON，它会自动解析并安装里面所有插件
                const result = await installWithRetry(sub.srcUrl);

                if (result.success) {
                    if (result.retried) retrySuccessCount++;
                    else successCount++;
                } else {
                    failCount++;
                    const reason = result.error?.message?.slice(0, 50) || "未知错误";
                    failReasons.push(`${sub.srcUrl}：${reason}`);
                }

                // 4. 实时刷新遮罩层上的进度文字
                const current = successCount + retrySuccessCount + failCount;
                setProgressText(
                    `正在更新 ${current}/${total} 个订阅源...（成功 ${successCount + retrySuccessCount}，失败 ${failCount}）`,
                );
            });
        });

        // 5. 等待所有任务结束
        await queue.onIdle();

        // 6. 弹出最终结果
        const totalSuccess = successCount + retrySuccessCount;
        if (failCount === 0) {
            const retryMsg = retrySuccessCount > 0 ? `（其中 ${retrySuccessCount} 个经重试成功）` : "";
            toast.success(`全部 ${totalSuccess} 个订阅源更新成功！${retryMsg}`);
        } else {
            const showList = failReasons.slice(0, 3);
            const detailMsg = showList.length > 0
                ? ` 失败：${showList.join(" | ")}${failReasons.length > 3 ? " ..." : ""}`
                : "";
            toast.warn(
                `更新完成：成功 ${totalSuccess} 个（重试成功 ${retrySuccessCount} 个），失败 ${failCount} 个。${detailMsg}`,
                { autoClose: 8000 },
            );
        }

        setIsUpdating(false);
        setProgressText("");
    };

    return (
        <div
            id="page-container"
            className="page-container plugin-manager-view-container"
        >
            <div className="header">
                {t("plugin_management_page.plugin_management")}
            </div>
            <div className="operation-area">
                <div className="left-part">
                    <div
                        role="button"
                        data-type="normalButton"
                        onClick={async () => {
                            try {
                                const result = await dialogUtil.showOpenDialog({
                                    title: t("plugin_management_page.choose_plugin"),
                                    buttonLabel: t("plugin_management_page.install"),
                                    filters: [
                                        {
                                            extensions: ["js", "json"],
                                            name: t("plugin_management_page.musicfree_plugin"),
                                        },
                                    ],
                                });
                                if (result.canceled) return;
                                await PluginManager.installPluginFromLocal(result.filePaths[0]);
                                toast.success(t("plugin_management_page.install_successfully"));
                            } catch (e) {
                                const err = e as Error;
                                toast.warn(
                                    `${t("plugin_management_page.install_failed")}: ${
                                        err.message ?? t("plugin_management_page.invalid_plugin")
                                    }`,
                                );
                            }
                        }}
                    >
                        {t("plugin_management_page.install_from_local_file")}
                    </div>
                    <div
                        role="button"
                        data-type="normalButton"
                        onClick={() => {
                            showModal("SimpleInputWithState", {
                                title: t("plugin_management_page.install_plugin_from_network"),
                                placeholder: t("plugin_management_page.error_hint_plugin_should_end_with_js_or_json"),
                                okText: t("plugin_management_page.install"),
                                loadingText: t("plugin_management_page.installing"),
                                withLoading: true,
                                async onOk(text: string) {
                                    if (text.trim().endsWith(".json") || text.trim().endsWith(".js")) {
                                        return PluginManager.installPluginFromRemote(text);
                                    } else {
                                        throw new Error(t("plugin_management_page.error_hint_plugin_should_end_with_js_or_json"));
                                    }
                                },
                                onPromiseResolved() {
                                    toast.success(t("plugin_management_page.install_successfully"));
                                    hideModal();
                                },
                                onPromiseRejected(e: Error) {
                                    toast.warn(
                                        `${t("plugin_management_page.install_failed")}: ${
                                            e.message ?? t("plugin_management_page.invalid_plugin")
                                        }`,
                                    );
                                },
                                hints: [
                                    <Trans
                                        i18nKey={"plugin_management_page.info_hint_install_plugin"}
                                        components={{ a: <A href="https://musicfree.catcat.work"></A> }}
                                    ></Trans>,
                                ],
                            });
                        }}
                    >
                        {t("plugin_management_page.install_plugin_from_network")}
                    </div>
                </div>
                <div className="right-part">
                    <div
                        role="button"
                        data-type="normalButton"
                        onClick={() => {
                            showModal("PluginSubscription");
                        }}
                    >
                        {t("plugin_management_page.subscription_setting")}
                    </div>
                    {/* ============ 更新订阅：读取已保存订阅，一键安装所有插件 ============ */}
                    <div
                        role="button"
                        data-type="normalButton"
                        style={{
                            opacity: isUpdating ? 0.5 : 1,
                            pointerEvents: isUpdating ? "none" : "auto",
                        }}
                        onClick={handleUpdateAllSubscriptions}
                    >
                        {isUpdating ? t("plugin_management_page.updating") : t("plugin_management_page.update_subscription")}
                    </div>
                </div>
            </div>
            <PluginTable></PluginTable>

            {/* ============ 全屏 Loading 遮罩 ============ */}
            {isUpdating && (
                <div style={{
                    position: "fixed",
                    top: 0, left: 0, right: 0, bottom: 0,
                    backgroundColor: "rgba(255, 255, 255, 0.75)",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                    alignItems: "center",
                    zIndex: 9999,
                    backdropFilter: "blur(2px)",
                }}>
                    <div style={{
                        width: "48px",
                        height: "48px",
                        border: "5px solid #f17d34",
                        borderTopColor: "transparent",
                        borderRadius: "50%",
                        animation: "spin 1s linear infinite",
                        marginBottom: "16px",
                    }} />
                    <div style={{ fontSize: "16px", color: "#333", fontWeight: 500 }}>
                        {progressText}
                    </div>
                    <div style={{ fontSize: "13px", color: "#888", marginTop: "8px" }}>
                        请勿关闭窗口，安装完成后会自动消失
                    </div>
                    <style>{`
                        @keyframes spin {
                            0% { transform: rotate(0deg); }
                            100% { transform: rotate(360deg); }
                        }
                    `}</style>
                </div>
            )}
        </div>
    );
}
