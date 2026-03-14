/**
 * AI辅助分析模块
 * 管理函数解读、行级解释、自动备注
 */
const AI = {
    explanationCache: new Map(),    // functionId -> { explanation, hash }
    _pendingRequests: new Map(),    // functionId -> Promise (防重复请求)
    expanded: false,

    /**
     * 获取函数AI解读（带缓存+防重复）
     * @param {number} functionId
     * @returns {Promise<{explanation: string, cached: boolean}>}
     */
    async getExplanation(functionId) {
        // 检查前端缓存
        if (this.explanationCache.has(functionId)) {
            return { explanation: this.explanationCache.get(functionId), cached: true };
        }

        // 防重复请求
        if (this._pendingRequests.has(functionId)) {
            return this._pendingRequests.get(functionId);
        }

        const promise = API.getAIExplanation(functionId).then(data => {
            this.explanationCache.set(functionId, data.explanation);
            this._pendingRequests.delete(functionId);
            return data;
        }).catch(err => {
            this._pendingRequests.delete(functionId);
            throw err;
        });

        this._pendingRequests.set(functionId, promise);
        return promise;
    },

    /**
     * 静默预加载函数解读
     * @param {number} functionId
     */
    async preloadExplanation(functionId) {
        if (this.explanationCache.has(functionId) || this._pendingRequests.has(functionId)) {
            return;
        }
        // 静默加载，不影响UI
        this.getExplanation(functionId).catch(() => {});
    },

    /**
     * 渲染AI解读面板内容
     * @param {number} functionId
     */
    renderExplanation(functionId) {
        const body = document.getElementById('ai-explanation-body');
        const refreshBtn = document.getElementById('ai-refresh-btn');

        if (this.explanationCache.has(functionId)) {
            body.innerHTML = this._renderMarkdown(this.explanationCache.get(functionId));
            refreshBtn.disabled = false;
        } else {
            body.innerHTML = '<div class="ai-loading">正在生成AI解读...</div>';
            refreshBtn.disabled = true;
            this.getExplanation(functionId).then(data => {
                // 确认仍是当前函数
                if (Browse.currentDetail && Browse.currentDetail.id === functionId) {
                    body.innerHTML = this._renderMarkdown(data.explanation);
                    refreshBtn.disabled = false;
                }
            }).catch(err => {
                if (Browse.currentDetail && Browse.currentDetail.id === functionId) {
                    body.innerHTML = `<div class="ai-error">AI解读失败: ${err.message}</div>`;
                    refreshBtn.disabled = false;
                }
            });
        }
    },

    /**
     * 强制刷新当前函数的AI解读
     */
    async refreshExplanation() {
        if (typeof Offline !== 'undefined' && !Offline.isOnline) {
            return;
        }
        if (!Browse.currentDetail) return;
        const functionId = Browse.currentDetail.id;
        // 清除缓存，强制重新生成
        this.explanationCache.delete(functionId);
        this._pendingRequests.delete(functionId);
        this.renderExplanation(functionId);
    },

    /**
     * 切换AI解读面板展开/折叠
     */
    toggle() {
        this.expanded = !this.expanded;
        const body = document.getElementById('ai-panel-body');
        const arrow = document.querySelector('.ai-toggle-arrow');
        body.style.display = this.expanded ? 'block' : 'none';
        if (this.expanded) {
            arrow.classList.add('open');
        } else {
            arrow.classList.remove('open');
        }
    },

    /**
     * 强制折叠AI解读面板
     */
    collapse() {
        this.expanded = false;
        const panelBody = document.getElementById('ai-panel-body');
        if (panelBody) {
            panelBody.style.display = 'none';
            const arrow = document.querySelector('.ai-toggle-arrow');
            if (arrow) arrow.classList.remove('open');
        }
    },

    /**
     * 行级代码解释
     * @param {number} functionId
     * @param {number} lineNum
     * @param {string} lineContent
     * @param {HTMLElement} lineEl - 行元素
     */
    async explainLine(functionId, lineNum, lineContent, lineEl) {
        if (typeof Offline !== 'undefined' && !Offline.isOnline) {
            return; // 离线不支持行级解释
        }
        // 检查是否已有解释展开 → 切换关闭
        const existing = lineEl.nextElementSibling;
        if (existing && existing.classList.contains('line-ai-explanation')) {
            existing.remove();
            return;
        }

        // 创建解释容器
        const explDiv = document.createElement('div');
        explDiv.className = 'line-ai-explanation';
        explDiv.innerHTML = '<span class="ai-line-loading">正在分析...</span>';

        // 在行元素后插入
        lineEl.after(explDiv);

        try {
            const data = await API.getAILineExplain(functionId, lineNum, lineContent);
            explDiv.innerHTML = `<span class="ai-line-text">${this._escapeHtml(data.explanation)}</span>`;
        } catch (err) {
            explDiv.innerHTML = `<span class="ai-line-error">解释失败: ${err.message}</span>`;
        }
    },

    /**
     * 生成AI自动备注
     * @param {number} functionId
     * @param {number} projectId
     */
    async generateNotes(functionId, projectId) {
        if (typeof Offline !== 'undefined' && !Offline.isOnline) {
            alert('离线模式不支持AI自动备注');
            return;
        }
        const btn = document.getElementById('btn-ai-notes');
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '生成中...';

        try {
            const data = await API.generateAINotes(functionId, projectId);
            if (data.notes && data.notes.length > 0) {
                // 追加到Notes模块
                for (const note of data.notes) {
                    Notes.notes.push(note);
                }
                Notes._updateToggleText();
                Notes._renderList();
                // 同步Browse缓存
                if (Browse.currentDetail) {
                    Browse.currentDetail.notes = [...Notes.notes];
                    Browse.cache.set(Browse.currentDetail.id, Browse.currentDetail);
                    const funcItem = Browse.functions.find(f => f.id === functionId);
                    if (funcItem) {
                        funcItem.note_count = Notes.notes.length;
                        funcItem.has_notes = Notes.notes.length > 0;
                    }
                }
            }
        } catch (err) {
            // 用行内提示而非alert
            const notesList = document.getElementById('notes-list');
            const errDiv = document.createElement('div');
            errDiv.style.cssText = 'color:var(--accent-danger);font-size:13px;padding:8px 0;';
            errDiv.textContent = 'AI备注生成失败: ' + err.message;
            notesList.prepend(errDiv);
            setTimeout(() => errDiv.remove(), 5000);
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    },

    /**
     * 简单Markdown渲染（h3, 列表, 段落, 加粗, 行内代码）
     */
    _renderMarkdown(text) {
        if (!text) return '';
        return text
            // 代码块（多行）
            .replace(/```[\s\S]*?```/g, match => {
                const code = match.replace(/```\w*\n?/, '').replace(/\n?```$/, '');
                return `<pre class="ai-code-block"><code>${this._escapeHtml(code)}</code></pre>`;
            })
            // h3标题
            .replace(/^### (.+)$/gm, '<h4 class="ai-heading">$1</h4>')
            // h2标题
            .replace(/^## (.+)$/gm, '<h3 class="ai-heading">$1</h3>')
            // h1标题
            .replace(/^# (.+)$/gm, '<h3 class="ai-heading">$1</h3>')
            // 加粗
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            // 行内代码
            .replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>')
            // 编号列表
            .replace(/^\d+\.\s+(.+)$/gm, '<li class="ai-list-item">$1</li>')
            // 无序列表
            .replace(/^[-*]\s+(.+)$/gm, '<li class="ai-list-item">$1</li>')
            // 连续li包裹ul
            .replace(/((?:<li class="ai-list-item">.*<\/li>\n?)+)/g, '<ul class="ai-list">$1</ul>')
            // 段落（非空行，非标签开头）
            .replace(/^(?!<[hul]|<li|<pre)(.+)$/gm, '<p class="ai-paragraph">$1</p>')
            // 清理多余空行
            .replace(/\n{3,}/g, '\n\n');
    },

    /** HTML转义 */
    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },
};
