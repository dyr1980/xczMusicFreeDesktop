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
import PQueue from "p-queue"; // 使用项目已有的 p-queue 库
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
    // 可配置参数
    const MAX_RETRY = 2;
    const RETRY_DELAY = 800;
    // 带重试包装函数，返回 { success: boolean, retried: boolean, error?: Error }
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
    // 更新订阅的函数
    const handleUpdateAllSubscriptions = async () => {
        const subscription = getUserPreference("subscription");
        if (!subscription?.length) {
            toast.warn(t("plugin_management_page.no_subscription"));
            return;
        }
        setIsUpdating(true);
        // 1. 并发队列，上限 4
        const queue = new PQueue({ concurrency: 4 });
        // 统计
        let successCount = 0;      // 直接成功
        let retrySuccessCount = 0; // 重试后成功
        let failCount = 0;         // 最终失败
        const failReasons: string[] = []; // 失败原因摘要
        const total = subscription.length;
        // 2. 初始加载提示
        const toastId = toast.loading(`正在更新 0/${total} 个订阅源...`);
        // 3. 遍历订阅源，加入队列
        subscription.forEach((sub) => {
            queue.add(async () => {
                const result = await installWithRetry(sub.srcUrl);
                if (result.success) {
                    if (result.retried) {
                        retrySuccessCount++;
                    } else {
                        successCount++;
                    }
                } else {
                    failCount++;
                    // 记录失败原因（截取前 50 字符，避免太长）
                    const reason = result.error?.message?.slice(0, 50) || "未知错误";
                    failReasons.push(`${sub.srcUrl}：${reason}`);
                }
                // 4. 实时更新进度
                const current = successCount + retrySuccessCount + failCount;
                if (current <= total) {
                    toast.update(toastId, {
                        render: `正在更新 ${current}/${total} 个订阅源...（成功 ${successCount + retrySuccessCount}，失败 ${failCount}）`,
                    });
                }
            });
        });
        // 5. 等待所有任务完成
        await queue.onIdle();
        // 6. 最终结果提示
        const totalSuccess = successCount + retrySuccessCount;
        if (failCount === 0) {
            // 全部成功
            const retryMsg = retrySuccessCount > 0 ? `（其中 ${retrySuccessCount} 个经重试成功）` : "";
            toast.update(toastId, {
                render: `全部 ${totalSuccess} 个订阅源更新成功！${retryMsg}`,
                type: "success",
                isLoading: false,
                autoClose: 3000,
            });
        } else {
            // 有失败，改用 | 分隔，避免 \n 无效换行
            const showList = failReasons.slice(0, 3);
            const detailMsg = showList.length > 0
                ? ` 失败：${showList.join(" | ")}${failReasons.length > 3 ? " ..." : ""}`
                : "";
            toast.update(toastId, {
                render: `更新完成：成功 ${totalSuccess} 个（重试成功 ${retrySuccessCount} 个），失败 ${failCount} 个。${detailMsg}`,
                type: "warning",
                isLoading: false,
                autoClose: 8000,
            });
        }
        setIsUpdating(false);
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
                                if (result.canceled) {
                                    return;
                                }
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
                                placeholder: t(
                                    "plugin_management_page.error_hint_plugin_should_end_with_js_or_json",
                                ),
                                okText: t("plugin_management_page.install"),
                                loadingText: t("plugin_management_page.installing"),
                                withLoading: true,
                                async onOk(text: string) {
                                    if (
                                        text.trim().endsWith(".json") ||
                                        text.trim().endsWith(".js")
                                    ) {
                                        return PluginManager.installPluginFromRemote(text);
                                    } else {
                                        throw new Error(
                                            t(
                                                "plugin_management_page.error_hint_plugin_should_end_with_js_or_json",
                                            ),
                                        );
                                    }
                                },
                                onPromiseResolved() {
                                    toast.success(
                                        t("plugin_management_page.install_successfully"),
                                    );
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
                                        components={{
                                            a: <A href="https://musicfree.catcat.work"></A>,
                                        }}
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
                    <div
                        role="button"
                        data-type="normalButton"
                        style={{
                            opacity: isUpdating ? 0.5 : 1,
                            pointerEvents: isUpdating ? "none" : "auto"
                        }}
                        onClick={handleUpdateAllSubscriptions}
                    >
                        {isUpdating ? t("plugin_management_page.updating") : t("plugin_management_page.update_subscription")}
                    </div>
                </div>
            </div>
            <PluginTable></PluginTable>
        </div>
    );
}
