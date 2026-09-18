import { app, ipcMain } from "electron";
import fs from "fs/promises";
import path from "path";
import { Plugin } from "./plugin";
import { rimraf } from "rimraf";
import _axios from "axios";
import https from "https";
import voidCallback from "@/common/void-callback";
import { localPluginHash, localPluginName } from "@/common/constant";
import localPlugin from "./internal-plugins/local-plugin";
import { addRandomHash } from "@/common/normalize-util";
import { IWindowManager } from "@/types/main/window-manager";
import AppConfig from "@shared/app-config/main";
import { compare } from "compare-versions";
import { nanoid } from "nanoid";
import logger from "@shared/logger/main";

const axios = _axios.create({
    httpsAgent: new https.Agent({
        rejectUnauthorized: false,
    }),
});

interface ICallPluginMethodParams<
    T extends keyof IPlugin.IPluginInstanceMethods,
> {
    hash: string;
    platform: string;
    method: T;
    args: Parameters<IPlugin.IPluginInstanceMethods[T]>;
}

// ============ 批量更新常量 ============
const SUBSCRIBE_STATE_KEY = "private.subscriptionState";
const SINGLE_TIMEOUT = 15000;
const FETCH_TIMEOUT = 20000;
const BATCH_SIZE = 4;
const BATCH_DELAY = 500;
const RETRY_DELAYS = [1000, 2000, 3000];

class PluginManager {
    private clonedPlugins: IPlugin.IPluginDelegate[] = [];

    private inited = false;

    private _plugins: Plugin[] = [];
    public get plugins() {
        return this._plugins;
    }

    public set plugins(newPlugins: Plugin[]) {
        this._plugins = newPlugins;
        this.clonedPlugins = newPlugins.map((p) => {
            const sPlugin: IPlugin.IPluginDelegate = {} as any;
            sPlugin.supportedMethod = [];
            for (const k in p.instance) {
                // @ts-ignore
                if (typeof p.instance[k] === "function") {
                    sPlugin.supportedMethod.push(k);
                } else {
                    // @ts-ignore
                    sPlugin[k] = p.instance[k];
                }
            }
            sPlugin.hash = p.hash;
            sPlugin.path = p.path;
            return JSON.parse(JSON.stringify(sPlugin));
        });
    }

    private windowManager: IWindowManager;

    // 插件存储路径
    private _pluginBasePath: string;

    private get pluginBasePath() {
        if (this._pluginBasePath) {
            return this._pluginBasePath;
        }
        this._pluginBasePath = path.resolve(
            app.getPath("userData"),
            "./musicfree-plugins",
        );
        return this._pluginBasePath;
    }

