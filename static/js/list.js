/**
 * 函数列表模块
 * 按文件分组显示、搜索过滤
 */
const List = {
    projectId: null,
    functions: [],
    _debounceTimer: null,

    /**
     * 初始化函数列表
     * @param {number} projectId
     */
    async init(projectId) {
        this.projectId = projectId;
        this._bindEvents();

        const searchInput = document.getElementById('list-search-input');
        searchInput.value = '';

        try {
            this.functions = await API.getAllFunctions(projectId);
        } catch (err) {
            document.getElementById('list-body').innerHTML =
                `<div class="empty-state"><p>加载失败: ${err.message}</p></div>`;
            return;
        }

        this._renderList(this.functions);
    },

    /**
     * 渲染函数列表（按文件分组）
     * @param {Array} functions
     */
    _renderList(functions) {
        const container = document.getElementById('list-body');

        if (functions.length === 0) {
            container.innerHTML = '<div class="empty-state" style="height:50%;"><p>无匹配函数</p></div>';
            return;
        }

        // 按文件分组
        const groups = new Map();
        functions.forEach(f => {
            const file = f.file_path || '未知文件';
            if (!groups.has(file)) groups.set(file, []);
            groups.get(file).push(f);
        });

        let html = '';
        for (const [file, funcs] of groups) {
            html += `<div class="list-file-group">`;
            html += `<div class="list-file-header">${this._escapeHtml(file)}</div>`;
            funcs.forEach(f => {
                const notesBadge = f.note_count > 0
                    ? `<span class="list-func-notes-badge">${f.note_count}</span>`
                    : '';
                html += `
                    <div class="list-func-item" data-func-id="${f.id}">
                        <span class="list-func-name">${this._escapeHtml(f.name)}</span>
                        <span class="list-func-lines">L${f.start_line}-${f.end_line}</span>
                        ${notesBadge}
                    </div>
                `;
            });
            html += `</div>`;
        }

        container.innerHTML = html;

        // 绑定点击事件
        container.querySelectorAll('.list-func-item').forEach(item => {
            item.addEventListener('click', () => {
                const funcId = parseInt(item.dataset.funcId);
                location.hash = `#/project/${this.projectId}/browse?func=${funcId}`;
            });
        });
    },

    /** 搜索过滤 */
    _filterBySearch(keyword) {
        if (!keyword) {
            this._renderList(this.functions);
            return;
        }
        const lower = keyword.toLowerCase();
        const filtered = this.functions.filter(f =>
            f.name.toLowerCase().includes(lower) ||
            f.qualified_name.toLowerCase().includes(lower)
        );
        this._renderList(filtered);
    },

    /** 绑定事件 */
    _bindEvents() {
        if (this._bound) return;
        this._bound = true;

        document.getElementById('list-back').addEventListener('click', () => {
            location.hash = `#/project/${this.projectId}/browse`;
        });

        document.getElementById('list-search-input').addEventListener('keyup', (e) => {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = setTimeout(() => {
                this._filterBySearch(e.target.value.trim());
            }, 300);
        });
    },

    /** HTML转义 */
    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },
};
