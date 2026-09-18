import path from "path";
import { app, ipcMain } from "electron";
import originalFs from "fs";
import fs from "fs/promises";
import { rimraf } from "rimraf";
import { IAppConfig } from "@/types/app-config";
import { IWindowManager } from "@/types/main/window-manager";
import logger from "@shared/logger/main";
import _defaultAppConfig from "@shared/app-config/default-app-config";


class AppConfig {
    private _configPath: string;
    private windowManager: IWindowManager;
    private config: IAppConfig;

    private onAppConfigUpdatedCallbacks = new Set<(patch: IAppConfig, config: IAppConfig, from: "main" | "renderer") => void>();

    get configPath() {
        if (!this._configPath) {
            this._configPath = path.resolve(app.getPath("userData"), "config.json");
        }
        return this._configPath;
    }


    private async checkPath() {
        const configDirPath = app.getPath("userData");

        try {
            const res = await fs.stat(configDirPath);
            if (!res.isDirectory()) {
                await rimraf(configDirPath);
                throw new Error("Not a valid path");
            }
        } catch {
            await fs.mkdir(configDirPath, {
                recursive: true,
            });
        }

        try {
            const res = await fs.stat(this.configPath);
            if (!res.isFile()) {
                await rimraf(this.configPath);
                throw new Error("Not a valid path");
            }
        } catch {
            await fs.writeFile(this.configPath, JSON.stringify(_defaultAppConfig, undefined, 4), "utf-8");
        }
    }

    async setup(windowManager: IWindowManager) {
        this.windowManager = windowManager;

        await this.checkPath();
        await this.loadConfig();

        // Bind events
        ipcMain.handle("@shared/app-config/sync-app-config", () => {
            return this.config;
        });

        ipcMain.on("@shared/app-config/set-app-config", (_rawEvt, data: IAppConfig) => {
            // ⭐ 不 await，立刻返回
            this._setConfig(data, "renderer").catch(e => logger.logError("设置配置失败", e));
        });

        ipcMain.on("@shared/app-config/reset", () => {
            this.reset();
        });
    }

    public onConfigUpdated(callback: (patch: IAppConfig, config: IAppConfig, from: "main" | "renderer") => void) {
        this.onAppConfigUpdatedCallbacks.add(callback);
    }

    public offConfigUpdated(callback: (patch: IAppConfig, config: IAppConfig, from: "main" | "renderer") => void) {
        this.onAppConfigUpdatedCallbacks.delete(callback);
    }

