/**
 * 备注面板模块
 * 管理函数备注的展开/折叠、增删、渲染
 */
const Notes = {
    currentFunctionId: null,
    currentProjectId: null,
    notes: [],
    expanded: false,

    /** 初始化DOM事件绑定 */
    init() {
        document.getElementById('notes-toggle').addEventListener('click', () => this.toggle());
        document.getElementById('btn-add-note').addEventListener('click', () => this._handleAdd());
        document.getElementById('note-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this._handleAdd();
        });
    },

    /**
     * 渲染备注面板
     * @param {Array} notes - 备注列表
     * @param {number} functionId
     * @param {number} projectId
     */
    render(notes, functionId, projectId) {
        this.notes = notes || [];
        this.currentFunctionId = functionId;
        this.currentProjectId = projectId;
        this._updateToggleText();
        this._renderList();
    },

    /** 切换面板展开/折叠 */
    toggle() {
        this.expanded = !this.expanded;
        const body = document.getElementById('notes-body');
        const arrow = document.querySelector('.notes-toggle-arrow');
        body.style.display = this.expanded ? 'block' : 'none';
        if (this.expanded) {
            arrow.classList.add('open');
        } else {
            arrow.classList.remove('open');
        }
    },

    /** 折叠面板 */
    collapse() {
        this.expanded = false;
        document.getElementById('notes-body').style.display = 'none';
        document.querySelector('.notes-toggle-arrow').classList.remove('open');
    },

    /** 更新切换按钮文本 */
    _updateToggleText() {
        document.getElementById('notes-toggle-text').textContent = `备注(${this.notes.length})`;
    },

    /** 渲染备注列表 */
    _renderList() {
        const container = document.getElementById('notes-list');
        if (this.notes.length === 0) {
            container.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;padding:8px 0;">暂无备注</div>';
            return;
        }
        container.innerHTML = this.notes.map(note => `
            <div class="note-item" data-note-id="${note.id}">
                <span class="note-type-badge ${note.note_type}">${this._typeLabel(note.note_type)}</span>${note.source === 'ai' ? '<span class="note-ai-badge">AI</span>' : ''}
                <div style="flex:1;">
                    <div class="note-content">${this._escapeHtml(note.content)}</div>
                    <div class="note-time">${this._formatTime(note.created_at)}</div>
                </div>
                <button class="note-delete" data-note-id="${note.id}" title="删除">&times;</button>
            </div>
        `).join('');

        // 绑定删除事件
        container.querySelectorAll('.note-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._handleDelete(parseInt(btn.dataset.noteId));
            });
        });
    },

    /** 处理添加备注 */
    async _handleAdd() {
        const input = document.getElementById('note-input');
        const content = input.value.trim();
        if (!content) return;
        const noteType = document.getElementById('note-type-select').value;
        try {
            const note = await API.addNote(this.currentFunctionId, this.currentProjectId, content, noteType);
            this.notes.push(note);
            this._updateToggleText();
            this._renderList();
            input.value = '';
            // 同步更新Browse的缓存中该函数的notes
            if (typeof Browse !== 'undefined' && Browse.currentDetail) {
                Browse.currentDetail.notes = [...this.notes];
                Browse.cache.set(Browse.currentDetail.id, Browse.currentDetail);
                // 同步更新函数列表中的note_count
                const funcItem = Browse.functions.find(f => f.id === this.currentFunctionId);
                if (funcItem) {
                    funcItem.note_count = this.notes.length;
                    funcItem.has_notes = this.notes.length > 0;
                }
            }
        } catch (err) {
            alert('添加备注失败: ' + err.message);
        }
    },

    /** 处理删除备注 */
    async _handleDelete(noteId) {
        if (!confirm('确定删除这条备注？')) return;
        try {
            await API.deleteNote(noteId);
            this.notes = this.notes.filter(n => n.id !== noteId);
            this._updateToggleText();
            this._renderList();
            // 同步更新Browse的缓存
            if (typeof Browse !== 'undefined' && Browse.currentDetail) {
                Browse.currentDetail.notes = [...this.notes];
                Browse.cache.set(Browse.currentDetail.id, Browse.currentDetail);
                const funcItem = Browse.functions.find(f => f.id === this.currentFunctionId);
                if (funcItem) {
                    funcItem.note_count = this.notes.length;
                    funcItem.has_notes = this.notes.length > 0;
                }
            }
        } catch (err) {
            alert('删除备注失败: ' + err.message);
        }
    },

    /** 备注类型标签 */
    _typeLabel(type) {
        const map = {
            general: '通用',
            bug: 'Bug',
            todo: 'TODO',
            refactor: '重构',
            question: '疑问',
        };
        return map[type] || type;
    },

    /** 格式化时间 */
    _formatTime(isoStr) {
        if (!isoStr) return '';
        try {
            const d = new Date(isoStr);
            return d.toLocaleString('zh-CN', {
                month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit',
            });
        } catch (_) {
            return isoStr;
        }
    },

    /** HTML转义 */
    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },
};
