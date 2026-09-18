import { hideModal, showModal } from "@/renderer/components/Modal";
import PluginTable from "./components/plugin-table";
import "./index.scss";
import { getUserPreference } from "@/renderer/utils/user-perference";
import { toast } from "react-toastify";
import A from "@/renderer/components/A";
import { Trans, useTranslation } from "react-i18next";
import { dialogUtil } from "@shared/utils/renderer";
import PluginManager from "@shared/plugin-manager/renderer";
import { useState, useRef } from "react";
import axios from "axios";

// ============ 类型定义 ============
interface IInstallPluginResult {
    success: boolean;
    message?: string;
    pluginUrl?: string;
}

// ============ 常量配置 ============
const SUBSCRIBE_STATE_KEY = "subscription_state"; // 存在 localStorage 里的 key
const SINGLE_TIMEOUT = 15000;       // 单个插件安装超时
const FETCH_TIMEOUT = 20000;        // 清单获取超时
const BATCH_SIZE = 4;                // 每批并发数
const BATCH_DELAY = 500;             // 批间延迟
const RETRY_DELAYS = [1000, 2000, 3000]; // 多轮重试延迟

// ============ 辅助函数 ============

/** 读取上次订阅状态：{ [订阅URL]: [插件URL...] } */
function getSubscriptionState(): Record<string, string[]> {
    try {
        const raw = localStorage.getItem(SUBSCRIBE_STATE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null) {
            return parsed as Record<string, string[]>;
        }
        return {};
    } catch {
        return {};
    }
}

/** 保存订阅状态 */
function setSubscriptionState(state: Record<string, string[]>) {
    try {
        localStorage.setItem(SUBSCRIBE_STATE_KEY, JSON.stringify(state));
    } catch (e) {
        console.warn("保存订阅状态失败", e);
    }
}

/** 拉取订阅 JSON，返回其中所有插件 URL，兼容根数组 / {plugins:[]} 两种格式 */
async function fetchSubscriptionPluginUrls(subUrl: string, signal: AbortSignal): Promise<string[]> {
    const res = await axios.get(subUrl, {
        timeout: FETCH_TIMEOUT,
        signal,
        headers: {
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
            Expires: "0",
        },
    });
    let pluginList: any[] = [];
    if (Array.isArray(res.data)) {
        pluginList = res.data;
    } else if (Array.isArray(res.data?.plugins)) {
        pluginList = res.data.plugins;
    }
    const urls: string[] = pluginList
        .map((_: any) => _.url)
        .filter((u: any) => u && String(u).trim());
    return Array.from(new Set(urls));
}

