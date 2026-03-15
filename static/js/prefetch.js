/**
 * 后台预加载模块
 * 进入浏览页后自动在后台缓存所有函数详情和AI解读
 */
const Prefetch = {
    _running: false,
    _projectId: null,
    _abort: false,
    _detailsDone: 0,
    _detailsTotal: 0,
    _aiDone: 0,
    _aiTotal: 0,
    _aiRunning: false,

    /**
     * 启动后台预加载
     * @param {number} projectId
     * @param {Array} functions - 函数列表 [{id, ...}]
     */
    async start(projectId, functions) {
        this.stop(); // 停止之前的预加载
        if (!functions || functions.length === 0) return;
        if (typeof Offline !== 'undefined' && !Offline.isServerAvailable) return;

        this._running = true;
        this._projectId = projectId;
        this._abort = false;
        this._detailsDone = 0;
        this._detailsTotal = functions.length;
        this._aiDone = 0;
        this._aiTotal = functions.length;
        this._aiRunning = false;

        this._showUI();
        this._updateUI();

        try {
            // Phase 1: 预加载所有函数详情（并发=3）
            await this._prefetchDetails(functions);
            if (this._abort) return;

            // Phase 2: 预加载所有AI解读（并发=1）
            this._aiRunning = true;
            await this._prefetchAI(functions);
        } catch (e) {
            console.warn('[Prefetch] 预加载出错:', e);
        } finally {
            this._running = false;
            this._aiRunning = false;
            if (!this._abort) {
                this._updateUI();
                // 全部完成后3秒隐藏进度条
                setTimeout(() => this._hideUI(), 3000);
            }
        }
    },

    /** 停止预加载 */
    stop() {
        this._abort = true;
        this._running = false;
        this._aiRunning = false;
        this._hideUI();
    },

    /** Phase 1: 预加载函数详情 */
    async _prefetchDetails(functions) {
        const uncached = functions.filter(f => !Browse.cache.has(f.id));
        this._detailsDone = functions.length - uncached.length;
        this._updateUI();

        const tasks = uncached.map(f => async () => {
            if (this._abort) return;
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
            } catch (e) {
                // 忽略单个失败
            }
            this._detailsDone++;
            this._updateUI();
        });

        await this._runWithConcurrency(tasks, 3);
    },

    /** Phase 2: 预加载AI解读 */
    async _prefetchAI(functions) {
        // 先查询哪些已有缓存
        let cachedSet = new Set();
        try {
            const status = await API.getAIExplanationStatus(this._projectId);
            cachedSet = new Set(status.cached_function_ids);
        } catch (e) {
            // 接口不可用时跳过优化，逐个尝试
        }

        // 排除前端已缓存和后端已缓存的
        const uncached = functions.filter(f =>
            !AI.explanationCache.has(f.id) && !cachedSet.has(f.id)
        );
        this._aiDone = functions.length - uncached.length;
        this._updateUI();

        // AI解读用并发=1，避免API压力过大
        const tasks = uncached.map(f => async () => {
            if (this._abort) return;
            await this._waitForVisible();
            try {
                await AI.getExplanation(f.id);
            } catch (e) {
                // 忽略失败（如API限流等）
            }
            this._aiDone++;
            this._updateUI();
        });

        await this._runWithConcurrency(tasks, 1);
    },

    /** 等待页面可见（移动端切后台时暂停） */
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

    /** 并发控制器 */
    async _runWithConcurrency(tasks, concurrency) {
        let index = 0;
        const total = tasks.length;
        if (total === 0) return;
        const self = this;

        async function runNext() {
            while (index < total) {
                if (self._abort) return;
                const currentIndex = index++;
                try {
                    await tasks[currentIndex]();
                } catch (e) {
                    // 继续下一个
                }
            }
        }

        const workers = [];
        for (let i = 0; i < Math.min(concurrency, total); i++) {
            workers.push(runNext());
        }
        await Promise.all(workers);
    },

    /** 显示进度指示器 */
    _showUI() {
        const el = document.getElementById('prefetch-progress');
        if (el) el.style.display = '';
    },

    /** 隐藏进度指示器 */
    _hideUI() {
        const el = document.getElementById('prefetch-progress');
        if (el) el.style.display = 'none';
    },

    /** 更新进度指示器 */
    _updateUI() {
        const textEl = document.getElementById('prefetch-text');
        if (!textEl) return;

        const allDetailsDone = this._detailsDone >= this._detailsTotal;
        const allAiDone = this._aiDone >= this._aiTotal;

        if (allDetailsDone && allAiDone) {
            textEl.textContent = '预加载完成';
            return;
        }

        const parts = [];
        if (!allDetailsDone) {
            parts.push(`缓存 ${this._detailsDone}/${this._detailsTotal}`);
        }
        if (this._aiRunning || allDetailsDone) {
            parts.push(`AI解读 ${this._aiDone}/${this._aiTotal}`);
        }
        textEl.textContent = parts.join(' | ');

        // 更新进度条
        const barEl = document.getElementById('prefetch-bar');
        if (barEl) {
            const totalWork = this._detailsTotal + this._aiTotal;
            const doneWork = this._detailsDone + this._aiDone;
            const pct = totalWork > 0 ? Math.round(doneWork / totalWork * 100) : 0;
            barEl.style.width = pct + '%';
        }
    },
};
