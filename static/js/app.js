/**
 * 应用入口 - Hash路由管理
 * 5个视图的路由切换和初始化
 */
const App = {
    views: ['view-projects', 'view-browse', 'view-graph', 'view-list', 'view-export', 'view-paths'],

    /** 应用启动 */
    init() {
        Notes.init();
        this._bindProjectEvents();
        window.addEventListener('hashchange', () => this.route());

        // 初始化离线缓存系统
        this._initOffline();
        // 注册 Service Worker
        this._registerSW();
        // PWA安装引导
        this._initPWAInstall();
        // Android WebView: 服务器设置入口
        this._initAndroidSettings();

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
            const pathId = params.get('path') ? parseInt(params.get('path')) : null;
            this._showView('view-browse');
            Browse.init(projectId, funcId, pathId);
            return;
        }

        const graphMatch = hash.match(/^#\/project\/(\d+)\/graph$/);
        if (graphMatch) {
            const projectId = parseInt(graphMatch[1]);
            this._showView('view-graph');
            const currentFuncId = Browse.currentDetail ? Browse.currentDetail.id : null;
            Graph.init(projectId, currentFuncId);
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

        const pathsMatch = hash.match(/^#\/project\/(\d+)\/paths$/);
        if (pathsMatch) {
            const projectId = parseInt(pathsMatch[1]);
            this._showView('view-paths');
            Paths.init(projectId);
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

            this._renderProjectList(projects, listEl, emptyEl);

        } catch (err) {
            // 尝试从缓存加载
            if (typeof CacheDB !== 'undefined' && CacheDB._db) {
                try {
                    const cachedProjects = await CacheDB.getAll('projects');
                    if (cachedProjects && cachedProjects.length > 0) {
                        this._renderProjectList(cachedProjects, listEl, emptyEl);
                        return;
                    }
                } catch (_) {}
            }
            listEl.innerHTML = `<div class="empty-state"><p>加载失败: ${err.message}</p></div>`;
            emptyEl.style.display = 'none';
        }
    },

    /** 渲染项目列表（正常加载和缓存加载共用） */
    _renderProjectList(projects, listEl, emptyEl) {
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
                <div class="cache-status" data-project-id="${p.id}"></div>
            </div>
        `).join('');

        // 绑定卡片点击
        listEl.querySelectorAll('.project-card').forEach(card => {
            card.addEventListener('click', (e) => {
                // 排除删除按钮和缓存按钮点击
                if (e.target.closest('.project-card-delete')) return;
                if (e.target.closest('.cache-status')) return;
                const id = parseInt(card.dataset.projectId);
                location.hash = `#/project/${id}/browse`;
            });
        });

        // 绑定删除按钮
        listEl.querySelectorAll('.project-card-delete').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (typeof Offline !== 'undefined' && !Offline.isOnline) {
                    alert('离线模式不支持删除项目');
                    return;
                }
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

        // 渲染缓存状态
        this._renderCacheStatus(projects);
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
            if (typeof Offline !== 'undefined' && !Offline.isOnline) {
                alert('离线模式不支持创建项目');
                return;
            }
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

    /** 初始化离线缓存系统 */
    async _initOffline() {
        try {
            await CacheDB.open();
            Offline.init();
        } catch (e) {
            console.warn('离线缓存初始化失败:', e);
        }
    },

    /** 注册 Service Worker */
    _registerSW() {
        if (window.CodeReaderAndroid) return;
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js').catch(err => {
                console.warn('SW注册失败:', err);
            });
        }
    },

    /** PWA安装引导 */
    _initPWAInstall() {
        if (window.CodeReaderAndroid) return;
        // 如果已在PWA模式或已忽略，不显示
        if (window.matchMedia('(display-mode: standalone)').matches) return;
        if (localStorage.getItem('pwa-install-dismissed')) return;

        let deferredPrompt = null;

        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredPrompt = e;
            const banner = document.getElementById('pwa-install-banner');
            if (banner) banner.style.display = 'flex';
        });

        const installBtn = document.getElementById('pwa-install-btn');
        if (installBtn) {
            installBtn.addEventListener('click', async () => {
                if (deferredPrompt) {
                    deferredPrompt.prompt();
                    await deferredPrompt.userChoice;
                    deferredPrompt = null;
                }
                const banner = document.getElementById('pwa-install-banner');
                if (banner) banner.style.display = 'none';
            });
        }

        const dismissBtn = document.getElementById('pwa-dismiss-btn');
        if (dismissBtn) {
            dismissBtn.addEventListener('click', () => {
                const banner = document.getElementById('pwa-install-banner');
                if (banner) banner.style.display = 'none';
                localStorage.setItem('pwa-install-dismissed', '1');
            });
        }

        // iOS 提示
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        if (isIOS && !window.navigator.standalone) {
            const banner = document.getElementById('pwa-install-banner');
            if (banner) {
                const spanEl = banner.querySelector('span');
                if (spanEl) spanEl.textContent = '点击分享按钮 → 添加到主屏幕以支持离线使用';
                if (installBtn) installBtn.style.display = 'none';
                banner.style.display = 'flex';
            }
        }
    },

    /** Android WebView: 在项目列表页添加服务器设置按钮 */
    _initAndroidSettings() {
        if (!window.CodeReaderAndroid) return;
        const topBar = document.querySelector('#view-projects .top-bar');
        if (!topBar) return;
        const btn = document.createElement('button');
        btn.textContent = '\u2699';
        btn.title = '修改服务器地址';
        btn.style.cssText = 'background:none;border:none;color:var(--text-secondary);font-size:20px;padding:8px;cursor:pointer;margin-left:auto;';
        btn.addEventListener('click', () => CodeReaderAndroid.changeServerUrl());
        topBar.appendChild(btn);
    },

    /** 渲染项目卡片的缓存状态 */
    async _renderCacheStatus(projects) {
        if (typeof CacheDB === 'undefined' || !CacheDB._db) return;

        for (const p of projects) {
            const statusEl = document.querySelector(`.cache-status[data-project-id="${p.id}"]`);
            if (!statusEl) continue;

            const meta = await CacheDB.getCacheMeta(p.id);

            if (!meta || meta.status !== 'complete') {
                // 未缓存
                statusEl.innerHTML = '<button class="cache-btn-download" data-project-id="' + p.id + '">下载离线缓存</button>';
            } else {
                // 已缓存 - 检查是否需要更新
                const needsUpdate = meta.serverScanTime && p.scan_time && meta.serverScanTime !== p.scan_time;
                if (needsUpdate) {
                    statusEl.innerHTML = '<span class="cache-warning">项目已重新扫描</span> <button class="cache-btn-update" data-project-id="' + p.id + '">更新缓存</button>';
                } else {
                    const time = meta.downloadedAt ? new Date(meta.downloadedAt).toLocaleDateString('zh-CN') : '';
                    statusEl.innerHTML = '<span class="cache-info">已缓存 · ' + (meta.funcCount || 0) + ' 函数 · ' + time + '</span> <button class="cache-btn-delete" data-project-id="' + p.id + '">删除</button>';
                }
            }
        }

        // 绑定缓存操作按钮事件
        document.querySelectorAll('.cache-btn-download, .cache-btn-update').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const pid = parseInt(btn.dataset.projectId);
                this._downloadCache(pid, btn);
            });
        });

        document.querySelectorAll('.cache-btn-delete').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const pid = parseInt(btn.dataset.projectId);
                if (!confirm('确定删除该项目的离线缓存？')) return;
                await CacheManager.deleteProjectCache(pid);
                this._loadProjects(); // 刷新列表
            });
        });
    },

    /** 下载项目离线缓存 */
    async _downloadCache(projectId, btnEl) {
        const statusEl = btnEl.closest('.cache-status');
        if (!statusEl) return;

        statusEl.innerHTML = '<div class="cache-progress"><div class="cache-progress-bar" style="width:0%"></div></div><span class="cache-progress-text">准备下载...</span>';

        try {
            await CacheManager.downloadProject(projectId, (current, total, phase) => {
                const pct = total > 0 ? Math.round(current / total * 100) : 0;
                const bar = statusEl.querySelector('.cache-progress-bar');
                const text = statusEl.querySelector('.cache-progress-text');
                if (bar) bar.style.width = pct + '%';
                if (text) text.textContent = '缓存中... ' + current + '/' + total + ' (' + pct + '%)';
            });
            this._loadProjects(); // 刷新列表
        } catch (err) {
            statusEl.innerHTML = '<span class="cache-warning">下载失败: ' + err.message + '</span> <button class="cache-btn-download" data-project-id="' + projectId + '">重试</button>';
            // 重新绑定按钮
            const retryBtn = statusEl.querySelector('.cache-btn-download');
            if (retryBtn) {
                retryBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._downloadCache(projectId, retryBtn);
                });
            }
        }
    },
};

// 启动应用
document.addEventListener('DOMContentLoaded', () => App.init());
