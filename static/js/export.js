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

    /** 下载文件 */
    _download() {
        const content = this.cachedData[this.currentFormat];
        if (!content) {
            alert('暂无内容可下载');
            return;
        }

        const isJson = this.currentFormat === 'json';
        const mimeType = isJson ? 'application/json' : 'text/markdown';
        const ext = isJson ? 'json' : 'md';
        const filename = `codereader-export.${ext}`;

        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
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
    },
};
