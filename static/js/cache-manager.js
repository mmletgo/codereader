/**
 * 缓存下载管理器 + 后台预加载
 * 负责将项目数据从服务端下载到 IndexedDB 缓存，
 * 以及进入浏览页后自动在后台缓存所有函数详情和AI解读。
 * 依赖: CacheDB, API, Browse, AI
 */
const CacheManager = {
    /** @type {Map<number, Promise<void>>} 正在下载中的项目 Promise */
    _downloadingMap: new Map(),

    /** @type {boolean} 后台预加载中止标记 */
    _bgAbort: false,
    /** @type {{detailsDone: number, detailsTotal: number, aiDone: number, aiTotal: number, phase: string}|null} */
    _bgProgress: null,

    /**
     * 下载某个项目的全部数据到 IndexedDB 缓存
     * @param {number} projectId - 项目ID
     * @param {function(number, number, string): void} [onProgress] - 进度回调
     *   (current, total, phase) phase: 'functions'|'details'|'extras'
     * @returns {Promise<void>}
     */
    async downloadProject(projectId, onProgress) {
        // 停止浏览页后台预加载，避免冲突
        this.stopBrowsePrefetch();

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

        // 批量下载模式：跳过API层的服务器可达性判断，避免单个请求失败导致级联失败
        API._bulkDownloading = true;

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

            // 4. 并发下载所有函数详情（并发控制=5，跳过已缓存项以支持断点续传）
            let detailCompleted = 0;
            const totalFuncs = funcs.length;
            const detailTasks = funcs.map(f => () =>
                CacheDB.get('functionDetails', f.id).then(existing => {
                    if (existing) {
                        detailCompleted++;
                        progress(detailCompleted, totalFuncs, 'details');
                        return;
                    }
                    return API.getFunctionDetail(f.id).then(async (detail) => {
                        detail.projectId = projectId;
                        await CacheDB.put('functionDetails', detail);
                        detailCompleted++;
                        progress(detailCompleted, totalFuncs, 'details');
                    });
                })
            );
            await this._runWithConcurrency(detailTasks, 5);

            // 5. 下载/生成每个函数的AI解读（并发控制=5，跳过已缓存项），忽略失败
            //    先查询后端缓存状态，区分"下载已有"和"生成新的"两个阶段
            let extrasCompleted = 0;
            /** @type {Set<number>} */
            let serverCachedIds = new Set();
            try {
                const status = await API.getAIExplanationStatus(projectId);
                serverCachedIds = new Set(status.cached_function_ids);
            } catch (e) {
                // 接口不可用，全部当作需要生成
            }
            const needFetch = [];
            const needGenerate = [];
            for (const f of funcs) {
                if (serverCachedIds.has(f.id)) {
                    needFetch.push(f);
                } else {
                    needGenerate.push(f);
                }
            }

            // 5a. 并发5下载后端已缓存的AI解读
            const fetchTotal = needFetch.length;
            let fetchDone = 0;
            progress(0, fetchTotal, 'ai-fetch');
            const fetchTasks = needFetch.map(f => () =>
                CacheDB.get('aiExplanations', f.id).then(existing => {
                    if (existing) {
                        fetchDone++;
                        progress(fetchDone, fetchTotal, 'ai-fetch');
                        return;
                    }
                    return API.getAIExplanation(f.id).then(async (data) => {
                        data.projectId = projectId;
                        data.functionId = f.id;
                        await CacheDB.put('aiExplanations', data);
                    }).catch(() => {}).finally(() => {
                        fetchDone++;
                        progress(fetchDone, fetchTotal, 'ai-fetch');
                    });
                })
            );
            await this._runWithConcurrency(fetchTasks, 5);

            // 5b. 并发1逐个生成后端未缓存的AI解读
            const genTotal = needGenerate.length;
            let genDone = 0;
            if (genTotal > 0) {
                progress(0, genTotal, 'ai-generate');
            }
            const genTasks = needGenerate.map(f => () =>
                CacheDB.get('aiExplanations', f.id).then(existing => {
                    if (existing) {
                        genDone++;
                        progress(genDone, genTotal, 'ai-generate');
                        return;
                    }
                    return API.getAIExplanation(f.id).then(async (data) => {
                        data.projectId = projectId;
                        data.functionId = f.id;
                        await CacheDB.put('aiExplanations', data);
                    }).catch(() => {}).finally(() => {
                        genDone++;
                        progress(genDone, genTotal, 'ai-generate');
                    });
                })
            );
            await this._runWithConcurrency(genTasks, 3);

            // 6-8. 并行下载调用关系图、阅读路径、阅读进度
            progress(0, 1, 'extras');
            await Promise.all([
                API.getCallGraph(projectId).then(async (graphData) => {
                    await CacheDB.put('callGraphs', { ...graphData, projectId });
                }).catch(() => {}),

                API.getReadingPaths(projectId).then(async (pathList) => {
                    const pathDetailTasks = pathList.map(p => () =>
                        API.getReadingPathDetail(p.id).then(async (detail) => {
                            detail.projectId = projectId;
                            await CacheDB.put('readingPaths', detail);
                        }).catch(() => {})
                    );
                    await this._runWithConcurrency(pathDetailTasks, 5);
                }).catch(() => {}),

                API.getProgress(projectId).then(async (progressData) => {
                    await CacheDB.put('progress', { ...progressData, projectId });
                }).catch(() => {}),
            ]);
            progress(1, 1, 'extras');

            // 9. AI对话记录（并发控制=5）
            let chatDone = 0;
            const chatTotal = funcs.length;
            progress(0, chatTotal, 'chat');
            const chatTasks = funcs.map(f => () =>
                API.getChatHistory(f.id).then(async (history) => {
                    await CacheDB.put('chatHistories', {
                        functionId: f.id,
                        projectId,
                        messages: history,
                    });
                }).catch(() => {}).finally(() => {
                    chatDone++;
                    progress(chatDone, chatTotal, 'chat');
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
        } finally {
            API._bulkDownloading = false;
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
     * 等待页面变为可见状态（移动端切回前台）
     * 页面已可见时立即返回
     * @returns {Promise<void>}
     */
    _waitForVisible() {
        if (!document.hidden) return Promise.resolve();
        return new Promise(resolve => {
            const handler = () => {
                if (!document.hidden) {
                    document.removeEventListener('visibilitychange', handler);
                    resolve();
                }
            };
            document.addEventListener('visibilitychange', handler);
        });
    },

    /**
     * 通用并发控制器（带重试和可见性感知）
     * @param {Array<function(): Promise>} tasks - 任务数组，每个元素是 () => Promise
     * @param {number} concurrency - 最大并发数
     * @param {number} [retries=2] - 每个任务最大重试次数
     * @returns {Promise<void>}
     */
    async _runWithConcurrency(tasks, concurrency, retries = 2) {
        let index = 0;
        const total = tasks.length;
        if (total === 0) return;

        const self = this;

        async function runNext() {
            while (index < total) {
                // 页面不可见时暂停发起新任务
                await self._waitForVisible();

                const currentIndex = index++;
                let lastErr;
                for (let attempt = 0; attempt <= retries; attempt++) {
                    try {
                        await tasks[currentIndex]();
                        lastErr = null;
                        break;
                    } catch (err) {
                        lastErr = err;
                        if (attempt < retries) {
                            // 等待后重试，同时等页面回到前台
                            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                            await self._waitForVisible();
                        }
                    }
                }
                if (lastErr) throw lastErr;
            }
        }

        const workers = [];
        for (let i = 0; i < Math.min(concurrency, total); i++) {
            workers.push(runNext());
        }
        await Promise.all(workers);
    },

    // ========== 后台预加载（浏览页自动触发） ==========

    /**
     * 启动浏览页后台预加载
     * @param {number} projectId
     * @param {Array<{id: number}>} functions - 函数列表
     */
    async startBrowsePrefetch(projectId, functions) {
        this.stopBrowsePrefetch();
        if (!functions || functions.length === 0) return;
        if (typeof Offline !== 'undefined' && !Offline.isServerAvailable) return;

        this._bgAbort = false;
        this._bgProgress = {
            detailsDone: 0,
            detailsTotal: functions.length,
            aiDone: 0,
            aiTotal: functions.length,
            phase: 'details',
        };

        // 检查 IndexedDB cacheMeta
        const meta = await CacheDB.getCacheMeta(projectId);

        if (meta && meta.status === 'complete') {
            // 已缓存：从 IndexedDB 加载到内存，然后检查缺少的AI解读
            this._showBrowseProgress();
            this._updateBrowseProgress();
            await this._loadMemoryFromDB(projectId, functions);
            if (!this._bgAbort) {
                await this._generateMissingAI(projectId, functions);
            }
            if (!this._bgAbort) {
                this._updateBrowseProgress();
                setTimeout(() => this._hideBrowseProgress(), 3000);
            }
            return;
        }

        if (this._downloadingMap.has(projectId)) {
            // 正在下载中，不干扰
            return;
        }

        // 未缓存：启动全量下载+生成
        // 注意：不放入 _downloadingMap，避免阻塞 downloadProject 的 onProgress 回调
        this._showBrowseProgress();
        this._updateBrowseProgress();

        try {
            await this._doBrowsePrefetch(projectId, functions);
        } catch (e) {
            console.warn('[CacheManager] 后台预加载出错:', e);
        }
    },

    /**
     * 停止浏览页后台预加载
     */
    stopBrowsePrefetch() {
        this._bgAbort = true;
        this._hideBrowseProgress();
    },

    /**
     * 全量后台预加载（函数详情 + AI解读 + 附加数据）
     * @param {number} projectId
     * @param {Array<{id: number}>} functions
     * @returns {Promise<void>}
     */
    async _doBrowsePrefetch(projectId, functions) {
        // 批量下载模式：跳过API层的服务器可达性判断
        API._bulkDownloading = true;

        // 设置 cacheMeta = downloading
        await CacheDB.setCacheMeta(projectId, {
            status: 'downloading',
            downloadedAt: null,
            serverScanTime: null,
            funcCount: 0,
        });

        try {
            // 获取项目信息并存入 IndexedDB
            const projects = await API.getProjects();
            const project = projects.find(p => p.id === projectId);
            if (project) {
                await CacheDB.put('projects', project);
            }

            // 函数列表存入 IndexedDB
            const funcsWithProject = functions.map(f => ({ ...f, projectId }));
            await CacheDB.putMany('functions', funcsWithProject);

            // Phase 1: 函数详情（并发=3）
            this._bgProgress.phase = 'details';
            const uncachedDetails = functions.filter(f => !Browse.cache.has(f.id));
            this._bgProgress.detailsDone = functions.length - uncachedDetails.length;
            this._updateBrowseProgress();

            const detailTasks = uncachedDetails.map(f => async () => {
                if (this._bgAbort) return;
                await this._waitForVisible();
                try {
                    let detail = Browse.cache.get(f.id);
                    if (!detail) {
                        detail = await API.getFunctionDetail(f.id);
                        Browse.cache.set(f.id, detail);
                    }
                    // 预渲染HTML
                    if (!Browse.htmlCache.has(f.id)) {
                        Browse.htmlCache.set(f.id, Browse._buildCodeHtml(detail));
                    }
                    // 写入 IndexedDB
                    detail.projectId = projectId;
                    await CacheDB.put('functionDetails', detail);
                } catch (e) {
                    // 忽略单个失败
                }
                this._bgProgress.detailsDone++;
                this._updateBrowseProgress();
            });

            await this._runWithConcurrency(detailTasks, 3, 1);
            if (this._bgAbort) return;

            // Phase 2: AI解读
            this._bgProgress.phase = 'ai';

            // 查询后端已缓存的AI解读
            /** @type {Set<number>} */
            let cachedSet = new Set();
            try {
                const status = await API.getAIExplanationStatus(projectId);
                cachedSet = new Set(status.cached_function_ids);
            } catch (e) {
                // 接口不可用时跳过优化
            }

            // 分两组：后端已缓存但前端没有 / 后端未缓存
            const needFetchFromServer = [];
            const needGenerate = [];
            for (const f of functions) {
                if (AI.explanationCache.has(f.id)) {
                    // 前端内存已有，跳过
                    continue;
                }
                if (cachedSet.has(f.id)) {
                    needFetchFromServer.push(f);
                } else {
                    needGenerate.push(f);
                }
            }

            const alreadyCachedCount = functions.length - needFetchFromServer.length - needGenerate.length;
            this._bgProgress.aiDone = alreadyCachedCount;
            this._updateBrowseProgress();

            // 2a. 后端已缓存 → 并发5快速获取
            const fetchTasks = needFetchFromServer.map(f => async () => {
                if (this._bgAbort) return;
                await this._waitForVisible();
                try {
                    const data = await API.getAIExplanation(f.id);
                    AI.explanationCache.set(f.id, data.explanation);
                    data.projectId = projectId;
                    data.functionId = f.id;
                    await CacheDB.put('aiExplanations', data);
                } catch (e) {
                    // 忽略
                }
                this._bgProgress.aiDone++;
                this._updateBrowseProgress();
            });

            await this._runWithConcurrency(fetchTasks, 5, 1);
            if (this._bgAbort) return;

            // 2b. 后端未缓存 → 并发1逐个生成
            const genTasks = needGenerate.map(f => async () => {
                if (this._bgAbort) return;
                await this._waitForVisible();
                try {
                    const data = await API.getAIExplanation(f.id);
                    AI.explanationCache.set(f.id, data.explanation);
                    data.projectId = projectId;
                    data.functionId = f.id;
                    await CacheDB.put('aiExplanations', data);
                } catch (e) {
                    // 忽略
                }
                this._bgProgress.aiDone++;
                this._updateBrowseProgress();
            });

            await this._runWithConcurrency(genTasks, 1, 1);
            if (this._bgAbort) return;

            // Phase 3: 附加数据（调用关系图、阅读路径、阅读进度、AI对话记录）
            await Promise.all([
                API.getCallGraph(projectId).then(async (graphData) => {
                    await CacheDB.put('callGraphs', { ...graphData, projectId });
                }).catch(() => {}),

                API.getReadingPaths(projectId).then(async (pathList) => {
                    const pathDetailTasks = pathList.map(p => () =>
                        API.getReadingPathDetail(p.id).then(async (detail) => {
                            detail.projectId = projectId;
                            await CacheDB.put('readingPaths', detail);
                        }).catch(() => {})
                    );
                    await this._runWithConcurrency(pathDetailTasks, 5);
                }).catch(() => {}),

                API.getProgress(projectId).then(async (progressData) => {
                    await CacheDB.put('progress', { ...progressData, projectId });
                }).catch(() => {}),

                (async () => {
                    const chatTasks = functions.map(f => () =>
                        API.getChatHistory(f.id).then(async (history) => {
                            await CacheDB.put('chatHistories', {
                                functionId: f.id,
                                projectId,
                                messages: history,
                            });
                        }).catch(() => {})
                    );
                    await this._runWithConcurrency(chatTasks, 5);
                })(),
            ]);

            // 设置 cacheMeta = complete
            await CacheDB.setCacheMeta(projectId, {
                status: 'complete',
                downloadedAt: new Date().toISOString(),
                serverScanTime: (project && project.scan_time) || null,
                funcCount: functions.length,
            });
        } catch (err) {
            await CacheDB.setCacheMeta(projectId, {
                status: 'error',
                downloadedAt: null,
                serverScanTime: null,
                funcCount: 0,
                error: err.message,
            });
            throw err;
        } finally {
            API._bulkDownloading = false;
            if (!this._bgAbort) {
                this._updateBrowseProgress();
                setTimeout(() => this._hideBrowseProgress(), 3000);
            }
        }
    },

    /**
     * 从 IndexedDB 加载函数详情和AI解读到内存缓存
     * @param {number} projectId
     * @param {Array<{id: number}>} functions
     * @returns {Promise<void>}
     */
    async _loadMemoryFromDB(projectId, functions) {
        this._bgProgress.phase = 'loading';
        this._bgProgress.detailsDone = 0;
        this._bgProgress.detailsTotal = functions.length;
        this._bgProgress.aiDone = 0;
        this._bgProgress.aiTotal = functions.length;
        this._updateBrowseProgress();

        // 加载函数详情到 Browse.cache + Browse.htmlCache
        let detailCount = 0;
        for (const f of functions) {
            if (this._bgAbort) return;
            if (!Browse.cache.has(f.id)) {
                try {
                    const detail = await CacheDB.get('functionDetails', f.id);
                    if (detail) {
                        Browse.cache.set(f.id, detail);
                        if (!Browse.htmlCache.has(f.id)) {
                            Browse.htmlCache.set(f.id, Browse._buildCodeHtml(detail));
                        }
                    }
                } catch (e) {
                    // 忽略单个失败
                }
            }
            detailCount++;
            if (detailCount % 10 === 0) {
                this._bgProgress.detailsDone = detailCount;
                this._updateBrowseProgress();
            }
        }
        this._bgProgress.detailsDone = functions.length;
        this._updateBrowseProgress();

        // 加载AI解读到 AI.explanationCache
        let aiCount = 0;
        for (const f of functions) {
            if (this._bgAbort) return;
            if (!AI.explanationCache.has(f.id)) {
                try {
                    const data = await CacheDB.get('aiExplanations', f.id);
                    if (data && data.explanation) {
                        AI.explanationCache.set(f.id, data.explanation);
                    }
                } catch (e) {
                    // 忽略
                }
            }
            aiCount++;
            if (aiCount % 10 === 0) {
                this._bgProgress.aiDone = aiCount;
                this._updateBrowseProgress();
            }
        }
        this._bgProgress.aiDone = functions.length;
        this._updateBrowseProgress();
    },

    /**
     * 检查并生成缺少的AI解读
     * @param {number} projectId
     * @param {Array<{id: number}>} functions
     * @returns {Promise<void>}
     */
    async _generateMissingAI(projectId, functions) {
        if (typeof Offline !== 'undefined' && !Offline.isServerAvailable) return;

        /** @type {Set<number>} */
        let cachedSet = new Set();
        try {
            const status = await API.getAIExplanationStatus(projectId);
            cachedSet = new Set(status.cached_function_ids);
        } catch (e) {
            return; // 接口不可用则跳过
        }

        // 找出缺少AI解读的函数（前端内存没有，后端也没有）
        const missing = functions.filter(f =>
            !AI.explanationCache.has(f.id) && !cachedSet.has(f.id)
        );
        if (missing.length === 0) return;

        this._bgProgress.phase = 'ai';
        this._bgProgress.aiDone = functions.length - missing.length;
        this._bgProgress.aiTotal = functions.length;
        this._showBrowseProgress();
        this._updateBrowseProgress();

        const tasks = missing.map(f => async () => {
            if (this._bgAbort) return;
            await this._waitForVisible();
            try {
                const data = await API.getAIExplanation(f.id);
                AI.explanationCache.set(f.id, data.explanation);
                data.projectId = projectId;
                data.functionId = f.id;
                await CacheDB.put('aiExplanations', data);
            } catch (e) {
                // 忽略
            }
            this._bgProgress.aiDone++;
            this._updateBrowseProgress();
        });

        await this._runWithConcurrency(tasks, 1, 1);
    },

    // ========== 进度条UI ==========

    /** 显示浏览页预加载进度条 */
    _showBrowseProgress() {
        const el = document.getElementById('prefetch-progress');
        if (el) el.style.display = '';
    },

    /** 隐藏浏览页预加载进度条 */
    _hideBrowseProgress() {
        const el = document.getElementById('prefetch-progress');
        if (el) el.style.display = 'none';
    },

    /** 更新浏览页预加载进度条 */
    _updateBrowseProgress() {
        const p = this._bgProgress;
        if (!p) return;
        const textEl = document.getElementById('prefetch-text');
        if (!textEl) return;

        const allDetailsDone = p.detailsDone >= p.detailsTotal;
        const allAiDone = p.aiDone >= p.aiTotal;

        if (allDetailsDone && allAiDone) {
            textEl.textContent = '预加载完成';
            const barEl = document.getElementById('prefetch-bar');
            if (barEl) barEl.style.width = '100%';
            return;
        }

        const parts = [];
        if (!allDetailsDone) parts.push(`缓存 ${p.detailsDone}/${p.detailsTotal}`);
        if (p.phase === 'ai' || allDetailsDone) parts.push(`AI解读 ${p.aiDone}/${p.aiTotal}`);
        textEl.textContent = parts.join(' | ');

        const barEl = document.getElementById('prefetch-bar');
        if (barEl) {
            const total = p.detailsTotal + p.aiTotal;
            const done = p.detailsDone + p.aiDone;
            barEl.style.width = (total > 0 ? Math.round(done / total * 100) : 0) + '%';
        }
    },
};
