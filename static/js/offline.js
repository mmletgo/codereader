/**
 * 离线管理模块 - 网络状态监听、操作队列管理、同步引擎
 * 依赖: CacheDB（IndexedDB 封装）、API（请求封装）
 * DOM 依赖: #offline-indicator
 */
const Offline = {
    /** @type {boolean} 当前网络状态 */
    isOnline: navigator.onLine,

    /** @type {boolean} 是否正在同步 */
    _syncing: false,

    // ========== 初始化 ==========

    /** 初始化网络状态监听 */
    async init() {
        window.addEventListener('online', () => this._handleOnline());
        window.addEventListener('offline', () => this._handleOffline());

        // 启动时根据当前状态更新UI
        if (!this.isOnline) {
            this.updateIndicator('offline');
        }

        // 启动时检查是否有pending操作，有则尝试同步
        try {
            const count = await this.getPendingCount();
            if (count > 0 && this.isOnline) {
                this.sync();
            }
        } catch (_) {
            // 初始化阶段静默忽略错误
        }
    },

    // ========== 网络状态处理 ==========

    /** 网络恢复处理 */
    _handleOnline() {
        this.isOnline = true;
        this.updateIndicator('hidden');
        this.sync();
    },

    /** 网络断开处理 */
    _handleOffline() {
        this.isOnline = false;
        this.updateIndicator('offline');
    },

    // ========== UI 更新 ==========

    /**
     * 更新离线指示器状态
     * @param {'hidden'|'offline'|'syncing'} state
     */
    updateIndicator(state) {
        const el = document.getElementById('offline-indicator');
        if (!el) return;

        switch (state) {
            case 'hidden':
                el.style.display = 'none';
                el.className = 'offline-indicator';
                break;
            case 'offline':
                el.style.display = 'flex';
                el.className = 'offline-indicator offline-indicator--offline';
                el.textContent = '离线模式';
                break;
            case 'syncing':
                el.style.display = 'flex';
                el.className = 'offline-indicator offline-indicator--syncing';
                el.textContent = '同步中...';
                break;
        }
    },

    /**
     * 显示底部 Toast 提示
     * @param {string} message - 提示文本
     * @param {'success'|'error'} type - 提示类型
     */
    showToast(message, type) {
        const toast = document.createElement('div');
        toast.className = `offline-toast offline-toast--${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        // 触发重排以启动CSS动画
        void toast.offsetWidth;
        toast.classList.add('offline-toast--visible');

        setTimeout(() => {
            toast.classList.remove('offline-toast--visible');
            toast.addEventListener('transitionend', () => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            });
            // 兜底移除，防止transitionend未触发
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 500);
        }, 2000);
    },

    // ========== 操作队列 ==========

    /**
     * 将离线写操作入队到 IndexedDB
     * @param {Object} op - 操作对象，须包含 path, method, body 等字段
     * @returns {Promise<number>} 操作ID
     */
    async queueOperation(op) {
        op.status = 'pending';
        op.timestamp = new Date().toISOString();
        return await CacheDB.enqueueOp(op);
    },

    /**
     * 操作合并（纯函数）—— 合并冗余的 pending 操作
     * @param {Array<Object>} ops - pending 操作列表
     * @returns {Array<Object>} 合并后的操作列表
     */
    _mergeOps(ops) {
        /** @type {Set<number>} 需要移除的操作ID */
        const removeIds = new Set();

        // 规则1: 多次 mark_read 同一函数（同path）→ 保留一次
        /** @type {Map<string, Array<Object>>} path → ops */
        const markReadByPath = new Map();
        for (const op of ops) {
            if (op.type === 'mark_read') {
                const key = op.path;
                if (!markReadByPath.has(key)) {
                    markReadByPath.set(key, []);
                }
                markReadByPath.get(key).push(op);
            }
        }
        for (const [, group] of markReadByPath) {
            if (group.length > 1) {
                // 保留最后一个，其余标记移除
                for (let i = 0; i < group.length - 1; i++) {
                    removeIds.add(group[i].id);
                }
            }
        }

        // 规则2: 多次 save_progress 同一项目 → 保留最后一次
        /** @type {Map<number, Array<Object>>} projectId → ops */
        const progressByProject = new Map();
        for (const op of ops) {
            if (op.type === 'save_progress') {
                const key = op.projectId;
                if (!progressByProject.has(key)) {
                    progressByProject.set(key, []);
                }
                progressByProject.get(key).push(op);
            }
        }
        for (const [, group] of progressByProject) {
            if (group.length > 1) {
                for (let i = 0; i < group.length - 1; i++) {
                    removeIds.add(group[i].id);
                }
            }
        }

        // 规则3 & 4: add_note / delete_note / update_note 同一 localId 的合并
        /** @type {Map<string, Object>} localId → add_note op */
        const addNoteByLocalId = new Map();
        /** @type {Map<string, Object>} localId → delete_note op */
        const deleteNoteByLocalId = new Map();
        /** @type {Map<string, Array<Object>>} localId → update_note ops */
        const updateNoteByLocalId = new Map();

        for (const op of ops) {
            if (op.type === 'add_note' && op.localId) {
                addNoteByLocalId.set(op.localId, op);
            } else if (op.type === 'delete_note' && op.localId) {
                deleteNoteByLocalId.set(op.localId, op);
            } else if (op.type === 'update_note' && op.localId) {
                if (!updateNoteByLocalId.has(op.localId)) {
                    updateNoteByLocalId.set(op.localId, []);
                }
                updateNoteByLocalId.get(op.localId).push(op);
            }
        }

        // 规则3: add_note + delete_note 同一localId → 互相抵消
        for (const [localId, addOp] of addNoteByLocalId) {
            if (deleteNoteByLocalId.has(localId)) {
                removeIds.add(addOp.id);
                removeIds.add(deleteNoteByLocalId.get(localId).id);
                // 同时移除该localId的所有update_note
                const updates = updateNoteByLocalId.get(localId);
                if (updates) {
                    for (const u of updates) {
                        removeIds.add(u.id);
                    }
                }
            }
        }

        // 规则4: add_note + update_note 同一localId（且add未被抵消）→ 合并为一个add_note
        for (const [localId, addOp] of addNoteByLocalId) {
            if (removeIds.has(addOp.id)) continue;
            const updates = updateNoteByLocalId.get(localId);
            if (updates && updates.length > 0) {
                // 用最后一次 update 的内容覆盖 add_note
                const lastUpdate = updates[updates.length - 1];
                if (lastUpdate.body) {
                    const updateBody = typeof lastUpdate.body === 'string'
                        ? JSON.parse(lastUpdate.body)
                        : lastUpdate.body;
                    const addBody = typeof addOp.body === 'string'
                        ? JSON.parse(addOp.body)
                        : addOp.body;
                    // 合并字段
                    if (updateBody.content !== undefined) addBody.content = updateBody.content;
                    if (updateBody.note_type !== undefined) addBody.note_type = updateBody.note_type;
                    addOp.body = JSON.stringify(addBody);
                }
                // 移除所有 update_note 操作
                for (const u of updates) {
                    removeIds.add(u.id);
                }
            }
        }

        // 规则5: 多次 update_path_progress 同一路径 → 保留最后一次
        /** @type {Map<string, Array<Object>>} path → ops */
        const pathProgressByPath = new Map();
        for (const op of ops) {
            if (op.type === 'update_path_progress') {
                const key = op.path;
                if (!pathProgressByPath.has(key)) {
                    pathProgressByPath.set(key, []);
                }
                pathProgressByPath.get(key).push(op);
            }
        }
        for (const [, group] of pathProgressByPath) {
            if (group.length > 1) {
                for (let i = 0; i < group.length - 1; i++) {
                    removeIds.add(group[i].id);
                }
            }
        }

        // 过滤掉被移除的操作
        return ops.filter(op => !removeIds.has(op.id));
    },

    // ========== 同步引擎 ==========

    /**
     * 同步流程 —— 网络恢复或应用启动时调用
     * 将 pending 的离线操作按时间顺序逐一回放到服务端
     */
    async sync() {
        if (this._syncing || !this.isOnline) return;

        this._syncing = true;
        this.updateIndicator('syncing');

        /** @type {boolean} 是否全部成功 */
        let allSuccess = true;
        /** @type {boolean} 是否有任何操作被处理 */
        let hasOps = false;

        try {
            // 获取所有pending操作
            const ops = await CacheDB.getAllPendingOps();
            if (!ops || ops.length === 0) {
                this._syncing = false;
                this.updateIndicator(this.isOnline ? 'hidden' : 'offline');
                return;
            }

            hasOps = true;

            // 合并冗余操作
            const merged = this._mergeOps(ops);

            // 从 IndexedDB 中删除被合并掉的操作
            const mergedIds = new Set(merged.map(op => op.id));
            for (const op of ops) {
                if (!mergedIds.has(op.id)) {
                    await CacheDB.removeOp(op.id);
                }
            }

            // 按时间顺序排序
            merged.sort((a, b) => {
                if (a.timestamp < b.timestamp) return -1;
                if (a.timestamp > b.timestamp) return 1;
                return (a.id || 0) - (b.id || 0);
            });

            // 逐一回放
            for (const op of merged) {
                try {
                    const url = API.BASE + op.path;
                    /** @type {RequestInit} */
                    const fetchOpts = {
                        method: op.method,
                        headers: { 'Content-Type': 'application/json' },
                    };
                    if (op.body) {
                        fetchOpts.body = typeof op.body === 'string'
                            ? op.body
                            : JSON.stringify(op.body);
                    }

                    const resp = await fetch(url, fetchOpts);

                    if (resp.ok) {
                        // 成功 → 从队列中删除
                        await CacheDB.removeOp(op.id);

                        // 如果是 add_note 且返回了真实ID，更新本地数据
                        if (op.type === 'add_note' && op.localId && op.functionId) {
                            try {
                                const serverNote = resp.status === 204
                                    ? null
                                    : await resp.json();
                                if (serverNote && serverNote.id) {
                                    await this._replaceLocalNote(
                                        op.functionId,
                                        op.localId,
                                        serverNote
                                    );
                                }
                            } catch (_) {
                                // 解析响应失败不阻塞同步
                            }
                        }
                    } else if (resp.status === 404) {
                        // 目标不存在，静默跳过，删除操作
                        await CacheDB.removeOp(op.id);
                    } else {
                        // 其他服务端错误，保留操作，标记失败
                        allSuccess = false;
                    }
                } catch (e) {
                    // 网络错误 → 保留操作，终止本轮同步
                    allSuccess = false;
                    break;
                }
            }
        } catch (e) {
            allSuccess = false;
        } finally {
            this._syncing = false;
        }

        // 更新UI
        if (hasOps) {
            if (allSuccess) {
                this.updateIndicator('hidden');
                this.showToast('同步完成', 'success');
            } else {
                this.updateIndicator(this.isOnline ? 'hidden' : 'offline');
                this.showToast('部分操作同步失败', 'error');
            }
        } else {
            this.updateIndicator(this.isOnline ? 'hidden' : 'offline');
        }
    },

    /**
     * 将 IndexedDB 中 functionDetails 里对应 localId 的备注替换为服务端返回的真实备注
     * @param {number} functionId - 函数ID
     * @param {string} localId - 本地临时ID
     * @param {Object} serverNote - 服务端返回的备注对象
     * @returns {Promise<void>}
     */
    async _replaceLocalNote(functionId, localId, serverNote) {
        const detail = await CacheDB.get('functionDetails', functionId);
        if (!detail || !detail.notes) return;

        const idx = detail.notes.findIndex(n => String(n.id) === localId);
        if (idx !== -1) {
            detail.notes[idx] = serverNote;
        } else {
            // localId没找到，可能已被处理，追加服务端备注
            detail.notes.push(serverNote);
        }
        await CacheDB.put('functionDetails', detail);
    },

    // ========== 辅助方法 ==========

    /**
     * 返回 pending 操作数量
     * @returns {Promise<number>}
     */
    async getPendingCount() {
        const ops = await CacheDB.getAllPendingOps();
        return ops ? ops.length : 0;
    },
};