    public async setup(windowManager: IWindowManager) {
        this.windowManager = windowManager;
        // 1. setup events
        ipcMain.handle("@shared/plugin-manager/call-plugin-method", (_evt, data) => {
            return this.callPluginMethod(data);
        });

        ipcMain.handle("@shared/plugin-manager/get-all-plugins", () => this.clonedPlugins);

        ipcMain.handle("@shared/plugin-manager/load-all-plugins", async () => {
            if (!this.inited) {
                await this.loadAllPlugins();
            } else {
                this.syncPlugins();
            }
            return this.clonedPlugins;
        });

        ipcMain.handle("@shared/plugin-manager/uninstall-plugin", async (_, hash) => {
            await this.uninstallPlugin(hash);
            this.syncPlugins();
        });

        ipcMain.on("@shared/plugin-manager/update-all-plugins", this.updateAllPlugins);

        ipcMain.handle("@shared/plugin-manager/install-plugin-remote", async (_, urlLike) => {
            return await this.installPluginFromRemoteUrl(urlLike);
        });

        ipcMain.handle("@shared/plugin-manager/install-plugin-local", async (_, urlLike) => {
            return await this.installPluginFromLocalFile(urlLike);
        });

        // ============ 新增：批量更新订阅（主进程后台执行 + 进度推送） ============
        ipcMain.handle("@shared/plugin-manager/update-subscription", async (event, subscriptionUrls: string[]) => {
            const sender = event.sender;
            const send = (text: string) => {
                if (!sender.isDestroyed()) {
                    sender.send("@shared/plugin-manager/update-progress", text);
                }
            };

            // 后台异步执行，立刻返回
            (async () => {
                // ⭐ 关键：让出主进程事件循环，保证 ipcMain.handle 立刻返回
                await new Promise(r => setImmediate(r));

                let successCount = 0;
                let retrySuccessCount = 0;
                let failCount = 0;
                const failReasons: string[] = [];
                let removedCount = 0;

                try {
                    send("正在获取订阅清单...");

                    // ⭐ 读取上次订阅状态：包在 setImmediate 里，避免同步阻塞
                    const previousState = await new Promise<Record<string, string[]>>(resolve => {
                        setImmediate(() => resolve(this.getSubscriptionState()));
                    });
                    const newState: Record<string, string[]> = {};
                    const remoteUrlSet = new Set<string>();

                    // ========== 阶段 1：拉取所有订阅的插件列表 ==========
                    for (let i = 0; i < subscriptionUrls.length; ++i) {
                        const subUrl = subscriptionUrls[i];
                        send(`正在获取订阅 ${i + 1}/${subscriptionUrls.length}`);

                        try {
                            const urls = await this.fetchSubscriptionPluginUrls(subUrl);
                            newState[subUrl] = urls;
                            urls.forEach(u => remoteUrlSet.add(u));
                        } catch (e) {
                            // 拉取失败时保留上次记录，避免误删
                            const keep = previousState[subUrl] ?? [];
                            newState[subUrl] = keep;
                            keep.forEach(u => remoteUrlSet.add(u));
                            failReasons.push(`${subUrl}：清单获取失败 - ${(e as Error).message}`);
                        }
                    }

                    const remoteList = Array.from(remoteUrlSet);
                    const total = remoteList.length;

                    if (total === 0) {
                        send(`__DONE__:${JSON.stringify({ successCount: 0, retrySuccessCount: 0, failCount: 0, failReasons, removedCount: 0 })}`);
                        return;
                    }

                    // ========== 阶段 2：分批并发 + 3 轮重试 ==========
                    const failedUrls: string[] = [];
                    let completed = 0;

                    // 第一阶段：分批并发
                    for (let i = 0; i < remoteList.length; i += BATCH_SIZE) {
                        const batch = remoteList.slice(i, i + BATCH_SIZE);
                        const batchResults = await Promise.all(
                            batch.map(url => this.installOnePluginByUrl(url)),
                        );

                        for (let j = 0; j < batchResults.length; j++) {
                            if (batchResults[j].success) {
                                successCount++;
                            } else {
                                failedUrls.push(batch[j]);
                            }
                            completed++;
                        }
                        send(`正在安装 ${completed}/${total} 个插件...`);

                        if (i + BATCH_SIZE < remoteList.length) {
                            await new Promise(r => setTimeout(r, BATCH_DELAY));
                        }
                    }

                    // 第二阶段：多轮重试
                    let stillFailed = [...failedUrls];
                    for (let round = 0; round < RETRY_DELAYS.length; round++) {
                        if (stillFailed.length === 0) break;

                        const nextRound: string[] = [];
                        for (let k = 0; k < stillFailed.length; k++) {
                            const url = stillFailed[k];
                            send(`重试第 ${round + 1} 轮 · ${k + 1}/${stillFailed.length}`);
                            await new Promise(r => setTimeout(r, RETRY_DELAYS[round]));

                            const r = await this.installOnePluginByUrl(url);
                            if (r.success) {
                                retrySuccessCount++;
                            } else {
                                nextRound.push(url);
                            }
                        }
                        stillFailed = nextRound;
                    }

                    // 第三阶段：最终失败列表
                    for (const url of stillFailed) {
                        failCount++;
                        failReasons.push(`${url}：网络超时或源失效`);
                    }

                    // ========== 阶段 3：删除"上次来自订阅、这次不在订阅里"的插件 ==========
                    const previousAllUrls = new Set<string>();
                    for (const subUrl of Object.keys(previousState)) {
                        (previousState[subUrl] ?? []).forEach(u => previousAllUrls.add(u));
                    }
                    const toRemove = Array.from(previousAllUrls).filter(u => !remoteUrlSet.has(u));

                    for (let i = 0; i < toRemove.length; ++i) {
                        send(`正在移除失效插件 ${i + 1}/${toRemove.length}`);
                        const ok = await this.uninstallPluginBySrcUrl(toRemove[i]);
                        if (ok) removedCount++;
                    }

                    // ========== 阶段 4：保存新的订阅状态 ==========
                    await new Promise<void>(resolve => {
                        setImmediate(() => {
                            this.setSubscriptionState(newState);
                            resolve();
                        });
                    });

                    // ========== 阶段 5：同步插件列表 ==========
                    this.syncPlugins();

                    // ========== 完成 ==========
                    send(`__DONE__:${JSON.stringify({ successCount, retrySuccessCount, failCount, failReasons, removedCount })}`);
                } catch (e) {
                    send(`__DONE__:${JSON.stringify({ successCount, retrySuccessCount, failCount, failReasons, removedCount })}`);
                }
            })();

            return { started: true };
        });

        // 2. check if folder exists
        let folderExists = true;
        try {
            const res = await fs.stat(this.pluginBasePath);
            if (!res.isDirectory()) {
                await rimraf(this.pluginBasePath);
                folderExists = false;
            }
        } catch {
            folderExists = false;
        }
        if (!folderExists) {
            await fs.mkdir(this.pluginBasePath, {
                recursive: true,
            }).catch(voidCallback);
        }

        // 3. load all plugins
        await this.loadAllPlugins();
        this.inited = true;
    }

