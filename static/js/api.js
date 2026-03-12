/**
 * API 请求封装模块
 * 所有后端API调用统一通过此模块
 */
const API = {
    BASE: '/api/v1',

    /**
     * 通用请求方法
     * @param {string} path - API路径（不含BASE前缀）
     * @param {object} options - fetch选项
     * @returns {Promise<any>}
     */
    async request(path, options = {}) {
        const url = this.BASE + path;
        const config = {
            headers: { 'Content-Type': 'application/json' },
            ...options,
        };
        const resp = await fetch(url, config);
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
        // 对于204 No Content等，不解析JSON
        if (resp.status === 204) return null;
        const text = await resp.text();
        return text ? JSON.parse(text) : null;
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

    /** 获取导出文本（Markdown格式，不做JSON解析） */
    async getExportText(projectId) {
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
};
