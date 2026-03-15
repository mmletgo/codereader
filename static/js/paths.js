/**
 * 阅读路径管理模块
 * 管理AI生成的阅读路径：创建、查看、删除、激活
 */
const Paths = {
    projectId: null,
    projectName: '',
    currentPathId: null,

    /**
     * 初始化阅读路径页面
     * @param {number} projectId
     */
    async init(projectId) {
        this.projectId = projectId;
        this.currentPathId = null;
        this._bindEvents();
        this._showListPanel();
        this._clearDetail();
        await this._loadProject();
        await this._loadPathList();
    },

    /** 是否PC端宽屏 */
    _isPC() {
        return window.matchMedia('(min-width: 1024px)').matches;
    },

    /** 清空详情面板（PC端显示占位提示） */
    _clearDetail() {
        const emptyEl = document.getElementById('paths-detail-empty');
        const contentEl = document.getElementById('paths-detail-content');
        if (emptyEl) emptyEl.style.display = 'flex';
        if (contentEl) contentEl.style.display = 'none';
    },

    /** 加载项目信息（项目名显示在top-bar） */
    async _loadProject() {
        try {
            const project = await API.getProject(this.projectId);
            this.projectName = project.name || '';
            document.getElementById('paths-project-name').textContent = this.projectName;
        } catch (_) { /* 静默 */ }
    },

    /** 切换到列表面板 */
    _showListPanel() {
        document.getElementById('paths-panel-list').style.display = '';
        if (!this._isPC()) {
            document.getElementById('paths-panel-detail').style.display = 'none';
        }
    },

    /** 切换到详情面板 */
    _showDetailPanel() {
        document.getElementById('paths-panel-detail').style.display = '';
        if (!this._isPC()) {
            document.getElementById('paths-panel-list').style.display = 'none';
        }
    },

    /** 加载路径列表 */
    async _loadPathList() {
        const listEl = document.getElementById('paths-list');
        const emptyEl = document.getElementById('paths-empty');
        try {
            const paths = await API.getReadingPaths(this.projectId);
            if (paths.length === 0) {
                listEl.innerHTML = '';
                emptyEl.style.display = 'flex';
                return;
            }
            emptyEl.style.display = 'none';
            // 检查当前是否有激活的路径
            const activeId = Browse.activeReadingPath ? Browse.activeReadingPath.id : null;
            let html = '';
            for (const p of paths) {
                const isActive = p.id === activeId;
                const progress = `${Math.min(p.last_index + 1, p.function_count)}/${p.function_count}`;
                html += `<div class="paths-card${isActive ? ' active' : ''}" data-path-id="${p.id}">
                    <div class="paths-card-body">
                        <div class="paths-card-name">${this._escapeHtml(p.name)}</div>
                        <div class="paths-card-desc">${this._escapeHtml(p.description)}</div>
                        <div class="paths-card-meta">${p.function_count} 个函数 · 已读 ${progress}</div>
                    </div>
                    <div class="paths-card-actions">
                        ${isActive ? '<span class="paths-card-badge">阅读中</span>' : '<span class="paths-card-arrow">&#8250;</span>'}
                    </div>
                </div>`;
            }
            listEl.innerHTML = html;
        } catch (err) {
            listEl.innerHTML = `<div class="paths-error">加载失败: ${err.message}</div>`;
            emptyEl.style.display = 'none';
        }
    },

    /** 创建阅读路径 */
    async _createPath() {
        if (typeof Offline !== 'undefined' && !Offline.isServerAvailable) {
            const errorEl = document.getElementById('path-create-error');
            errorEl.textContent = '离线模式不支持AI生成阅读路径';
            errorEl.style.display = 'block';
            return;
        }
        const input = document.getElementById('input-path-query');
        const query = input.value.trim();
        const errorEl = document.getElementById('path-create-error');
        if (!query) {
            errorEl.textContent = '请输入你想了解的业务逻辑描述';
            errorEl.style.display = 'block';
            return;
        }
        errorEl.style.display = 'none';
        const btn = document.getElementById('btn-generate-path');
        const genEl = document.getElementById('path-generating');
        btn.disabled = true;
        btn.textContent = 'AI 分析中...';
        genEl.style.display = 'flex';
        try {
            const path = await API.createReadingPath(this.projectId, query);
            input.value = '';
            genEl.style.display = 'none';
            // 生成成功后自动进入详情
            await this._showPathDetail(path.id);
        } catch (err) {
            errorEl.textContent = '生成失败: ' + err.message;
            errorEl.style.display = 'block';
        } finally {
            btn.disabled = false;
            btn.textContent = 'AI 生成阅读路径';
            genEl.style.display = 'none';
        }
    },

    /**
     * 显示路径详情
     * @param {number} pathId
     */
    async _showPathDetail(pathId) {
        this.currentPathId = pathId;
        this._showDetailPanel();
        // 隐藏占位、显示内容
        const emptyEl = document.getElementById('paths-detail-empty');
        const contentEl = document.getElementById('paths-detail-content');
        if (emptyEl) emptyEl.style.display = 'none';
        if (contentEl) contentEl.style.display = '';
        const metaEl = document.getElementById('paths-detail-meta');
        const funcsEl = document.getElementById('paths-detail-funcs');
        const activateBtn = document.getElementById('btn-activate-path');

        try {
            const detail = await API.getReadingPathDetail(pathId);

            // 渲染元信息
            metaEl.innerHTML = `
                <div class="paths-detail-name">${this._escapeHtml(detail.name)}</div>
                <div class="paths-detail-desc">${this._escapeHtml(detail.description)}</div>
                <div class="paths-detail-info">${detail.functions.length} 个函数 · ${detail.created_at}</div>
            `;

            // 渲染函数列表
            let funcsHtml = '';
            detail.functions.forEach((f, idx) => {
                const isAvailable = f.function_id != null;
                const shortName = f.qualified_name.includes('.')
                    ? f.qualified_name.split('.').slice(-2).join('.')
                    : f.qualified_name;
                funcsHtml += `<div class="paths-func-item${isAvailable ? '' : ' unavailable'}" data-func-id="${f.function_id || ''}">
                    <div class="paths-func-index">${idx + 1}</div>
                    <div class="paths-func-body">
                        <div class="paths-func-name">${this._escapeHtml(shortName)}</div>
                        <div class="paths-func-reason">${this._escapeHtml(f.reason)}</div>
                    </div>
                </div>`;
            });
            funcsEl.innerHTML = funcsHtml;

            // 按钮文字：当前激活的路径显示"继续阅读"，否则显示"开始阅读"
            const activeId = Browse.activeReadingPath ? Browse.activeReadingPath.id : null;
            activateBtn.textContent = (pathId === activeId) ? '继续阅读' : '开始阅读';

        } catch (err) {
            metaEl.innerHTML = '';
            funcsEl.innerHTML = `<div class="paths-error">加载失败: ${err.message}</div>`;
        }
    },

    /**
     * 删除路径
     * @param {number} pathId
     */
    async _deletePath(pathId) {
        if (typeof Offline !== 'undefined' && !Offline.isServerAvailable) {
            alert('离线模式不支持删除路径');
            return;
        }
        if (!confirm('确认删除该阅读路径？')) return;
        try {
            await API.deleteReadingPath(pathId);
            // 如果删除的是当前激活的路径，退出路径模式
            if (Browse.activeReadingPath && Browse.activeReadingPath.id === pathId) {
                Browse.deactivateReadingPath();
            }
            // 如果当前在详情页且删的就是当前路径，返回列表
            if (this.currentPathId === pathId) {
                this.currentPathId = null;
                this._showListPanel();
                this._clearDetail();
            }
            await this._loadPathList();
        } catch (err) {
            alert('删除失败: ' + err.message);
        }
    },

    /**
     * 激活路径并跳转浏览页
     * @param {number} pathId
     */
    async _activateAndBrowse(pathId) {
        location.hash = `#/project/${this.projectId}/browse?path=${pathId}`;
    },

    /** 绑定事件（只绑定一次） */
    _bindEvents() {
        if (this._bound) return;
        this._bound = true;

        // 返回按钮 → 回到浏览页
        document.getElementById('paths-back').addEventListener('click', () => {
            location.hash = `#/project/${this.projectId}/browse`;
        });

        // 生成按钮
        document.getElementById('btn-generate-path').addEventListener('click', () => {
            this._createPath();
        });

        // 输入框回车
        document.getElementById('input-path-query').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this._createPath();
            }
        });

        // 路径列表点击 → 查看详情
        document.getElementById('paths-list').addEventListener('click', (e) => {
            const card = e.target.closest('.paths-card');
            if (!card) return;
            const pathId = parseInt(card.dataset.pathId);
            this._showPathDetail(pathId);
        });

        // 详情页：返回列表
        document.getElementById('paths-detail-back').addEventListener('click', () => {
            this.currentPathId = null;
            this._showListPanel();
            this._clearDetail();
            this._loadPathList();
        });

        // 详情页：删除
        document.getElementById('paths-detail-delete').addEventListener('click', () => {
            if (this.currentPathId) {
                this._deletePath(this.currentPathId);
            }
        });

        // 详情页：开始/继续阅读
        document.getElementById('btn-activate-path').addEventListener('click', () => {
            if (this.currentPathId) {
                this._activateAndBrowse(this.currentPathId);
            }
        });

        // 详情页：点击函数卡片 → 激活路径并跳转到该函数
        document.getElementById('paths-detail-funcs').addEventListener('click', (e) => {
            const item = e.target.closest('.paths-func-item');
            if (!item || item.classList.contains('unavailable')) return;
            const funcId = parseInt(item.dataset.funcId);
            if (!funcId) return;
            if (this.currentPathId) {
                location.hash = `#/project/${this.projectId}/browse?path=${this.currentPathId}&func=${funcId}`;
            }
        });
    },

    /** HTML转义 */
    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    },
};