/** 安装单个插件 URL（15 秒超时保护） */
async function installOnePluginByUrl(url: string): Promise<IInstallPluginResult> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        const timeoutPromise = new Promise<IInstallPluginResult>(resolve => {
            timer = setTimeout(() => {
                resolve({
                    success: false,
                    message: "请求超时（15秒）",
                    pluginUrl: url,
                });
            }, SINGLE_TIMEOUT);
        });

        const result = await Promise.race([
            PluginManager.installPluginFromRemote(url),
            timeoutPromise,
        ]);

        // PluginManager 成功时返回 undefined 或对象，这里统一包装
        if (result === undefined || result === null) {
            return { success: true, pluginUrl: url };
        }
        if (typeof result === "object" && "success" in result) {
            return {
                success: (result as any).success,
                message: (result as any).message,
                pluginUrl: url,
            };
        }
        return { success: true, pluginUrl: url };
    } catch (e: any) {
        return {
            success: false,
            message: e?.message ?? String(e),
            pluginUrl: url,
        };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** 通过 srcUrl 找到已安装的插件并卸载 */
async function uninstallPluginBySrcUrl(srcUrl: string): Promise<boolean> {
    try {
        // 兼容异步/同步 getSortedPlugins
        const plugins: any[] = await ((PluginManager as any).getSortedPlugins?.() ?? []);
        const target = plugins.find((p: any) => p.instance?.srcUrl === srcUrl);
        if (target) {
            await PluginManager.uninstallPlugin(target.hash);
            return true;
        }
    } catch (e: any) {
        console.warn("卸载插件失败", srcUrl, e?.message);
    }
    return false;
}

// ============ 组件 ============
export default function PluginManagerView() {
    const { t } = useTranslation();
    const [isUpdating, setIsUpdating] = useState(false);
    const [progressText, setProgressText] = useState("");

    // 取消标记
    const cancelRef = useRef(false);

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
        // 1. 读取用户保存的订阅 URL 列表
        const urls = getUserPreference("subscription") as { srcUrl: string }[] | undefined;
        if (!urls || urls.length === 0) {
            toast.warn(t("plugin_management_page.no_subscription"));
            return;
        }

        setIsUpdating(true);
        setProgressText("正在准备...");
        cancelRef.current = false;
        const abortController = new AbortController();

        // 让 React 先渲染遮罩
        await new Promise(r => setTimeout(r, 50));

        const allResults: IInstallPluginResult[] = [];
        let removedCount = 0;

        try {
            // 读取上次同步状态
            const previousState = getSubscriptionState();
            const newState: Record<string, string[]> = {};
            const remoteUrlSet = new Set<string>();

            // ========== 阶段 1：拉取所有订阅的插件列表 ==========
            for (let i = 0; i < urls.length; ++i) {
                if (cancelRef.current) {
                    abortController.abort();
                    break;
                }
                const subUrl = urls[i].srcUrl;
                setProgressText(`正在获取订阅 ${i + 1}/${urls.length}`);

                try {
                    const remoteUrls = await fetchSubscriptionPluginUrls(subUrl, abortController.signal);
                    newState[subUrl] = remoteUrls;
                    remoteUrls.forEach(u => remoteUrlSet.add(u));
                } catch (e: any) {
                    // 拉取失败时保留上次记录，避免误删
                    const keep = previousState[subUrl] ?? [];
                    newState[subUrl] = keep;
                    keep.forEach(u => remoteUrlSet.add(u));
                    console.warn("订阅拉取失败", subUrl, e?.message);
                }
            }

            // ========== 阶段 2：分批并发安装所有插件 ==========
            const remoteList = Array.from(remoteUrlSet);
            const total = remoteList.length;
            let completed = 0;

            // 进度节流
            let lastProgressUpdate = 0;
            const reportProgress = (current: number) => {
                const now = Date.now();
                if (now - lastProgressUpdate >= 200 || current === total) {
                    lastProgressUpdate = now;
                    setProgressText(`正在安装插件 ${current}/${total}`);
                }
            };

            // 第一阶段：分批并发
            const failedUrls: string[] = [];
            for (let i = 0; i < remoteList.length; i += BATCH_SIZE) {
                if (cancelRef.current) break;
                const batch = remoteList.slice(i, i + BATCH_SIZE);
                const batchResults = await Promise.all(batch.map(installOnePluginByUrl));

                for (let j = 0; j < batchResults.length; j++) {
                    if (batchResults[j].success) {
                        allResults.push(batchResults[j]);
                    } else {
                        failedUrls.push(batch[j]);
                    }
                    completed++;
                }
                reportProgress(completed);

                if (i + BATCH_SIZE < remoteList.length) {
                    await new Promise(r => setTimeout(r, BATCH_DELAY));
                }
            }

            // 第二阶段：多轮重试
            let stillFailed = [...failedUrls];
            for (let round = 0; round < RETRY_DELAYS.length; round++) {
                if (stillFailed.length === 0) break;
                if (cancelRef.current) break;

                const roundNo = round + 1;
                const nextRound: string[] = [];

                for (let k = 0; k < stillFailed.length; k++) {
                    if (cancelRef.current) break;
                    const url = stillFailed[k];
                    setProgressText(
                        `重试第 ${roundNo} 轮 · ${k + 1}/${stillFailed.length}，总进度：${completed}/${total}`,
                    );
                    await new Promise(r => setTimeout(r, RETRY_DELAYS[round]));
                    const r = await installOnePluginByUrl(url);
                    if (r.success) {
                        allResults.push(r);
                        completed++;
                    } else {
                        nextRound.push(url);
                    }
                }
                stillFailed = nextRound;
            }

            // 第三阶段：最终失败列表
            for (const url of stillFailed) {
                allResults.push({
                    success: false,
                    message: "网络超时，多次重试仍失败（该源可能已失效）",
                    pluginUrl: url,
                });
            }

            // ========== 阶段 3：删除"上次来自订阅、这次不在订阅里"的插件 ==========
            const previousAllUrls = new Set<string>();
            for (const subUrl of Object.keys(previousState)) {
                (previousState[subUrl] ?? []).forEach(u => previousAllUrls.add(u));
            }
            const toRemove = Array.from(previousAllUrls).filter(u => !remoteUrlSet.has(u));

            for (let i = 0; i < toRemove.length; ++i) {
                if (cancelRef.current) break;
                setProgressText(`正在移除失效插件 ${i + 1}/${toRemove.length}`);
                const ok = await uninstallPluginBySrcUrl(toRemove[i]);
                if (ok) removedCount++;
            }

            // ========== 阶段 4：保存新的订阅状态 ==========
            setSubscriptionState(newState);

            // ========== 阶段 5：结果汇总 ==========
            showInstallSummary(allResults, removedCount);
        } catch (e: any) {
            toast.warn(`更新失败：${e?.message ?? String(e)}`);
        } finally {
            setIsUpdating(false);
            setProgressText("");
        }
    };

    // ============ 汇总提示 ============
    function showInstallSummary(results: IInstallPluginResult[], removedCount: number) {
        if (!results || results.length === 0) {
            if (removedCount > 0) {
                toast.success(`已移除 ${removedCount} 个失效插件`);
            } else {
                toast.warn(t("plugin_management_page.subscription_invalid") ?? "订阅源无效或没有可用插件");
            }
            return;
        }

        const successResults = results.filter(r => r.success);
        const failResults = results.filter(r => !r.success);

        const timeoutFailures: IInstallPluginResult[] = [];
        const invalidFailures: IInstallPluginResult[] = [];
        const otherFailures: IInstallPluginResult[] = [];

        failResults.forEach(r => {
            const msg = (r.message ?? "").toLowerCase();
            if (msg.includes("超时") || msg.includes("timeout")) {
                timeoutFailures.push(r);
            } else if (
                msg.includes("404") || msg.includes("403") ||
                msg.includes("不存在") || msg.includes("无法解析") || msg.includes("无法识别")
            ) {
                invalidFailures.push(r);
            } else {
                otherFailures.push(r);
            }
        });

        const total = results.length;
        const successCount = successResults.length;
        const failCount = failResults.length;

        // 全部成功
        if (failCount === 0) {
            const removeMsg = removedCount > 0 ? `，移除 ${removedCount} 个失效插件` : "";
            toast.success(`成功更新 ${successCount}/${total} 个插件${removeMsg}`);
            return;
        }

        // 部分成功
        const parts: string[] = [`成功 ${successCount}/${total}`];
        const failParts: string[] = [`失败 ${failCount}`];
        if (timeoutFailures.length > 0) failParts.push(`超时 ${timeoutFailures.length}`);
        if (invalidFailures.length > 0) failParts.push(`源失效 ${invalidFailures.length}`);
        if (otherFailures.length > 0) failParts.push(`其他 ${otherFailures.length}`);
        const summaryText = `${parts.join("，")}（${failParts.join(" · ")}）`;

        // 失败详情输出到控制台，方便排查（桌面端无需弹窗）
        console.warn("插件安装失败详情：", failResults);

        toast.warn(
            `更新完成：${summaryText}${removedCount > 0 ? `，移除 ${removedCount} 个失效插件` : ""}`,
            { autoClose: 8000 },
        );
    }

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
