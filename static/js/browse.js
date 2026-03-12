/**
 * 函数浏览器模块
 * 核心页面：左右切换函数、代码高亮、行号显示
 */
const _PY_KEYWORDS = new Set(['if','else','elif','for','while','with','as','try','except',
    'finally','raise','return','yield','import','from','class','def','and','or',
    'not','in','is','lambda','pass','break','continue','del','assert','global',
    'nonlocal','async','await','print']);

const Browse = {
    projectId: null,
    projectName: '',
    functions: [],         // [{id, name, qualified_name, ...}] 排好序的函数列表
    filteredFunctions: [], // 筛选后的函数列表（如"只看有备注的"）
    currentIndex: 0,       // 当前在filteredFunctions中的索引
    currentDetail: null,   // 当前函数详情缓存
    cache: new Map(),      // id -> detail 缓存
    htmlCache: new Map(),  // id -> rendered HTML string 缓存
    filterHasNotes: false, // 是否筛选有备注的
    filterUnread: false,   // 是否只显示未读函数
    _saveTimer: null,      // 防抖保存定时器
    _unreadCount: 0,       // 未读函数计数（增量维护）

    /**
     * 初始化浏览器
     * @param {number} projectId
     * @param {number|null} funcId - 可选，直接跳转到指定函数
     */
    async init(projectId, funcId) {
        this.projectId = projectId;
        this.cache.clear();
        this.htmlCache.clear();
        this.filterHasNotes = false;
        this.filterUnread = false;
        document.getElementById('filter-has-notes').checked = false;
        document.getElementById('filter-unread').checked = false;
        this._bindEvents();

        // 立即显示骨架屏
        this._showSkeleton();

        // 并行发起三个API请求
        const [_, allFunctions, progress] = await Promise.all([
            this._loadProject(),
            API.getAllFunctions(projectId),
            funcId ? Promise.resolve(null) : API.getProgress(projectId).catch(() => null),
        ]);
        this.functions = allFunctions;
        this._unreadCount = this.functions.filter(f => !f.is_read).length;
        this._applyFilter();

        // 恢复阅读进度（和原逻辑相同）
        let resumeFuncId = funcId;
        if (!resumeFuncId && progress && progress.last_function_id) {
            resumeFuncId = progress.last_function_id;
        }

        if (resumeFuncId) {
            const idx = this.filteredFunctions.findIndex(f => f.id === resumeFuncId);
            if (idx >= 0) {
                await this.showFunction(idx);
            } else {
                this.filterHasNotes = false;
                this._applyFilter();
                const idx2 = this.filteredFunctions.findIndex(f => f.id === resumeFuncId);
                if (idx2 >= 0) {
                    await this.showFunction(idx2);
                } else if (this.filteredFunctions.length > 0) {
                    await this.showFunction(0);
                }
            }
        } else if (this.filteredFunctions.length > 0) {
            await this.showFunction(0);
        } else {
            this._renderEmpty();
        }
    },

    /** 加载项目信息 */
    async _loadProject() {
        try {
            const projects = await API.getProjects();
            const proj = projects.find(p => p.id === this.projectId);
            if (proj) {
                this.projectName = proj.name;
                document.getElementById('browse-project-name').textContent = proj.name;
            }
        } catch (_) {
            // 忽略，使用默认值
        }
    },

    /** 加载所有函数基本信息 */
    async loadFunctionList() {
        this.functions = await API.getAllFunctions(this.projectId);
        this._unreadCount = this.functions.filter(f => !f.is_read).length;
        this._applyFilter();
    },

    /** 应用筛选 */
    _applyFilter() {
        let list = this.functions;
        if (this.filterHasNotes) {
            list = list.filter(f => f.has_notes || f.note_count > 0);
        }
        if (this.filterUnread) {
            list = list.filter(f => !f.is_read);
        }
        this.filteredFunctions = [...list];
        this._renderSidebar();
    },

    /**
     * 切换到指定索引的函数
     * @param {number} index - filteredFunctions中的索引
     */
    async showFunction(index) {
        if (index < 0 || index >= this.filteredFunctions.length) return;
        this.currentIndex = index;
        const func = this.filteredFunctions[index];

        // 用列表数据立即渲染信息栏
        document.getElementById('func-qualified-name').textContent = func.qualified_name;
        const fileInfo = `\u{1F4C4} ${func.file_path}:${func.start_line}-${func.end_line}`;
        document.getElementById('func-file-info').textContent = fileInfo;

        // 先尝试缓存
        let detail = this.cache.get(func.id);
        if (!detail) {
            // 缓存未命中，显示骨架屏
            this._showSkeleton();
            try {
                detail = await API.getFunctionDetail(func.id);
                this.cache.set(func.id, detail);
            } catch (err) {
                document.getElementById('code-block').textContent = '加载失败: ' + err.message;
                return;
            }
        }

        this.currentDetail = detail;
        this._renderInfo(detail);  // 用详细数据更新信息栏

        // 使用HTML缓存避免重复高亮计算
        const cachedHtml = this.htmlCache.get(func.id);
        if (cachedHtml) {
            const codeEl = document.getElementById('code-block');
            codeEl.innerHTML = cachedHtml;
            codeEl.className = 'language-python hljs';
            document.getElementById('browse-code').scrollTop = 0;
        } else {
            this.renderCode(detail);
        }

        Notes.collapse();
        Notes.render(detail.notes, detail.id, this.projectId);
        AI.collapse();
        AI.renderExplanation(detail.id);

        // 标记已读
        if (!func.is_read) {
            func.is_read = true;
            if (detail) detail.is_read = true;
            this._unreadCount = Math.max(0, this._unreadCount - 1);
            API.markRead(func.id).catch(() => {});
        }
        this._updateNav();
        this._updateSidebarActive();
        this._debounceSaveProgress();

        // 预加载相邻函数
        this._preloadAdjacent(index);
    },

    /** 防抖保存阅读进度（切换函数后1秒保存） */
    _debounceSaveProgress() {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            this._saveProgress();
        }, 1000);
    },

    /** 保存阅读进度到服务器 */
    async _saveProgress() {
        if (!this.projectId) return;
        const func = this.filteredFunctions[this.currentIndex];
        if (!func) return;
        try {
            await API.saveProgress(this.projectId, func.id);
        } catch (_) { /* 静默失败 */ }
    },

    /** 渲染函数信息栏 */
    _renderInfo(detail) {
        document.getElementById('func-qualified-name').textContent = detail.qualified_name;
        const fileInfo = `\u{1F4C4} ${detail.file_path}:${detail.start_line}-${detail.end_line}`;
        document.getElementById('func-file-info').textContent = fileInfo;
    },

    /** 构建代码HTML（高亮+行号+调用按钮+AI按钮） */
    _buildCodeHtml(detail) {
        const startLine = detail.start_line;
        let highlighted = hljs.highlight(detail.body, { language: 'python' }).value;
        highlighted = this._enhanceHighlight(highlighted);

        const rawLines = highlighted.split('\n');
        let openTags = [];
        const lineCalls = detail.line_calls || {};
        const wrappedLines = rawLines.map((line, i) => {
            const lineNum = startLine + i;
            const prefix = openTags.join('');
            const tagRegex = /<\/?span[^>]*>/g;
            let match;
            while ((match = tagRegex.exec(line)) !== null) {
                if (match[0].startsWith('</')) {
                    openTags.pop();
                } else {
                    openTags.push(match[0]);
                }
            }
            const suffix = '</span>'.repeat(openTags.length);
            const callees = lineCalls[String(lineNum)];
            const callBtn = callees ? `<button class="line-call-btn" data-line="${lineNum}" title="查看调用的函数">f(${callees.length})</button>` : '';
            return `<span class="line" data-line="${lineNum}">${prefix}${line}${suffix}${callBtn}<button class="line-ai-btn" data-line="${lineNum}" title="AI解释">?</button></span>`;
        });
        return wrappedLines.join('\n');
    },

    /** 渲染代码+高亮 */
    renderCode(detail) {
        const html = this._buildCodeHtml(detail);
        const codeEl = document.getElementById('code-block');
        codeEl.innerHTML = html;
        codeEl.className = 'language-python hljs';
        this.htmlCache.set(detail.id, html);
        document.getElementById('browse-code').scrollTop = 0;
    },

    /**
     * 增强高亮：在 hljs 输出基础上补充函数调用、类名、self/cls、类型注解等
     * 模拟 VSCode One Dark Pro 的语义高亮效果
     */
    _enhanceHighlight(html) {
        const parts = html.split(/(<[^>]*>)/);
        let inSpan = 0;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (part.startsWith('<')) {
                if (part.startsWith('<span class="hljs-')) inSpan++;
                else if (part === '</span>' && inSpan > 0) inSpan--;
                continue;
            }
            if (inSpan > 0) continue;
            let t = part;
            // 1. 函数/方法调用: word( → 高亮为函数色
            t = t.replace(/\b([a-zA-Z_]\w*)\s*(?=\()/g, (m, name) => {
                if (_PY_KEYWORDS.has(name)) return m;
                return `<span class="syn-func-call">${name}</span>`;
            });
            // 2. 大写开头标识符 → 类名（PascalCase）
            t = t.replace(/\b([A-Z][a-zA-Z0-9_]*)\b/g, (m, name) => {
                if (name === name.toUpperCase() && name.length > 1) return m;
                return `<span class="syn-class-name">${name}</span>`;
            });
            // 3. self / cls
            t = t.replace(/\b(self|cls)\b/g, '<span class="syn-self">$1</span>');
            // 4. 装饰器
            t = t.replace(/(@)([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, '<span class="syn-decorator">$1$2</span>');
            // 5. 点号后方法调用
            t = t.replace(/\.([a-zA-Z_]\w*)\s*(?=\()/g, '.<span class="syn-method-call">$1</span>');
            parts[i] = t;
        }
        return parts.join('');
    },

    /** 预加载相邻函数（detail + HTML渲染） */
    _preloadAdjacent(index) {
        // 先预加载下一个(index+1)，再预加载上一个(index-1)
        const indices = [index + 1, index - 1];
        for (const i of indices) {
            if (i < 0 || i >= this.filteredFunctions.length) continue;
            const func = this.filteredFunctions[i];
            if (this.cache.has(func.id) && this.htmlCache.has(func.id)) continue;
            const schedFn = typeof requestIdleCallback === 'function'
                ? (fn) => requestIdleCallback(fn, { timeout: 3000 })
                : (fn) => setTimeout(fn, 100);
            schedFn(() => {
                this._preloadOne(func).catch(() => {});
            });
        }
    },

    /** 预加载单个函数 */
    async _preloadOne(func) {
        let detail = this.cache.get(func.id);
        if (!detail) {
            detail = await API.getFunctionDetail(func.id);
            this.cache.set(func.id, detail);
        }
        if (!this.htmlCache.has(func.id)) {
            const schedFn = typeof requestIdleCallback === 'function'
                ? (fn) => requestIdleCallback(fn, { timeout: 3000 })
                : (fn) => setTimeout(fn, 100);
            schedFn(() => {
                this._preRenderHtml(detail);
            });
        }
        AI.preloadExplanation(func.id).catch(() => {});
    },

    /** 预渲染HTML（不操作DOM） */
    _preRenderHtml(detail) {
        this.htmlCache.set(detail.id, this._buildCodeHtml(detail));
    },

    /** 上一个函数 */
    prev() {
        if (this.currentIndex > 0) {
            this.showFunction(this.currentIndex - 1);
        }
    },

    /** 下一个函数 */
    next() {
        if (this.currentIndex < this.filteredFunctions.length - 1) {
            this.showFunction(this.currentIndex + 1);
        }
    },

    /** 更新导航栏 */
    _updateNav() {
        const total = this.filteredFunctions.length;
        const current = total > 0 ? this.currentIndex + 1 : 0;
        document.getElementById('nav-counter').textContent =
            `${current}/${total}` + (this._unreadCount > 0 ? ` (未读${this._unreadCount})` : '');
        document.getElementById('btn-prev').disabled = this.currentIndex <= 0;
        document.getElementById('btn-next').disabled = this.currentIndex >= total - 1;
    },

    /** 显示骨架屏加载占位 */
    _showSkeleton() {
        const codeEl = document.getElementById('code-block');
        const lines = Array.from({length: 8}, (_, i) => {
            const w = 40 + Math.random() * 50; // 40%-90% 宽度随机
            return `<span class="skeleton-line" style="width:${w}%"></span>`;
        });
        codeEl.innerHTML = lines.join('\n');
        codeEl.className = 'language-python';
    },

    /** 渲染空状态 */
    _renderEmpty() {
        document.getElementById('func-qualified-name').textContent = '';
        document.getElementById('func-file-info').textContent = '';
        document.getElementById('code-block').innerHTML = '<span class="code-empty">暂无函数</span>';
        document.getElementById('nav-counter').textContent = '0/0';
        document.getElementById('btn-prev').disabled = true;
        document.getElementById('btn-next').disabled = true;
        Notes.render([], null, this.projectId);
    },

    /** 绑定事件（只绑定一次） */
    _bindEvents() {
        if (this._bound) return;
        this._bound = true;

        // 侧边栏函数点击 - 事件委托
        const sidebarList = document.getElementById('sidebar-func-list');
        if (sidebarList) {
            sidebarList.addEventListener('click', (e) => {
                const item = e.target.closest('.sidebar-func-item');
                if (!item) return;
                const funcId = parseInt(item.dataset.funcId);
                const idx = this.filteredFunctions.findIndex(f => f.id === funcId);
                if (idx >= 0) {
                    this.showFunction(idx);
                }
            });
        }

        // 侧边栏搜索
        const sidebarSearch = document.getElementById('sidebar-search');
        if (sidebarSearch) {
            let searchTimer = null;
            sidebarSearch.addEventListener('input', () => {
                if (searchTimer) clearTimeout(searchTimer);
                searchTimer = setTimeout(() => {
                    const query = sidebarSearch.value.trim().toLowerCase();
                    const items = document.querySelectorAll('#sidebar-func-list .sidebar-func-item');
                    const headers = document.querySelectorAll('#sidebar-func-list .sidebar-file-header');

                    if (!query) {
                        // 显示全部
                        items.forEach(el => el.style.display = '');
                        headers.forEach(el => el.style.display = '');
                        return;
                    }

                    // 隐藏不匹配的
                    const visibleFiles = new Set();
                    items.forEach(el => {
                        const name = el.querySelector('.sidebar-func-name');
                        const fullName = name ? name.getAttribute('title').toLowerCase() : '';
                        const matches = fullName.includes(query);
                        el.style.display = matches ? '' : 'none';
                        if (matches) {
                            // 找到所属文件头
                            let prev = el.previousElementSibling;
                            while (prev && !prev.classList.contains('sidebar-file-header')) {
                                prev = prev.previousElementSibling;
                            }
                            if (prev) visibleFiles.add(prev);
                        }
                    });
                    headers.forEach(el => {
                        el.style.display = visibleFiles.has(el) ? '' : 'none';
                    });
                }, 200); // 200ms debounce
            });
        }

        document.getElementById('btn-prev').addEventListener('click', () => this.prev());
        document.getElementById('btn-next').addEventListener('click', () => this.next());

        // 菜单按钮
        document.getElementById('browse-menu-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const menu = document.getElementById('browse-menu');
            menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        });

        // 点击其他地方关闭菜单
        document.addEventListener('click', () => {
            document.getElementById('browse-menu').style.display = 'none';
        });

        // 筛选有备注的函数
        document.getElementById('filter-has-notes').addEventListener('change', (e) => {
            this.filterHasNotes = e.target.checked;
            this._applyFilter();
            if (this.filteredFunctions.length > 0) {
                // 尝试保持当前函数
                if (this.currentDetail) {
                    const idx = this.filteredFunctions.findIndex(f => f.id === this.currentDetail.id);
                    if (idx >= 0) {
                        this.showFunction(idx);
                    } else {
                        this.showFunction(0);
                    }
                } else {
                    this.showFunction(0);
                }
            } else {
                this._renderEmpty();
            }
            document.getElementById('browse-menu').style.display = 'none';
        });

        // 筛选未读函数
        document.getElementById('filter-unread').addEventListener('change', (e) => {
            this.filterUnread = e.target.checked;
            this._applyFilter();
            if (this.filteredFunctions.length > 0) {
                if (this.currentDetail) {
                    const idx = this.filteredFunctions.findIndex(f => f.id === this.currentDetail.id);
                    if (idx >= 0) {
                        this.showFunction(idx);
                    } else {
                        this.showFunction(0);
                    }
                } else {
                    this.showFunction(0);
                }
            } else {
                this._renderEmpty();
            }
            document.getElementById('browse-menu').style.display = 'none';
        });

        // 刷新代码（重新扫描）
        document.getElementById('btn-rescan').addEventListener('click', () => {
            document.getElementById('browse-menu').style.display = 'none';
            this._rescan();
        });

        // 返回按钮
        document.getElementById('browse-back').addEventListener('click', () => {
            location.hash = '#/';
        });

        // 底部导航按钮
        document.getElementById('btn-goto-graph').addEventListener('click', () => {
            location.hash = `#/project/${this.projectId}/graph`;
        });
        document.getElementById('btn-goto-list').addEventListener('click', () => {
            location.hash = `#/project/${this.projectId}/list`;
        });
        document.getElementById('btn-goto-export').addEventListener('click', () => {
            location.hash = `#/project/${this.projectId}/export`;
        });

        // 行级调用信息 + AI行级解释 - 事件委托
        document.getElementById('code-block').addEventListener('click', (e) => {
            const callBtn = e.target.closest('.line-call-btn');
            if (callBtn) {
                e.stopPropagation();
                const lineNum = callBtn.dataset.line;
                const lineEl = callBtn.closest('.line');
                if (!lineEl || !Browse.currentDetail) return;
                const lineCalls = Browse.currentDetail.line_calls || {};
                const callees = lineCalls[lineNum];
                if (!callees || callees.length === 0) return;

                // 切换展开/折叠
                const existing = lineEl.nextElementSibling;
                if (existing && existing.classList.contains('line-call-info')) {
                    existing.remove();
                    callBtn.classList.remove('active');
                    return;
                }

                // 创建展开区
                const infoDiv = document.createElement('span');
                infoDiv.className = 'line-call-info';
                infoDiv.style.display = 'block';
                const items = callees.map(c => {
                    const ds = c.docstring ? `<span class="line-call-doc">${Browse._escapeHtml(c.docstring)}</span>` : '<span class="line-call-doc no-doc">无文档说明</span>';
                    return `<span class="line-call-item" data-func-id="${c.id}"><span class="line-call-name">${Browse._escapeHtml(c.qualified_name)}</span><span class="line-call-file">${Browse._escapeHtml(c.file_path)}</span>${ds}</span>`;
                }).join('');
                infoDiv.innerHTML = items;
                lineEl.after(infoDiv);
                callBtn.classList.add('active');

                // 点击函数名跳转
                infoDiv.addEventListener('click', (ev) => {
                    const item = ev.target.closest('.line-call-item');
                    if (!item) return;
                    const funcId = parseInt(item.dataset.funcId);
                    const idx = Browse.filteredFunctions.findIndex(f => f.id === funcId);
                    if (idx >= 0) {
                        Browse.showFunction(idx);
                    } else {
                        // 不在当前筛选列表中，尝试在全部函数中查找
                        const allIdx = Browse.functions.findIndex(f => f.id === funcId);
                        if (allIdx >= 0) {
                            // 临时取消筛选
                            Browse.filterHasNotes = false;
                            Browse.filterUnread = false;
                            document.getElementById('filter-has-notes').checked = false;
                            document.getElementById('filter-unread').checked = false;
                            Browse._applyFilter();
                            const newIdx = Browse.filteredFunctions.findIndex(f => f.id === funcId);
                            if (newIdx >= 0) Browse.showFunction(newIdx);
                        }
                    }
                });
                return;
            }

            // AI行级解释
            const aiBtn = e.target.closest('.line-ai-btn');
            if (!aiBtn) return;
            e.stopPropagation();
            const lineNum = parseInt(aiBtn.dataset.line);
            const lineEl = aiBtn.closest('.line');
            if (!lineEl || !Browse.currentDetail) return;
            // 获取该行纯文本内容
            const lineContent = lineEl.textContent.replace(/\?$/, '').trim();
            AI.explainLine(Browse.currentDetail.id, lineNum, lineContent, lineEl);
        });

        // AI解读面板切换
        document.getElementById('ai-toggle').addEventListener('click', (e) => {
            if (e.target.closest('.ai-refresh-btn')) return; // 让刷新按钮独立处理
            AI.toggle();
        });

        // AI解读刷新按钮
        document.getElementById('ai-refresh-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            AI.refreshExplanation();
        });

        // AI备注按钮
        document.getElementById('btn-ai-notes').addEventListener('click', () => {
            if (!Browse.currentDetail) return;
            AI.generateNotes(Browse.currentDetail.id, Browse.projectId);
        });

        // 键盘快捷键（左右箭头）
        document.addEventListener('keydown', (e) => {
            if (document.getElementById('view-browse').style.display === 'none') return;
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                this.prev();
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                this.next();
            }
        });
    },

    /** 重新扫描项目代码 */
    async _rescan() {
        const overlay = document.getElementById('loading-overlay');
        overlay.style.display = 'flex';
        try {
            await API.rescanProject(this.projectId);
            // 清缓存，重新加载函数列表
            this.cache.clear();
            this.htmlCache.clear();
            await this.loadFunctionList();
            this._updateNav();
            // 尝试保持当前函数
            if (this.currentDetail) {
                const idx = this.filteredFunctions.findIndex(
                    f => f.qualified_name === this.currentDetail.qualified_name
                );
                if (idx >= 0) {
                    this.cache.delete(this.filteredFunctions[idx].id);
                    await this.showFunction(idx);
                } else if (this.filteredFunctions.length > 0) {
                    await this.showFunction(0);
                } else {
                    this._renderEmpty();
                }
            } else if (this.filteredFunctions.length > 0) {
                await this.showFunction(0);
            } else {
                this._renderEmpty();
            }
        } catch (err) {
            document.getElementById('code-block').textContent = '刷新失败: ' + err.message;
        } finally {
            overlay.style.display = 'none';
        }
    },

    /** 渲染侧边栏函数列表（按文件分组） */
    _renderSidebar() {
        const listEl = document.getElementById('sidebar-func-list');
        if (!listEl) return;

        const funcs = this.filteredFunctions;
        if (funcs.length === 0) {
            listEl.innerHTML = '<div style="padding:16px;color:var(--text-secondary);font-size:13px;">暂无函数</div>';
            return;
        }

        // 按文件分组
        const groups = new Map();
        for (const f of funcs) {
            const file = f.file_path || '未知文件';
            if (!groups.has(file)) groups.set(file, []);
            groups.get(file).push(f);
        }

        let html = '';
        for (const [file, items] of groups) {
            // 只显示文件名最后两级路径
            const shortPath = file.split('/').slice(-2).join('/');
            html += `<div class="sidebar-file-header" title="${this._escapeHtml(file)}">${this._escapeHtml(shortPath)}</div>`;
            for (const f of items) {
                const isActive = this.currentDetail && this.currentDetail.id === f.id;
                const isRead = f.is_read;
                const hasNotes = f.has_notes || f.note_count > 0;

                // 只显示简短函数名（不含模块前缀）
                const shortName = f.qualified_name.includes('.')
                    ? f.qualified_name.split('.').slice(-1)[0]
                    : f.qualified_name;

                let badges = '';
                if (!isRead) badges += '<span class="sidebar-func-badge unread">新</span>';
                if (hasNotes) badges += '<span class="sidebar-func-badge has-notes">备注</span>';

                html += `<div class="sidebar-func-item${isActive ? ' active' : ''}${isRead ? ' read' : ''}" data-func-id="${f.id}">
                    <span class="sidebar-func-name" title="${this._escapeHtml(f.qualified_name)}">${this._escapeHtml(shortName)}</span>
                    ${badges}
                </div>`;
            }
        }
        listEl.innerHTML = html;
    },

    /** 更新侧边栏中的active状态（不重新渲染整个列表） */
    _updateSidebarActive() {
        const listEl = document.getElementById('sidebar-func-list');
        if (!listEl) return;

        const items = listEl.querySelectorAll('.sidebar-func-item');
        const currentId = this.currentDetail ? this.currentDetail.id : null;

        for (const item of items) {
            const funcId = parseInt(item.dataset.funcId);
            if (funcId === currentId) {
                item.classList.add('active');
                // 滚动到可见区域
                item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            } else {
                item.classList.remove('active');
            }
        }

        // 同时更新已读状态
        const func = this.filteredFunctions[this.currentIndex];
        if (func && func.is_read) {
            const item = listEl.querySelector(`.sidebar-func-item[data-func-id="${func.id}"]`);
            if (item && !item.classList.contains('read')) {
                item.classList.add('read');
                // 移除未读标记
                const unreadBadge = item.querySelector('.sidebar-func-badge.unread');
                if (unreadBadge) unreadBadge.remove();
            }
        }
    },

    /** HTML转义 */
    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },
};
