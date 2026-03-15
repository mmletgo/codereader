/**
 * API 请求封装模块
 * 所有后端API调用统一通过此模块
 * 支持离线感知：在线时缓存数据到IndexedDB，离线时从缓存读取
 */
const API = {
    BASE: '/api/v1',

    /** @type {boolean} 服务器是否可达（区别于设备网络连接状态） */
    _serverReachable: true,
    /** @type {number} 上次检测到服务器不可达的时间戳 */
    _lastServerFailTime: 0,
    /** @type {number} 服务器不可达时的重试间隔（毫秒） */
    _SERVER_RETRY_INTERVAL: 30000,
    /** @type {number} 网络请求超时时间（毫秒） */
    _FETCH_TIMEOUT: 8000,

    // ========== 核心请求方法 ==========

    /**
     * 判断是否应该尝试访问服务器
     * 设备在线 + (服务器可达 或 距上次失败已超过重试间隔)
     * @returns {boolean}
     */
    _shouldTryServer() {
        const online = typeof Offline === 'undefined' || Offline.isOnline;
        if (!online) return false;
        if (this._serverReachable) return true;
        return Date.now() - this._lastServerFailTime > this._SERVER_RETRY_INTERVAL;
    },

    /**
     * 标记服务器不可达
     */
    _markServerUnreachable() {
        if (this._serverReachable) {
            this._serverReachable = false;
            console.warn('[API] 服务器不可达，后续请求将优先使用缓存');
            if (typeof Offline !== 'undefined') {
                Offline.updateIndicator('offline');
            }
        }
        this._lastServerFailTime = Date.now();
    },

    /**
     * 标记服务器恢复可达
     */
    _markServerReachable() {
        if (!this._serverReachable) {
            this._serverReachable = true;
            console.info('[API] 服务器已恢复连接');
            if (typeof Offline !== 'undefined') {
                Offline.updateIndicator('hidden');
            }
        }
    },

    /**
     * 纯网络请求（不做离线处理），带超时控制
     * @param {string} path - API路径（不含BASE前缀）
     * @param {object} options - fetch选项
     * @returns {Promise<any>}
     */
    async _fetch(path, options = {}) {
        const url = this.BASE + path;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this._FETCH_TIMEOUT);
        const config = {
            headers: { 'Content-Type': 'application/json' },
            ...options,
            signal: controller.signal,
        };
        try {
            const resp = await fetch(url, config);
            clearTimeout(timeoutId);
            if (!resp.ok) {
                let detail = '';
                try {
                    const err = await resp.json();
                    detail = err.detail || JSON.stringify(err);
                } catch (_) {
                    detail = resp.statusText;
                }
                throw new Error(detail || `HTTP ${resp.status}`);
            }
            if (resp.status === 204) return null;
            const text = await resp.text();
            return text ? JSON.parse(text) : null;
        } catch (e) {
            clearTimeout(timeoutId);
            if (e.name === 'AbortError') {
                throw new Error('请求超时');
            }
            throw e;
        }
    },

    /**
     * 快速检测服务器可达性（启动时调用，fire-and-forget）
     * 使用短超时，不阻塞应用启动
     */
    async _checkServerReachability() {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            const resp = await fetch(this.BASE + '/projects/', {
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (resp.ok) {
                this._markServerReachable();
            } else {
                this._markServerUnreachable();
            }
        } catch (_) {
            this._markServerUnreachable();
        }
    },

    /**
     * 通用请求方法（带离线感知 + 服务器可达性检测）
     * @param {string} path - API路径（不含BASE前缀）
     * @param {object} options - fetch选项
     * @returns {Promise<any>}
     */
    async request(path, options = {}) {
        const method = (options.method || 'GET').toUpperCase();
        const online = typeof Offline === 'undefined' || Offline.isOnline;

        if (method === 'GET') {
            if (this._shouldTryServer()) {
                // 尝试网络请求
                try {
                    const data = await this._fetch(path, options);
                    this._markServerReachable();
                    // 异步更新缓存（fire-and-forget）
                    this._updateCache(path, data);
                    return data;
                } catch (e) {
                    this._markServerUnreachable();
                    // 网络错误时尝试从缓存读取
                    const cached = await this._readCache(path);
                    if (cached !== null && cached !== undefined) {
                        return cached;
                    }
                    throw e;
                }
            } else {
                // 离线或服务器不可达：从缓存读取
                const cached = await this._readCache(path);
                if (cached !== null && cached !== undefined) {
                    return cached;
                }
                throw new Error(online ? '服务器不可达，无缓存数据' : '离线模式，无缓存数据');
            }
        } else {
            // 写操作 (POST/PUT/DELETE)
            if (this._shouldTryServer()) {
                try {
                    const data = await this._fetch(path, options);
                    this._markServerReachable();
                    // 异步更新缓存（fire-and-forget）
                    this._updateCacheAfterWrite(path, method, options.body, data);
                    return data;
                } catch (e) {
                    this._markServerUnreachable();
                    // 写操作失败时，如果有离线处理能力则走离线流程
                    if (typeof Offline !== 'undefined') {
                        return this._handleOfflineWrite(path, method, options);
                    }
                    throw e;
                }
            } else {
                return this._handleOfflineWrite(path, method, options);
            }
        }
    },

    // ========== 缓存路由解析 ==========

    /**
     * 解析API路径，返回IndexedDB store信息
     * @param {string} path - API路径（可含查询参数）
     * @returns {{store: string, type: string, key?: *, indexName?: string, indexValue?: *}|null}
     */
    _pathToStore(path) {
        /** @type {RegExpMatchArray|null} */
        let m;

        // GET /functions/?project_id=X → functions列表
        m = path.match(/^\/functions\/\?project_id=(\d+)/);
        if (m) {
            return { store: 'functions', type: 'list', indexName: 'projectId', indexValue: parseInt(m[1]) };
        }

        // GET /functions/{id} → 函数详情
        m = path.match(/^\/functions\/(\d+)$/);
        if (m) {
            return { store: 'functionDetails', type: 'single', key: parseInt(m[1]) };
        }

        // GET /ai/explanation?function_id=X → AI解读
        m = path.match(/^\/ai\/explanation\?function_id=(\d+)/);
        if (m) {
            return { store: 'aiExplanations', type: 'single', key: parseInt(m[1]) };
        }

        // GET /call_graph/?project_id=X → 调用关系图
        m = path.match(/^\/call_graph\/\?project_id=(\d+)/);
        if (m) {
            return { store: 'callGraphs', type: 'single', key: parseInt(m[1]) };
        }

        // GET /reading-paths/?project_id=X → 阅读路径列表
        m = path.match(/^\/reading-paths\/\?project_id=(\d+)/);
        if (m) {
            return { store: 'readingPaths', type: 'list', indexName: 'projectId', indexValue: parseInt(m[1]) };
        }

        // GET /reading-paths/{id} → 阅读路径详情
        m = path.match(/^\/reading-paths\/(\d+)$/);
        if (m) {
            return { store: 'readingPaths', type: 'single', key: parseInt(m[1]) };
        }

        // GET /progress/?project_id=X → 阅读进度
        m = path.match(/^\/progress\/\?project_id=(\d+)/);
        if (m) {
            return { store: 'progress', type: 'single', key: parseInt(m[1]) };
        }

        // GET /ai/chat?function_id=X → 对话历史
        m = path.match(/^\/ai\/chat\?function_id=(\d+)/);
        if (m) {
            return { store: 'chatHistories', type: 'single', key: parseInt(m[1]) };
        }

        // GET /projects/ → 项目列表
        if (/^\/projects\/$/.test(path)) {
            return { store: 'projects', type: 'all' };
        }

        // 未匹配
        return null;
    },

    // ========== 缓存读写 ==========

    /**
     * 从IndexedDB读取缓存数据
     * @param {string} path - API路径
     * @returns {Promise<*>}
     */
    async _readCache(path) {
        if (typeof CacheDB === 'undefined' || !CacheDB._db) return null;

        const route = this._pathToStore(path);
        if (!route) return null;

        try {
            if (route.type === 'single') {
                return await CacheDB.get(route.store, route.key);
            } else if (route.type === 'list') {
                const items = await CacheDB.getAllByIndex(route.store, route.indexName, route.indexValue);
                // GET /functions/ 返回 {items, total} 格式
                if (route.store === 'functions') {
                    return { items: items || [], total: (items || []).length };
                }
                return items;
            } else if (route.type === 'all') {
                return await CacheDB.getAll(route.store);
            }
        } catch (e) {
            console.warn('Cache read failed:', e);
        }
        return null;
    },

    /**
     * GET请求成功后异步更新IndexedDB缓存
     * @param {string} path - API路径
     * @param {*} data - 响应数据
     * @returns {Promise<void>}
     */
    async _updateCache(path, data) {
        if (typeof CacheDB === 'undefined' || !CacheDB._db) return;

        try {
            const route = this._pathToStore(path);
            if (!route || !data) return;

            if (route.type === 'single') {
                // 对 functionDetails，需要附加 projectId
                if (route.store === 'functionDetails' && typeof Browse !== 'undefined' && Browse.projectId) {
                    data.projectId = Browse.projectId;
                }
                await CacheDB.put(route.store, data);
            } else if (route.type === 'list') {
                // 列表数据，批量存储
                const items = Array.isArray(data) ? data : (data.items || []);
                if (items.length > 0 && route.indexValue) {
                    items.forEach(item => { item.projectId = route.indexValue; });
                }
                await CacheDB.putMany(route.store, items);
            } else if (route.type === 'all') {
                if (Array.isArray(data)) {
                    await CacheDB.putMany(route.store, data);
                }
            }
        } catch (e) {
            console.warn('Cache update failed:', e);
        }
    },

    /**
     * 写操作成功后异步更新缓存（预留扩展点）
     * @param {string} path - API路径
     * @param {string} method - HTTP方法
     * @param {string|undefined} body - 请求体
     * @param {*} data - 响应数据
     * @returns {Promise<void>}
     */
    async _updateCacheAfterWrite(path, method, body, data) {
        // 写操作后的缓存更新逻辑
        // 目前大部分写操作的缓存更新由前端页面刷新时自然完成
        // 此方法作为扩展点，后续可按需添加特定写操作的缓存更新
    },

    // ========== 离线写操作处理 ==========

    /**
     * 离线时处理写操作：更新本地缓存并将操作入队
     * @param {string} path - API路径
     * @param {string} method - HTTP方法
     * @param {object} options - fetch选项
     * @returns {Promise<*>}
     */
    async _handleOfflineWrite(path, method, options) {
        const body = options.body ? JSON.parse(options.body) : null;

        // PUT /functions/{id}/read → mark_read
        const markReadMatch = path.match(/^\/functions\/(\d+)\/read$/);
        if (markReadMatch) {
            const funcId = parseInt(markReadMatch[1]);
            // 更新 IndexedDB 中的函数详情
            const detail = await CacheDB.get('functionDetails', funcId);
            if (detail) {
                detail.is_read = true;
                await CacheDB.put('functionDetails', detail);
            }
            // 更新 functions 列表中的状态
            const func = await CacheDB.get('functions', funcId);
            if (func) {
                func.is_read = true;
                await CacheDB.put('functions', func);
            }
            // 入队列
            await Offline.queueOperation({
                projectId: (detail && detail.projectId) || (typeof Browse !== 'undefined' ? Browse.projectId : null),
                type: 'mark_read',
                path: path,
                method: method,
                body: null,
                localId: null,
            });
            return null;
        }

        // POST /notes/ → add_note
        if (path === '/notes/' && method === 'POST') {
            const localId = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            const mockNote = {
                id: localId,
                function_id: body.function_id,
                project_id: body.project_id,
                content: body.content,
                note_type: body.note_type,
                source: 'user',
                created_at: new Date().toISOString(),
                _isLocal: true,
            };
            // 更新 functionDetails 中的 notes 数组
            const detail = await CacheDB.get('functionDetails', body.function_id);
            if (detail) {
                if (!detail.notes) detail.notes = [];
                detail.notes.push(mockNote);
                await CacheDB.put('functionDetails', detail);
            }
            // 入队列
            await Offline.queueOperation({
                projectId: body.project_id,
                type: 'add_note',
                path: path,
                method: method,
                body: body,
                localId: localId,
            });
            return mockNote;
        }

        // PUT /notes/{id} → update_note
        const noteUpdateMatch = path.match(/^\/notes\/(\d+)$/);
        if (noteUpdateMatch && method === 'PUT') {
            const noteId = parseInt(noteUpdateMatch[1]);
            await Offline.queueOperation({
                projectId: typeof Browse !== 'undefined' ? Browse.projectId : null,
                type: 'update_note',
                path: path,
                method: method,
                body: body,
                localId: null,
            });
            return { id: noteId, ...body };
        }

        // DELETE /notes/{id} → delete_note
        const noteDeleteMatch = path.match(/^\/notes\/(\d+|local_\w+)$/);
        if (noteDeleteMatch && method === 'DELETE') {
            const noteId = noteDeleteMatch[1];
            // 从 functionDetails 的 notes 数组中移除
            if (typeof Browse !== 'undefined' && Browse.currentDetail) {
                const detail = await CacheDB.get('functionDetails', Browse.currentDetail.id);
                if (detail && detail.notes) {
                    detail.notes = detail.notes.filter(n => String(n.id) !== String(noteId));
                    await CacheDB.put('functionDetails', detail);
                }
            }
            await Offline.queueOperation({
                projectId: typeof Browse !== 'undefined' ? Browse.projectId : null,
                type: 'delete_note',
                path: path,
                method: method,
                body: null,
                localId: noteId.startsWith?.('local_') ? noteId : null,
            });
            return null;
        }

        // PUT /progress/?project_id=X → save_progress
        const progressMatch = path.match(/^\/progress\/\?project_id=(\d+)$/);
        if (progressMatch && method === 'PUT') {
            const projectId = parseInt(progressMatch[1]);
            const progress = { projectId, ...body };
            await CacheDB.put('progress', progress);
            await Offline.queueOperation({
                projectId: projectId,
                type: 'save_progress',
                path: path,
                method: method,
                body: body,
                localId: null,
            });
            return null;
        }

        // PUT /reading-paths/{id}/progress → update_path_progress
        const pathProgressMatch = path.match(/^\/reading-paths\/(\d+)\/progress$/);
        if (pathProgressMatch && method === 'PUT') {
            const pathId = parseInt(pathProgressMatch[1]);
            const existing = await CacheDB.get('readingPaths', pathId);
            if (existing) {
                existing.last_index = body.last_index;
                await CacheDB.put('readingPaths', existing);
            }
            await Offline.queueOperation({
                projectId: typeof Browse !== 'undefined' ? Browse.projectId : null,
                type: 'update_path_progress',
                path: path,
                method: method,
                body: body,
                localId: null,
            });
            return null;
        }

        // 其他写操作在离线时不支持
        throw new Error('离线模式不支持此操作');
    },

    // ========== Projects ==========

    /** 获取项目列表 */
    async getProjects() {
        return this.request('/projects/');
    },

    /** 创建项目 */
    async createProject(rootPath, name) {
        const body = { root_path: rootPath };
        if (name) body.name = name;
        return this.request('/projects/', {
            method: 'POST',
            body: JSON.stringify(body),
        });
    },

    /** 删除项目 */
    async deleteProject(id) {
        return this.request(`/projects/${id}`, { method: 'DELETE' });
    },

    /** 重新扫描项目 */
    async rescanProject(id) {
        return this.request(`/projects/${id}/rescan`, { method: 'POST' });
    },

    // ========== Functions ==========

    /**
     * 获取函数分页列表
     * @param {number} projectId
     * @param {number} page
     * @param {number} perPage
     */
    async getFunctions(projectId, page = 1, perPage = 50) {
        return this.request(`/functions/?project_id=${projectId}&page=${page}&per_page=${perPage}`);
    },

    /**
     * 获取所有函数（自动分页加载）
     * @param {number} projectId
     * @returns {Promise<Array>} 所有函数的基本信息列表
     */
    async getAllFunctions(projectId) {
        if (!this._shouldTryServer()) {
            // 离线或服务器不可达：直接从 IndexedDB 查全部
            const items = await CacheDB.getAllByIndex('functions', 'projectId', projectId);
            return items || [];
        }
        // 在线且服务器可达：原逻辑（分页加载）
        const allItems = [];
        let page = 1;
        const perPage = 200;
        while (true) {
            const data = await this.getFunctions(projectId, page, perPage);
            allItems.push(...data.items);
            if (allItems.length >= data.total || data.items.length < perPage) {
                break;
            }
            page++;
        }
        return allItems;
    },

    /** 获取函数详情 */
    async getFunctionDetail(id) {
        return this.request(`/functions/${id}`);
    },

    /** 标记函数为已读 */
    async markRead(functionId) {
        return this.request(`/functions/${functionId}/read`, { method: 'PUT' });
    },

    /** 重置项目所有函数已读状态 */
    async resetAllRead(projectId) {
        return this.request(`/functions/reset-read?project_id=${projectId}`, { method: 'PUT' });
    },

    // ========== Notes ==========

    /** 添加备注 */
    async addNote(functionId, projectId, content, noteType = 'general') {
        return this.request('/notes/', {
            method: 'POST',
            body: JSON.stringify({
                function_id: functionId,
                project_id: projectId,
                content,
                note_type: noteType,
            }),
        });
    },

    /** 更新备注 */
    async updateNote(id, content, noteType) {
        const body = {};
        if (content !== undefined) body.content = content;
        if (noteType !== undefined) body.note_type = noteType;
        return this.request(`/notes/${id}`, {
            method: 'PUT',
            body: JSON.stringify(body),
        });
    },

    /** 删除备注 */
    async deleteNote(id) {
        return this.request(`/notes/${id}`, { method: 'DELETE' });
    },

    // ========== Call Graph ==========

    /** 获取调用关系图数据 */
    async getCallGraph(projectId) {
        return this.request(`/call_graph/?project_id=${projectId}`);
    },

    // ========== Export ==========

    /** 获取导出数据（JSON格式） */
    async getExport(projectId, format = 'json') {
        if (format === 'markdown') {
            return this.getExportText(projectId);
        }
        return this.request(`/export/?project_id=${projectId}&format=${format}`);
    },

    /** 导出并保存到服务端 */
    async saveExport(projectId, format = 'json') {
        return this.request(`/export/save?project_id=${projectId}&format=${format}`, {
            method: 'POST',
        });
    },

    /** 清空项目所有备注 */
    async clearProjectNotes(projectId) {
        return this.request(`/notes/clear?project_id=${projectId}`, { method: 'DELETE' });
    },

    /** 获取导出文本（Markdown格式，不做JSON解析） */
    async getExportText(projectId) {
        if (!this._shouldTryServer()) {
            throw new Error('服务器不可达，不支持导出功能');
        }
        const url = `${this.BASE}/export/?project_id=${projectId}&format=markdown`;
        const resp = await fetch(url);
        if (!resp.ok) {
            let detail = '';
            try {
                const err = await resp.json();
                detail = err.detail || JSON.stringify(err);
            } catch (_) {
                detail = resp.statusText;
            }
            throw new Error(detail || `HTTP ${resp.status}`);
        }
        return resp.text();
    },

    // ========== Reading Progress ==========

    /** 获取阅读进度 */
    async getProgress(projectId) {
        return this.request(`/progress/?project_id=${projectId}`);
    },

    /** 保存阅读进度 */
    async saveProgress(projectId, lastFunctionId) {
        const body = {};
        if (lastFunctionId != null) body.last_function_id = lastFunctionId;
        return this.request(`/progress/?project_id=${projectId}`, {
            method: 'PUT',
            body: JSON.stringify(body),
        });
    },

    // ========== AI ==========

    /** 获取函数AI解读 */
    async getAIExplanation(functionId) {
        return this.request(`/ai/explanation?function_id=${functionId}`);
    },

    /** 行级代码解释 */
    async getAILineExplain(functionId, lineNumber, lineContent) {
        return this.request('/ai/line-explain', {
            method: 'POST',
            body: JSON.stringify({
                function_id: functionId,
                line_number: lineNumber,
                line_content: lineContent,
            }),
        });
    },

    /** 生成AI自动备注 */
    async generateAINotes(functionId, projectId) {
        return this.request('/ai/auto-notes', {
            method: 'POST',
            body: JSON.stringify({
                function_id: functionId,
                project_id: projectId,
            }),
        });
    },

    // ========== AI Chat ==========

    /** 获取对话历史 */
    async getChatHistory(functionId) {
        return this.request(`/ai/chat?function_id=${functionId}`);
    },

    /** 发送对话消息 */
    async sendChatMessage(functionId, message) {
        return this.request('/ai/chat', {
            method: 'POST',
            body: JSON.stringify({ function_id: functionId, message }),
        });
    },

    /** 重置对话 */
    async resetChat(functionId) {
        return this.request(`/ai/chat?function_id=${functionId}`, { method: 'DELETE' });
    },

    // ========== Reading Paths ==========

    /** 创建阅读路径（AI生成） */
    async createReadingPath(projectId, query) {
        return this.request('/reading-paths/', {
            method: 'POST',
            body: JSON.stringify({ project_id: projectId, query }),
        });
    },

    /** 获取阅读路径列表 */
    async getReadingPaths(projectId) {
        return this.request(`/reading-paths/?project_id=${projectId}`);
    },

    /** 获取阅读路径详情 */
    async getReadingPathDetail(pathId) {
        return this.request(`/reading-paths/${pathId}`);
    },

    /** 删除阅读路径 */
    async deleteReadingPath(pathId) {
        return this.request(`/reading-paths/${pathId}`, { method: 'DELETE' });
    },

    /** 更新阅读路径进度 */
    async updateReadingPathProgress(pathId, lastIndex) {
        return this.request(`/reading-paths/${pathId}/progress`, {
            method: 'PUT',
            body: JSON.stringify({ last_index: lastIndex }),
        });
    },

    /** 初始化API基础URL（Android WebView时从原生接口获取） */
    _initBase() {
        if (window.CodeReaderAndroid) {
            const serverUrl = window.CodeReaderAndroid.getServerUrl();
            if (serverUrl) {
                this.BASE = serverUrl.replace(/\/+$/, '') + '/api/v1';
            }
        }
    },
};
// Android WebView 环境下初始化远程服务器地址
API._initBase();