    // 调用某个插件的方法
    private callPluginMethod({
        hash,
        platform,
        method,
        args,
    }: ICallPluginMethodParams<keyof IPlugin.IPluginInstanceMethods>,
    ) {
        let plugin: Plugin;
        if (hash === localPluginHash || platform === localPluginName) {
            plugin = localPlugin;
        } else if (hash) {
            plugin = this.plugins.find((item) => item.hash === hash);
        } else if (platform) {
            plugin = this.plugins.find((item) => item.name === platform);
        }
        if (!plugin) {
            return null;
        }
        return plugin.methods[method]?.apply?.({ plugin }, args);
    }

    private syncPlugins() {
        const mainWindow = this.windowManager.mainWindow;
        if (mainWindow) {
            mainWindow.webContents.send("@/shared/plugin-manager/sync-plugins", this.clonedPlugins);
        }
    }


    /********************** 安装插件 *******************/
    private async installPluginFromRawCodeImpl(funcCode: string) {
        const plugins = this.plugins;
        const plugin = new Plugin(funcCode, "");
        const pluginIndex = plugins.findIndex((p) => p.hash === plugin.hash);
        if (pluginIndex !== -1) {
            // 静默忽略
            return;
        }
        const oldVersionPlugin = plugins.find((p) => p.name === plugin.name);
        if (
            oldVersionPlugin &&
            !AppConfig.getConfig("plugin.notCheckPluginVersion")
        ) {
            if (
                compare(
                    oldVersionPlugin.instance.version ?? "",
                    plugin.instance.version ?? "",
                    ">",
                )
            ) {
                throw new Error("已安装更新版本的插件");
            }
        }

        if (plugin.hash !== "") {
            const fn = nanoid();
            const _pluginPath = path.resolve(this.pluginBasePath, `${fn}.js`);
            await fs.writeFile(_pluginPath, funcCode, "utf8");
            plugin.path = _pluginPath;
            let newPlugins = plugins.concat(plugin);
            if (oldVersionPlugin) {
                newPlugins = newPlugins.filter((_) => _.hash !== oldVersionPlugin.hash);
                try {
                    await rimraf(oldVersionPlugin.path);
                } catch {
                    // pass
                }
            }
            this.plugins = newPlugins;
            return;
        }
        throw new Error("插件无法解析!");
    }

    private async installPluginFromUrlImpl(urlLike: string) {
        const funcCode = (await axios.get(urlLike)).data;
        if (funcCode) {
            await this.installPluginFromRawCodeImpl(funcCode);
        }
    }

    // 加载所有插件
    public async loadAllPlugins() {
        const rawPluginNames = await fs.readdir(this.pluginBasePath);
        const pluginHashSet = new Set<string>();
        const plugins: Plugin[] = [];
        for (let i = 0; i < rawPluginNames.length; ++i) {
            try {
                const pluginPath = path.resolve(this.pluginBasePath, rawPluginNames[i]);
                const fileStat = await fs.stat(pluginPath);
                if (fileStat.isFile() && path.extname(pluginPath) === ".js") {
                    const funcCode = await fs.readFile(pluginPath, "utf-8");
                    const plugin = new Plugin(funcCode, pluginPath);
                    if (pluginHashSet.has(plugin.hash)) {
                        continue;
                    }
                    if (plugin.hash !== "") {
                        pluginHashSet.add(plugin.hash);
                        plugins.push(plugin);
                    }
                }
            } catch (e) {
                logger.logError("插件加载失败", e as Error);
            }
        }
        this.plugins = plugins;
        this.syncPlugins();
    }

