/**
 * 缓存下载管理器
 * 负责将项目数据从服务端下载到 IndexedDB 缓存
 * 依赖: CacheDB, API
 */
const CacheManager = {
    /** @type {Map<number, Promise<void>>} 正在下载中的项目 Promise */
    _downloadingMap: new Map(),

    /**
     * 下载某个项目的全部数据到 IndexedDB 缓存
     * @param {number} projectId - 项目ID
     * @param {function(number, number, string): void} [onProgress] - 进度回调
     *   (current, total, phase) phase: 'functions'|'details'|'extras'
     * @returns {Promise<void>}
     */
    async downloadProject(projectId, onProgress) {
        // 可重入：如果已经在下载中，返回已有的 Promise
        if (this._downloadingMap.has(projectId)) {
            return this._downloadingMap.get(projectId);
        }

        const promise = this._doDownload(projectId, onProgress).finally(() => {
            this._downloadingMap.delete(projectId);
        });
        this._downloadingMap.set(projectId, promise);
        return promise;
    },

    /**
     * 实际下载逻辑
     * @param {number} projectId
     * @param {function(number, number, string): void} [onProgress]
     * @returns {Promise<void>}
     */
    async _doDownload(projectId, onProgress) {
        const progress = onProgress || (() => {});

        // 1. 设置 cacheMeta 状态为 downloading
        await CacheDB.setCacheMeta(projectId, {
            status: 'downloading',
            downloadedAt: null,
            serverScanTime: null,
            funcCount: 0,
        });

        try {
            // 2. 获取项目信息
            const projects = await API.getProjects();
            const project = projects.find(p => p.id === projectId);
            if (!project) {
                throw new Error(`Project ${projectId} not found`);
            }
            await CacheDB.put('projects', project);

            // 3. 获取全部函数列表
            const funcs = await API.getAllFunctions(projectId);
            const funcsWithProject = funcs.map(f => ({ ...f, projectId }));
            await CacheDB.putMany('functions', funcsWithProject);
            progress(funcs.length, funcs.length, 'functions');

            // 4. 并发下载所有函数详情（并发控制=5）
            let detailCompleted = 0;
            const totalFuncs = funcs.length;
            const detailTasks = funcs.map(f => () =>
                API.getFunctionDetail(f.id).then(async (detail) => {
                    detail.projectId = projectId;
                    await CacheDB.put('functionDetails', detail);
                    detailCompleted++;
                    progress(detailCompleted, totalFuncs, 'details');
                })
            );
            await this._runWithConcurrency(detailTasks, 5);

            // 5. 并发下载每个函数的AI解读（并发控制=5），忽略失败
            let extrasCompleted = 0;
            const totalExtras = funcs.length;
            const aiTasks = funcs.map(f => () =>
                API.getAIExplanation(f.id).then(async (data) => {
                    data.projectId = projectId;
                    data.functionId = f.id;
                    await CacheDB.put('aiExplanations', data);
                }).catch(() => {
                    // 忽略失败（可能未生成过）
                }).finally(() => {
                    extrasCompleted++;
                    progress(extrasCompleted, totalExtras, 'extras');
                })
            );
            await this._runWithConcurrency(aiTasks, 5);

            // 6. 下载调用关系图
            try {
                const graphData = await API.getCallGraph(projectId);
                await CacheDB.put('callGraphs', { ...graphData, projectId });
            } catch (_) {
                // 忽略失败
            }

            // 7. 下载阅读路径列表及详情
            try {
                const pathList = await API.getReadingPaths(projectId);
                const pathDetails = [];
                for (const p of pathList) {
                    try {
                        const detail = await API.getReadingPathDetail(p.id);
                        detail.projectId = projectId;
                        pathDetails.push(detail);
                    } catch (_) {
                        // 忽略单条失败
                    }
                }
                if (pathDetails.length > 0) {
                    await CacheDB.putMany('readingPaths', pathDetails);
                }
            } catch (_) {
                // 忽略失败
            }

            // 8. 下载阅读进度
            try {
                const progressData = await API.getProgress(projectId);
                await CacheDB.put('progress', { ...progressData, projectId });
            } catch (_) {
                // 忽略失败
            }

            // 9. 下载AI对话记录：遍历所有函数，逐个获取对话历史，忽略失败
            const chatTasks = funcs.map(f => () =>
                API.getChatHistory(f.id).then(async (history) => {
                    await CacheDB.put('chatHistories', {
                        functionId: f.id,
                        projectId,
                        messages: history,
                    });
                }).catch(() => {
                    // 忽略失败
                })
            );
            await this._runWithConcurrency(chatTasks, 5);

            // 10. 更新 cacheMeta：完成状态
            await CacheDB.setCacheMeta(projectId, {
                status: 'complete',
                downloadedAt: new Date().toISOString(),
                serverScanTime: project.scan_time || null,
                funcCount: funcs.length,
            });
        } catch (err) {
            // 下载出错，更新 cacheMeta 状态为 error
            await CacheDB.setCacheMeta(projectId, {
                status: 'error',
                downloadedAt: null,
                serverScanTime: null,
                funcCount: 0,
                error: err.message,
            });
            throw err;
        }
    },

    /**
     * 删除某项目的所有缓存数据
     * @param {number} projectId
     * @returns {Promise<void>}
     */
    async deleteProjectCache(projectId) {
        await CacheDB.deleteProjectCache(projectId);
        await CacheDB.deleteCacheMeta(projectId);
    },

    /**
     * 获取项目缓存状态
     * @param {number} projectId
     * @param {string} [serverScanTime] - 服务端的扫描时间，用于比较是否需要更新
     * @returns {Promise<{cached: boolean, downloading: boolean, meta: Object|null, needsUpdate: boolean}>}
     */
    async getCacheStatus(projectId, serverScanTime) {
        const meta = await CacheDB.getCacheMeta(projectId);
        if (!meta) {
            return {
                cached: false,
                downloading: this._downloadingMap.has(projectId),
                meta: null,
                needsUpdate: false,
            };
        }

        const cached = meta.status === 'complete';
        const downloading = meta.status === 'downloading' || this._downloadingMap.has(projectId);
        let needsUpdate = false;
        if (cached && serverScanTime) {
            needsUpdate = meta.serverScanTime !== serverScanTime;
        }

        return { cached, downloading, meta, needsUpdate };
    },

    /**
     * 获取缓存摘要信息
     * @param {number} projectId
     * @returns {Promise<{funcCount: number, downloadedAt: string, lastSyncAt: string}|null>}
     */
    async getCacheInfo(projectId) {
        const meta = await CacheDB.getCacheMeta(projectId);
        if (!meta || meta.status !== 'complete') {
            return null;
        }
        return {
            funcCount: meta.funcCount || 0,
            downloadedAt: meta.downloadedAt || '',
            lastSyncAt: meta.downloadedAt || '',
        };
    },

    /**
     * 通用并发控制器
     * @param {Array<function(): Promise>} tasks - 任务数组，每个元素是 () => Promise
     * @param {number} concurrency - 最大并发数
     * @returns {Promise<void>}
     */
    async _runWithConcurrency(tasks, concurrency) {
        let index = 0;
        const total = tasks.length;
        if (total === 0) return;

        const results = [];

        async function runNext() {
            while (index < total) {
                const currentIndex = index++;
                await tasks[currentIndex]();
            }
        }

        const workers = [];
        for (let i = 0; i < Math.min(concurrency, total); i++) {
            workers.push(runNext());
        }
        await Promise.all(workers);
    },
};
