/**
 * 应用入口 - Hash路由管理
 * 5个视图的路由切换和初始化
 */
const App = {
    views: ['view-projects', 'view-browse', 'view-graph', 'view-list', 'view-export'],

    /** 应用启动 */
    init() {
        Notes.init();
        this._bindProjectEvents();
        window.addEventListener('hashchange', () => this.route());
        this.route();
    },

    /** 路由分发 */
    route() {
        const hash = location.hash || '#/';
        // 解析路由
        // #/ -> 项目列表
        // #/project/{id}/browse?func={funcId} -> 函数浏览器
        // #/project/{id}/graph -> 调用关系图
        // #/project/{id}/list -> 函数列表
        // #/project/{id}/export -> 导出

        if (hash === '#/' || hash === '#' || hash === '') {
            this._showView('view-projects');
            this._loadProjects();
            return;
        }

        const browseMatch = hash.match(/^#\/project\/(\d+)\/browse/);
        if (browseMatch) {
            const projectId = parseInt(browseMatch[1]);
            const params = new URLSearchParams(hash.split('?')[1] || '');
            const funcId = params.get('func') ? parseInt(params.get('func')) : null;
            this._showView('view-browse');
            Browse.init(projectId, funcId);
            return;
        }

        const graphMatch = hash.match(/^#\/project\/(\d+)\/graph$/);
        if (graphMatch) {
            const projectId = parseInt(graphMatch[1]);
            this._showView('view-graph');
            Graph.init(projectId);
            return;
        }

        const listMatch = hash.match(/^#\/project\/(\d+)\/list$/);
        if (listMatch) {
            const projectId = parseInt(listMatch[1]);
            this._showView('view-list');
            List.init(projectId);
            return;
        }

        const exportMatch = hash.match(/^#\/project\/(\d+)\/export$/);
        if (exportMatch) {
            const projectId = parseInt(exportMatch[1]);
            this._showView('view-export');
            Export.init(projectId);
            return;
        }

        // 未匹配，回到首页
        location.hash = '#/';
    },

    /** 显示指定视图，隐藏其他 */
    _showView(viewId) {
        this.views.forEach(id => {
            document.getElementById(id).style.display = id === viewId ? 'flex' : 'none';
        });
    },

    /** 加载项目列表 */
    async _loadProjects() {
        const listEl = document.getElementById('projects-list');
        const emptyEl = document.getElementById('projects-empty');

        try {
            const projects = await API.getProjects();
            if (!projects || projects.length === 0) {
                listEl.innerHTML = '';
                emptyEl.style.display = 'flex';
                return;
            }

            emptyEl.style.display = 'none';
            listEl.innerHTML = projects.map(p => `
                <div class="project-card" data-project-id="${p.id}">
                    <button class="project-card-delete" data-project-id="${p.id}" title="删除项目">&times;</button>
                    <div class="project-card-name">${this._escapeHtml(p.name)}</div>
                    <div class="project-card-path">${this._escapeHtml(p.root_path)}</div>
                    <div class="project-card-stats">
                        <span>\u{1F4C4} ${p.file_count} 文件</span>
                        <span>\u{0192} ${p.func_count} 函数</span>
                    </div>
                    <div class="project-card-time">${this._formatTime(p.scan_time)}</div>
                </div>
            `).join('');

            // 绑定卡片点击
            listEl.querySelectorAll('.project-card').forEach(card => {
                card.addEventListener('click', (e) => {
                    // 排除删除按钮点击
                    if (e.target.closest('.project-card-delete')) return;
                    const id = parseInt(card.dataset.projectId);
                    location.hash = `#/project/${id}/browse`;
                });
            });

            // 绑定删除按钮
            listEl.querySelectorAll('.project-card-delete').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const id = parseInt(btn.dataset.projectId);
                    if (!confirm('确定删除此项目？所有备注也将被删除。')) return;
                    try {
                        await API.deleteProject(id);
                        this._loadProjects();
                    } catch (err) {
                        alert('删除失败: ' + err.message);
                    }
                });
            });

        } catch (err) {
            listEl.innerHTML = `<div class="empty-state"><p>加载失败: ${err.message}</p></div>`;
            emptyEl.style.display = 'none';
        }
    },

    /** 绑定项目创建相关事件 */
    _bindProjectEvents() {
        const dialog = document.getElementById('dialog-new-project');
        const btnNew = document.getElementById('btn-new-project');
        const btnCancel = document.getElementById('btn-cancel-project');
        const btnConfirm = document.getElementById('btn-confirm-project');
        const inputPath = document.getElementById('input-project-path');
        const inputName = document.getElementById('input-project-name');
        const errorMsg = document.getElementById('project-create-error');

        btnNew.addEventListener('click', () => {
            inputPath.value = '';
            inputName.value = '';
            errorMsg.style.display = 'none';
            dialog.style.display = 'flex';
            inputPath.focus();
        });

        btnCancel.addEventListener('click', () => {
            dialog.style.display = 'none';
        });

        // 点击overlay背景关闭
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) dialog.style.display = 'none';
        });

        btnConfirm.addEventListener('click', async () => {
            const path = inputPath.value.trim();
            if (!path) {
                errorMsg.textContent = '请输入目录路径';
                errorMsg.style.display = 'block';
                return;
            }

            const name = inputName.value.trim() || null;
            errorMsg.style.display = 'none';
            btnConfirm.disabled = true;
            btnConfirm.textContent = '扫描中...';

            try {
                await API.createProject(path, name);
                dialog.style.display = 'none';
                this._loadProjects();
            } catch (err) {
                errorMsg.textContent = err.message;
                errorMsg.style.display = 'block';
            } finally {
                btnConfirm.disabled = false;
                btnConfirm.textContent = '创建并扫描';
            }
        });
    },

    /** 格式化时间 */
    _formatTime(isoStr) {
        if (!isoStr) return '';
        try {
            const d = new Date(isoStr);
            return d.toLocaleString('zh-CN');
        } catch (_) {
            return isoStr;
        }
    },

    /** HTML转义 */
    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    },
};

// 启动应用
document.addEventListener('DOMContentLoaded', () => App.init());
