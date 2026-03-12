/**
 * 函数浏览器模块
 * 核心页面：左右切换函数、代码高亮、行号显示
 */
const Browse = {
    projectId: null,
    projectName: '',
    functions: [],         // [{id, name, qualified_name, ...}] 排好序的函数列表
    filteredFunctions: [], // 筛选后的函数列表（如"只看有备注的"）
    currentIndex: 0,       // 当前在filteredFunctions中的索引
    currentDetail: null,   // 当前函数详情缓存
    cache: new Map(),      // id -> detail 缓存
    filterHasNotes: false, // 是否筛选有备注的
    readSet: new Set(),    // 已读函数ID集合
    _saveTimer: null,      // 防抖保存定时器

    /**
     * 初始化浏览器
     * @param {number} projectId
     * @param {number|null} funcId - 可选，直接跳转到指定函数
     */
    async init(projectId, funcId) {
        this.projectId = projectId;
        this.cache.clear();
        this.readSet.clear();
        this.filterHasNotes = false;
        document.getElementById('filter-has-notes').checked = false;
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
                if (progress.read_function_ids) {
                    this.readSet = new Set(progress.read_function_ids);
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
        this._applyFilter();
    },

    /** 应用筛选 */
    _applyFilter() {
        if (this.filterHasNotes) {
            this.filteredFunctions = this.functions.filter(f => f.has_notes || f.note_count > 0);
        } else {
            this.filteredFunctions = [...this.functions];
        }
    },

    /**
     * 切换到指定索引的函数
     * @param {number} index - filteredFunctions中的索引
     */
    async showFunction(index) {
        if (index < 0 || index >= this.filteredFunctions.length) return;
        this.currentIndex = index;
        const func = this.filteredFunctions[index];
        this._updateNav();

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
        this.renderCode(detail);
        Notes.collapse();
        Notes.render(detail.notes, detail.id, this.projectId);

        // 标记已读并保存进度
        this.readSet.add(func.id);
        this._updateNav();
        this._debounceSaveProgress();
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
            await API.saveProgress(
                this.projectId,
                func.id,
                [...this.readSet]
            );
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
            return `<span class="line" data-line="${lineNum}">${prefix}${line}${suffix}</span>`;
        });

        codeEl.innerHTML = wrappedLines.join('\n');
        codeEl.className = 'language-python hljs';

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
                // 排除已被 hljs 处理的关键字
                const kwSet = new Set(['if','else','elif','for','while','with','as','try','except',
                    'finally','raise','return','yield','import','from','class','def','and','or',
                    'not','in','is','lambda','pass','break','continue','del','assert','global',
                    'nonlocal','async','await','print']);
                if (kwSet.has(name)) return m;
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
        const readCount = this.filteredFunctions.filter(f => this.readSet.has(f.id)).length;
        document.getElementById('nav-counter').textContent = `${current}/${total} (已读${readCount})`;
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

    /** HTML转义 */
    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },
};
