/**
 * AI对话模块
 * 管理函数级AI对话界面和逻辑
 */
const Chat = {
    functionId: null,
    messages: [],
    isOpen: false,
    isSending: false,
    funcBodyChanged: false,
    _userScrolled: false,

    /** 打开对话面板 */
    async open(functionId) {
        if (!functionId) return;
        this.functionId = functionId;
        this.isOpen = true;
        this._userScrolled = false;

        const overlay = document.getElementById('chat-overlay');
        overlay.style.display = 'flex';

        // 显示函数名
        const func = Browse.currentDetail;
        document.getElementById('chat-func-name').textContent =
            func ? func.qualified_name : '';

        // 加载历史
        await this._loadHistory();
        this._updateSendState();
    },

    /** 关闭对话面板 */
    close() {
        this.isOpen = false;
        document.getElementById('chat-overlay').style.display = 'none';
    },

    /** 加载对话历史 */
    async _loadHistory() {
        const messagesEl = document.getElementById('chat-messages');
        messagesEl.innerHTML = '<div class="chat-typing"><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div></div>';

        try {
            const data = await API.getChatHistory(this.functionId);
            this.messages = data.messages || [];
            this.funcBodyChanged = data.func_body_changed;
            this._render();
        } catch (err) {
            messagesEl.innerHTML = `<div class="chat-empty"><span class="chat-empty-text">加载对话失败: ${err.message}</span></div>`;
        }
    },

    /** 渲染对话界面 */
    _render() {
        // 变更提示
        const changedEl = document.getElementById('chat-body-changed');
        changedEl.style.display = this.funcBodyChanged ? 'flex' : 'none';

        const messagesEl = document.getElementById('chat-messages');

        if (this.messages.length === 0) {
            // 空状态 + 预设问题
            messagesEl.innerHTML = `
                <div class="chat-empty">
                    <span class="chat-empty-text">向AI提问关于这个函数的问题</span>
                    <div class="chat-suggestions">
                        <button class="chat-suggestion-btn" data-q="这个函数的主要逻辑是什么？">这个函数的主要逻辑是什么？</button>
                        <button class="chat-suggestion-btn" data-q="有什么潜在的bug吗？">有什么潜在的bug吗？</button>
                        <button class="chat-suggestion-btn" data-q="能帮我重构这段代码吗？">能帮我重构这段代码吗？</button>
                    </div>
                </div>`;
            return;
        }

        // 渲染消息列表
        let html = '';
        let lastTime = null;

        for (const msg of this.messages) {
            // 时间分隔线（间隔>5分钟）
            if (msg.created_at) {
                const msgTime = new Date(msg.created_at);
                if (lastTime && (msgTime - lastTime) > 5 * 60 * 1000) {
                    html += `<div class="chat-time-sep">${this._formatTime(msgTime)}</div>`;
                }
                lastTime = msgTime;
            }

            const bubbleContent = msg.role === 'assistant'
                ? AI._renderMarkdown(msg.content)
                : this._escapeHtml(msg.content);

            const timeStr = msg.created_at ? this._formatTime(new Date(msg.created_at)) : '';

            html += `<div class="chat-msg ${msg.role}">
                <div class="chat-msg-bubble">${bubbleContent}</div>
                ${timeStr ? `<span class="chat-msg-time">${timeStr}</span>` : ''}
            </div>`;
        }

        messagesEl.innerHTML = html;
        this._scrollToBottom(true);
    },

    /** 发送消息 */
    async send() {
        if (typeof Offline !== 'undefined' && !Offline.isOnline) {
            return; // 离线时不发送
        }
        const textarea = document.getElementById('chat-input');
        const message = textarea.value.trim();
        if (!message || this.isSending) return;

        this.isSending = true;
        textarea.value = '';
        this._autoResize(textarea);

        const sendBtn = document.getElementById('chat-send-btn');
        sendBtn.disabled = true;

        // 追加用户消息到UI
        const now = new Date().toISOString();
        this.messages.push({ role: 'user', content: message, created_at: now });
        this._render();

        // 显示打字指示器
        const messagesEl = document.getElementById('chat-messages');
        const typingEl = document.createElement('div');
        typingEl.className = 'chat-typing';
        typingEl.innerHTML = '<div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div>';
        messagesEl.appendChild(typingEl);
        this._scrollToBottom(true);

        try {
            const data = await API.sendChatMessage(this.functionId, message);
            this.messages.push(data.reply);
            this.funcBodyChanged = data.func_body_changed;

            // 更新对话按钮指示器
            this._updateChatIndicator(true);
        } catch (err) {
            // 追加错误消息
            this.messages.push({
                role: 'assistant',
                content: `对话失败: ${err.message}`,
                created_at: new Date().toISOString(),
            });
        } finally {
            this.isSending = false;
            sendBtn.disabled = false;
            this._render();
        }
    },

    /** 更新发送按钮和输入框的离线状态 */
    _updateSendState() {
        const sendBtn = document.getElementById('chat-send-btn');
        const textarea = document.getElementById('chat-input');
        const isOffline = typeof Offline !== 'undefined' && !Offline.isOnline;

        if (isOffline) {
            sendBtn.disabled = true;
            sendBtn.title = '需要网络连接';
            textarea.placeholder = '离线模式，无法发送消息';
        } else {
            sendBtn.disabled = false;
            sendBtn.title = '';
            textarea.placeholder = '输入你的问题...';
        }
    },

    /** 重置对话 */
    async reset() {
        if (typeof Offline !== 'undefined' && !Offline.isOnline) {
            alert('离线模式不支持重置对话');
            return;
        }
        if (!confirm('确认清空当前函数的对话记录？')) return;

        try {
            await API.resetChat(this.functionId);
            this.messages = [];
            this.funcBodyChanged = false;
            this._render();
            this._updateChatIndicator(false);
        } catch (err) {
            alert('重置失败: ' + err.message);
        }
    },

    /** 滚到底部 */
    _scrollToBottom(force) {
        const el = document.getElementById('chat-messages');
        if (!el) return;
        if (force || !this._userScrolled) {
            requestAnimationFrame(() => {
                el.scrollTop = el.scrollHeight;
            });
        }
    },

    /** 格式化时间 */
    _formatTime(date) {
        if (!(date instanceof Date) || isNaN(date)) return '';
        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();
        const h = String(date.getHours()).padStart(2, '0');
        const m = String(date.getMinutes()).padStart(2, '0');
        if (isToday) return `${h}:${m}`;
        const month = date.getMonth() + 1;
        const day = date.getDate();
        return `${month}/${day} ${h}:${m}`;
    },

    /** 更新导航栏对话按钮指示器 */
    _updateChatIndicator(hasHistory) {
        const btn = document.getElementById('btn-goto-chat');
        if (btn) {
            if (hasHistory) {
                btn.classList.add('has-history');
            } else {
                btn.classList.remove('has-history');
            }
        }
    },

    /** textarea 自动增高 */
    _autoResize(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    },

    /** HTML转义 */
    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },

    /** 绑定事件（调用一次） */
    bindEvents() {
        // 返回按钮
        document.getElementById('chat-back-btn').addEventListener('click', () => {
            this.close();
        });

        // 重置按钮
        document.getElementById('chat-reset-btn').addEventListener('click', () => {
            this.reset();
        });

        // 发送按钮
        document.getElementById('chat-send-btn').addEventListener('click', () => {
            this.send();
        });

        // textarea: 输入事件
        const textarea = document.getElementById('chat-input');
        textarea.addEventListener('input', () => {
            this._autoResize(textarea);
        });

        // PC端 Enter 发送，Shift+Enter 换行；移动端 Enter 换行
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const isPC = window.innerWidth >= 1024;
                if (isPC && !e.shiftKey) {
                    e.preventDefault();
                    this.send();
                }
            }
        });

        // 预设问题点击 - 事件委托
        document.getElementById('chat-messages').addEventListener('click', (e) => {
            const btn = e.target.closest('.chat-suggestion-btn');
            if (!btn) return;
            const q = btn.dataset.q;
            if (q) {
                document.getElementById('chat-input').value = q;
                this.send();
            }
        });

        // 检测用户手动滚动
        const messagesEl = document.getElementById('chat-messages');
        messagesEl.addEventListener('scroll', () => {
            const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 50;
            this._userScrolled = !atBottom;
        });

        // 底部导航对话按钮
        document.getElementById('btn-goto-chat').addEventListener('click', () => {
            if (!Browse.currentDetail) return;
            this.open(Browse.currentDetail.id);
        });

        // 监听网络状态变化，更新发送按钮状态
        window.addEventListener('online', () => { if (this.isOpen) this._updateSendState(); });
        window.addEventListener('offline', () => { if (this.isOpen) this._updateSendState(); });

        // visualViewport 适配虚拟键盘
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', () => {
                if (!this.isOpen) return;
                const overlay = document.getElementById('chat-overlay');
                if (overlay) {
                    overlay.style.height = window.visualViewport.height + 'px';
                }
            });
        }
    },
};
