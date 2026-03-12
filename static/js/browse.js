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
        await this._loadProject();
        await this.loadFunctionList();

        // 加载阅读进度
        let resumeFuncId = funcId;
        if (!resumeFuncId) {
            try {
                const progress = await API.getProgress(projectId);
                if (progress.last_function_id) {
                    resumeFuncId = progress.last_function_id;
                }
            } catch (_) { /* 忽略 */ }
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
    },

    /**
     * 切换到指定索引的函数
     * @param {number} index - filteredFunctions中的索引
     */
    async showFunction(index) {
        if (index < 0 || index >= this.filteredFunctions.length) return;
        this.currentIndex = index;
        const func = this.filteredFunctions[index];

        // 先尝试缓存
        let detail = this.cache.get(func.id);
        if (!detail) {
            try {
                detail = await API.getFunctionDetail(func.id);
                this.cache.set(func.id, detail);
            } catch (err) {
                document.getElementById('code-block').textContent = '加载失败: ' + err.message;
                return;
            }
        }

        this.currentDetail = detail;
        this._renderInfo(detail);

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

    /** 渲染代码+高亮 */
    renderCode(detail) {
        const codeEl = document.getElementById('code-block');
        const startLine = detail.start_line;

        // 先用 hljs.highlight 程序化高亮整段代码
        let highlighted = hljs.highlight(detail.body, { language: 'python' }).value;

        // 补充 hljs 缺失的语义高亮（模拟 VSCode One Dark Pro）
        highlighted = this._enhanceHighlight(highlighted);

        // 将高亮后的HTML按行拆分，处理跨行span标签
        const rawLines = highlighted.split('\n');
        let openTags = []; // 跟踪跨行未闭合的span标签

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
            return `<span class="line" data-line="${lineNum}">${prefix}${line}${suffix}<button class="line-ai-btn" data-line="${lineNum}" title="AI解释">?</button></span>`;
        });

        const html = wrappedLines.join('\n');
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
        // 辅助：只替换不在 <span> 标签内部的文本
        const replaceOutsideTags = (str, regex, replacer) => {
            // 将HTML拆分为标签和文本片段
            const parts = str.split(/(<[^>]*>)/);
            let inSpan = 0;
            return parts.map(part => {
                if (part.startsWith('<')) {
                    // 跳过已被hljs高亮的内容（在hljs span内部不做二次处理）
                    if (part.startsWith('<span class="hljs-')) inSpan++;
                    else if (part === '</span>' && inSpan > 0) inSpan--;
                    return part;
                }
                if (inSpan > 0) return part;
                return part.replace(regex, replacer);
            }).join('');
        };

        // 1. 函数/方法调用: word( → 高亮 word 为函数色
        html = replaceOutsideTags(html,
            /\b([a-zA-Z_]\w*)\s*(?=\()/g,
            (m, name) => {
                if (_PY_KEYWORDS.has(name)) return m;
                return `<span class="syn-func-call">${name}</span>`;
            }
        );

        // 2. 大写开头的标识符 → 类名（PascalCase）
        html = replaceOutsideTags(html,
            /\b([A-Z][a-zA-Z0-9_]*)\b/g,
            (m, name) => {
                // 排除全大写常量如 TRUE, FALSE, NONE (已被hljs处理), 和单字母
                if (name === name.toUpperCase() && name.length > 1) return m;
                return `<span class="syn-class-name">${name}</span>`;
            }
        );

        // 3. self / cls 关键字
        html = replaceOutsideTags(html,
            /\b(self|cls)\b/g,
            '<span class="syn-self">$1</span>'
        );

        // 4. 装饰器 @ 符号后的名称（hljs可能已处理，作为补充）
        html = replaceOutsideTags(html,
            /(@)([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g,
            '<span class="syn-decorator">$1$2</span>'
        );

        // 5. 点号后的方法/属性名
        html = replaceOutsideTags(html,
            /\.([a-zA-Z_]\w*)\s*(?=\()/g,
            '.<span class="syn-method-call">$1</span>'
        );

        return html;
    },

    /** 预加载相邻函数（detail + HTML渲染） */
    _preloadAdjacent(index) {
        const indices = [index - 1, index + 1];
        for (const i of indices) {
            if (i < 0 || i >= this.filteredFunctions.length) continue;
            const func = this.filteredFunctions[i];
            if (this.cache.has(func.id) && this.htmlCache.has(func.id)) continue;
            // 异步预加载，不阻塞当前渲染
            this._preloadOne(func).catch(() => {});
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
            this._preRenderHtml(detail);
        }
        AI.preloadExplanation(func.id).catch(() => {});
    },

    /** 预渲染HTML（不操作DOM） */
    _preRenderHtml(detail) {
        const startLine = detail.start_line;
        let highlighted = hljs.highlight(detail.body, { language: 'python' }).value;
        highlighted = this._enhanceHighlight(highlighted);

        const rawLines = highlighted.split('\n');
        let openTags = [];
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
            return `<span class="line" data-line="${lineNum}">${prefix}${line}${suffix}<button class="line-ai-btn" data-line="${lineNum}" title="AI解释">?</button></span>`;
        });
        this.htmlCache.set(detail.id, wrappedLines.join('\n'));
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

        // AI行级解释 - 事件委托
        document.getElementById('code-block').addEventListener('click', (e) => {
            const btn = e.target.closest('.line-ai-btn');
            if (!btn) return;
            e.stopPropagation();
            const lineNum = parseInt(btn.dataset.line);
            const lineEl = btn.closest('.line');
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

    /** HTML转义 */
    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },
};