    // 从本地文件安装插件
    public async installPluginFromLocalFile(urlLike: string) {
        try {
            const url = urlLike.trim();
            if (url.endsWith(".js")) {
                const rawCode = await fs.readFile(url, "utf8");
                await this.installPluginFromRawCodeImpl(rawCode);
            } else if (url.endsWith(".json")) {
                const jsonFile = JSON.parse(await fs.readFile(url, "utf8"));

                for (const cfg of jsonFile?.plugins ?? []) {
                    await this.installPluginFromUrlImpl(addRandomHash(cfg.url));
                }
            }
        } finally {
            this.syncPlugins();
        }
    }

    // 从远程url安装插件
    public async installPluginFromRemoteUrl(urlLike: string) {
        try {
            const url = urlLike.trim();
            if (url.endsWith(".js")) {
                await this.installPluginFromUrlImpl(addRandomHash(url));
            } else if (url.endsWith(".json")) {
                const jsonFile = (await axios.get(addRandomHash(url))).data;

                for (const cfg of jsonFile?.plugins ?? []) {
                    await this.installPluginFromUrlImpl(addRandomHash(cfg.url));
                }
            }
        } finally {
            this.syncPlugins();
        }
    }

    // 更新所有插件
    public async updateAllPlugins() {
        return Promise.allSettled(
            this.plugins.map((plg) =>
                plg.instance.srcUrl ? this.installPluginFromRemoteUrl(plg.instance.srcUrl) : null,
            ),
        );
    }

    // 卸载插件
    public async uninstallPlugin(hash: string) {
        const targetIndex = this.plugins.findIndex((_) => _.hash === hash);
        if (targetIndex !== -1) {
            try {
                await rimraf(this.plugins[targetIndex].path);
                this.plugins = this.plugins.filter((_) => _.hash !== hash);
            } catch {
                // pass
            }
        }
    }

    /********************** 批量更新订阅辅助方法 *******************/

    /** 拉取订阅 JSON，返回插件 URL 列表 */
    private async fetchSubscriptionPluginUrls(subUrl: string): Promise<string[]> {
        const res = await axios.get(addRandomHash(subUrl), {
            timeout: FETCH_TIMEOUT,
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

    /** 安装单个插件（15 秒超时） */
    private async installOnePluginByUrl(url: string): Promise<{ success: boolean }> {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            const timeoutPromise = new Promise<{ success: boolean }>(resolve => {
                timer = setTimeout(() => {
                    resolve({ success: false });
                }, SINGLE_TIMEOUT);
            });
            const installPromise = this.installPluginFromUrlImpl(addRandomHash(url))
                .then(() => ({ success: true }))
                .catch(() => ({ success: false }));
            return await Promise.race([installPromise, timeoutPromise]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /** 读取上次订阅状态 */
    private getSubscriptionState(): Record<string, string[]> {
        try {
            const raw = AppConfig.getConfig(SUBSCRIBE_STATE_KEY as any);
            if (!raw) return {};
            if (typeof raw === "string") {
                try { return JSON.parse(raw); } catch { return {}; }
            }
            return raw as Record<string, string[]>;
        } catch {
            return {};
        }
    }

    /** 保存订阅状态 */
    private setSubscriptionState(state: Record<string, string[]>) {
        try {
            AppConfig.setConfig({ [SUBSCRIBE_STATE_KEY]: state } as any);
        } catch (e) {
            logger.logError("保存订阅状态失败", e as Error);
        }
    }

    /** 通过 srcUrl 找到已安装的插件并卸载 */
    private async uninstallPluginBySrcUrl(srcUrl: string): Promise<boolean> {
        try {
            const target = this.plugins.find((p) => (p.instance as any)?.srcUrl === srcUrl);
            if (target) {
                await this.uninstallPlugin(target.hash);
                return true;
            }
        } catch (e) {
            logger.logError(`卸载插件失败: ${srcUrl}`, e as Error);
        }
        return false;
    }
}


export default new PluginManager();