    async migrateOldVersionConfig() {
        if (this.config["$schema-version"] >= 0) {
            return;
        }
        try {
            const oldConfig = this.config as any;
            const newConfig: any = {
                "normal.closeBehavior": oldConfig.normal?.closeBehavior === "exit" ? "exit_app" : oldConfig.normal?.closeBehavior,
                "normal.maxHistoryLength": oldConfig.normal?.maxHistoryLength,
                "normal.checkUpdate": oldConfig.normal?.checkUpdate,
                "normal.taskbarThumb": oldConfig.normal?.taskbarThumb,
                "normal.musicListColumnsShown": oldConfig.normal?.musicListColumnsShown,
                "normal.language": oldConfig.normal?.language,

                "playMusic.caseSensitiveInSearch": oldConfig.playMusic?.caseSensitiveInSearch,
                "playMusic.defaultQuality": oldConfig.playMusic?.defaultQuality,
                "playMusic.whenQualityMissing": oldConfig.playMusic?.whenQualityMissing,
                "playMusic.clickMusicList": oldConfig.playMusic?.clickMusicList,
                "playMusic.playError": oldConfig.playMusic?.playError,
                "playMusic.audioOutputDevice": oldConfig.playMusic?.audioOutputDevice,
                "playMusic.whenDeviceRemoved": oldConfig.playMusic?.whenDeviceRemoved,

                "lyric.enableStatusBarLyric": oldConfig.lyric?.enableStatusBarLyric,
                "lyric.enableDesktopLyric": oldConfig.lyric?.enableDesktopLyric,
                "lyric.alwaysOnTop": oldConfig.lyric?.alwaysOnTop,
                "lyric.lockLyric": oldConfig.lyric?.lockLyric,
                "lyric.fontData": oldConfig.lyric?.fontData,
                "lyric.fontColor": oldConfig.lyric?.fontColor,
                "lyric.fontSize": oldConfig.lyric?.fontSize,
                "lyric.strokeColor": oldConfig.lyric?.strokeColor,

                "shortCut.enableLocal": oldConfig.shortCut?.enableLocal,
                "shortCut.enableGlobal": oldConfig.shortCut?.enableGlobal,
                "shortCut.shortcuts": {
                    ...oldConfig.shortCut?.shortcuts,
                    "toggle-main-window-visible": { local: null, global: null },
                },

                "download.path": oldConfig.download?.path,
                "download.defaultQuality": oldConfig.download?.defaultQuality,
                "download.whenQualityMissing": oldConfig.download?.whenQualityMissing,
                "download.concurrency": oldConfig.download?.concurrency,

                "plugin.autoUpdatePlugin": oldConfig.plugin?.autoUpdatePlugin,
                "plugin.notCheckPluginVersion": oldConfig.plugin?.notCheckPluginVersion,

                "network.proxy.enabled": oldConfig.network?.proxy?.enabled,
                "network.proxy.host": oldConfig.network?.proxy?.host,
                "network.proxy.port": oldConfig.network?.proxy?.port,
                "network.proxy.username": oldConfig.network?.proxy?.username,
                "network.proxy.password": oldConfig.network?.proxy?.password,

                "backup.resumeBehavior": oldConfig.backup?.resumeBehavior,
                "backup.webdav.url": oldConfig.backup?.webdav?.url,
                "backup.webdav.username": oldConfig.backup?.webdav?.username,
                "backup.webdav.password": oldConfig.backup?.webdav?.password,

                "localMusic.watchDir": oldConfig.localMusic?.watchDir,

                "private.lyricWindowPosition": oldConfig.private?.lyricWindowPosition,
                "private.minimodeWindowPosition": oldConfig.private?.minimodeWindowPosition,
                "private.pluginMeta": oldConfig.private?.pluginMeta,
                "private.minimode": oldConfig.private?.minimode,
            };
            this.config = newConfig;
            for (const k in _defaultAppConfig) {
                if (newConfig[k] === null || newConfig[k] === undefined) {
                    // @ts-ignore
                    newConfig[k] = _defaultAppConfig[k];
                }
            }
            const rawConfig = JSON.stringify(newConfig, undefined, 4);
            // ⭐ 改成异步写
            await fs.writeFile(this.configPath, rawConfig, "utf-8");
        } catch (e) {
            logger.logError("迁移旧版配置失败", e as Error);
        }
    }

    async loadConfig() {
        try {
            if (this.config) {
                return { ..._defaultAppConfig, ...this.config };
            } else {
                const rawConfig = await fs.readFile(this.configPath, "utf8");
                this.config = JSON.parse(rawConfig);
                await this.migrateOldVersionConfig();
                this.config = {
                    ..._defaultAppConfig,
                    ...this.config,
                };
            }
        } catch (e: any) {
            if (e.message === "Unexpected end of JSON input" || e.code === "EISDIR") {
                await rimraf(this.configPath);
                await this.checkPath();
            } else if (e.code === "ENOENT") {
                await this.checkPath();
            }
            this.config = { ..._defaultAppConfig };
        }
        return this.config;
    }

    public getAllConfig() {
        return this.config;
    }

    public reset() {
        this.config = {};
        this.setConfig({});
    }

    public getConfig<T extends keyof IAppConfig>(key: T): IAppConfig[T] {
        return this.config[key];
    }

    public setConfig(data: IAppConfig) {
        // ⭐ 不 await，立刻返回
        this._setConfig(data, "main").catch(e => logger.logError("设置配置失败", e));
    }

    private async _setConfig(data: IAppConfig, from: "main" | "renderer") {
        try {
            this.config = { ..._defaultAppConfig, ...this.config, ...data };
            const rawConfig = JSON.stringify(this.config, undefined, 4);
            // ⭐ 改成异步写
            await fs.writeFile(this.configPath, rawConfig, "utf-8");
            this.windowManager.getAllWindows().forEach((window) => {
                window.webContents.send("@shared/app-config/update-app-config", data);
            });
            this.onAppConfigUpdatedCallbacks.forEach((callback) => {
                callback(data, this.config, from);
            });
        } catch (e) {
            logger.logError("设置配置失败", e as Error);
        }
    }

}

export default new AppConfig();
