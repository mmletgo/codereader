/**
 * 导出模块
 * 支持JSON/Markdown格式预览和下载
 */
const Export = {
    projectId: null,
    currentFormat: 'json',
    cachedData: {},  // format -> content string

    /**
     * 初始化导出页面
     * @param {number} projectId
     */
    async init(projectId) {
        this.projectId = projectId;
        this.currentFormat = 'json';
        this.cachedData = {};
        this._bindEvents();
        this._updateFormatButtons();
        await this._loadPreview();
    },

    /** 加载预览内容 */
    async _loadPreview() {
        const preview = document.getElementById('export-preview');
        preview.textContent = '加载中...';

        if (this.cachedData[this.currentFormat]) {
            preview.textContent = this.cachedData[this.currentFormat];
            return;
        }

        try {
            const data = await API.getExport(this.projectId, this.currentFormat);
            let content;
            if (this.currentFormat === 'json') {
                content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
            } else {
                // markdown格式可能直接返回字符串
                content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
            }
            this.cachedData[this.currentFormat] = content;
            preview.textContent = content;
        } catch (err) {
            preview.textContent = '加载失败: ' + err.message;
        }
    },

    /** 切换格式 */
    async _switchFormat(format) {
        if (format === this.currentFormat) return;
        this.currentFormat = format;
        this._updateFormatButtons();
        await this._loadPreview();
    },

    /** 更新格式按钮状态 */
    _updateFormatButtons() {
        document.getElementById('btn-format-json').classList.toggle('active', this.currentFormat === 'json');
        document.getElementById('btn-format-md').classList.toggle('active', this.currentFormat === 'markdown');
    },

    /** 下载文件（同时保存到服务端） */
    async _download() {
        const content = this.cachedData[this.currentFormat];
        if (!content) {
            alert('暂无内容可下载');
            return;
        }

        const isJson = this.currentFormat === 'json';
        const mimeType = isJson ? 'application/json' : 'text/markdown';
        const ext = isJson ? 'json' : 'md';
        const filename = `codereader-export.${ext}`;

        // 客户端下载
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);

        // 同步保存到服务端
        try {
            await API.saveExport(this.projectId, this.currentFormat);
        } catch (_) { /* 静默 */ }
    },

    /** 清空项目所有备注 */
    async _clearNotes() {
        if (!confirm('确定清空该项目的所有备注？此操作不可恢复。')) return;
        try {
            await API.clearProjectNotes(this.projectId);
            this.cachedData = {};
            await this._loadPreview();
        } catch (err) {
            alert('清空失败: ' + err.message);
        }
    },

    /** 绑定事件 */
    _bindEvents() {
        if (this._bound) return;
        this._bound = true;

        document.getElementById('export-back').addEventListener('click', () => {
            location.hash = `#/project/${this.projectId}/browse`;
        });

        document.getElementById('btn-format-json').addEventListener('click', () => {
            this._switchFormat('json');
        });

        document.getElementById('btn-format-md').addEventListener('click', () => {
            this._switchFormat('markdown');
        });

        document.getElementById('btn-download').addEventListener('click', () => {
            this._download();
        });

        document.getElementById('btn-clear-notes').addEventListener('click', () => {
            this._clearNotes();
        });
    },
};
