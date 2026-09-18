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

export default function PluginManagerView() {
    const { t } = useTranslation();
    const [isUpdating, setIsUpdating] = useState(false);
    const [progressText, setProgressText] = useState("");

    // ============ 从网络安装单个插件 ============
    const onInstallFromNetworkClick = () => {
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
    };

    // ============ 更新订阅（核心） ============
    const onSubscribeClick = async () => {
        const urls = getUserPreference("subscription") as { srcUrl: string }[] | undefined;
        if (!urls || urls.length === 0) {
            toast.warn(t("plugin_management_page.no_subscription"));
            return;
        }

        setIsUpdating(true);
        setProgressText("正在准备...");

        // 监听主进程推送的进度
        const unsubscribe = PluginManager.onUpdateProgress((text) => {
            if (text.startsWith("__DONE__:")) {
                const result = JSON.parse(text.replace("__DONE__:", ""));
                setIsUpdating(false);
                setProgressText("");
                unsubscribe();

                if (result.failCount === 0) {
                    toast.success(`成功更新 ${result.successCount} 个插件`);
                } else {
                    toast.warn(
                        `更新完成：成功 ${result.successCount}，失败 ${result.failCount}`,
                        { autoClose: 8000 },
                    );
                    console.warn("失败详情：", result.failReasons);
                }
            } else {
                setProgressText(text);
            }
        });

        // 只发一条 IPC 消息，主进程立即返回，后台异步执行
        await PluginManager.updateSubscription(urls.map(u => u.srcUrl));
    };

    return (
        <div id="page-container" className="page-container plugin-manager-view-container">
            <div className="header">
                {t("plugin_management_page.plugin_management")}
            </div>
            <div className="operation-area">
                <div className="left-part">
                    {/* 从本地文件安装 */}
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

                    {/* 从网络安装插件 */}
                    <div
                        role="button"
                        data-type="normalButton"
                        onClick={onInstallFromNetworkClick}
                    >
                        {t("plugin_management_page.install_plugin_from_network")}
                    </div>
                </div>
                <div className="right-part">
                    {/* 订阅设置 */}
                    <div
                        role="button"
                        data-type="normalButton"
                        onClick={() => showModal("PluginSubscription")}
                    >
                        {t("plugin_management_page.subscription_setting")}
                    </div>

                    {/* 更新订阅 */}
                    <div
                        role="button"
                        data-type="normalButton"
                        style={{
                            opacity: isUpdating ? 0.5 : 1,
                            pointerEvents: isUpdating ? "none" : "auto",
                        }}
                        onClick={onSubscribeClick}
                    >
                        {isUpdating
                            ? t("plugin_management_page.updating")
                            : t("plugin_management_page.update_subscription")}
                    </div>
                </div>
            </div>
            <PluginTable></PluginTable>

            {/* 全屏 Loading 遮罩 */}
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
