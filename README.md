# CodeReader

移动端 Web 应用，分析 Python 代码库的函数调用关系，提供左右切换函数浏览、AI 辅助解读、阅后备注、一键导出等功能。适合在手机上阅读和审查 Python 项目代码。

## 功能特性

- **项目扫描** — 指定目录路径，递归扫描 Python 文件，提取所有函数定义和调用关系
- **函数浏览** — 按调用关系排序，左右切换函数，语法高亮，自动标记已读，支持筛选未读/有备注函数
- **调用关系图** — D3.js 横向树状图，展示函数调用关系，节点可点击跳转
- **AI 辅助阅读** — 函数级 AI 解读（可折叠面板，带缓存和预加载）、行级代码解释、AI 自动备注生成
- **阅后备注** — 为每个函数添加备注（通用/Bug/TODO/重构/疑问），持久化存储
- **导出** — 一键导出所有阅后记录（JSON/Markdown），面向 AI 优化的结构化格式

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | FastAPI + uvicorn + SQLite（标准库 sqlite3） |
| 代码分析 | Python ast 模块 |
| AI | Anthropic Claude API（anthropic SDK） |
| 前端 | 纯 HTML/CSS/JS + highlight.js + D3.js |

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置

```bash
cp config.example.toml config.toml
```

编辑 `config.toml`，按需修改配置项。AI 功能需要填写 `[ai]` 段的 `api_key`：

```toml
[ai]
base_url = "https://api.anthropic.com"
api_key = "sk-ant-..."
model = "claude-sonnet-4-20250514"
```

> 不创建 `config.toml` 也能启动，所有配置项均有默认值，但 AI 功能将不可用。

### 3. 启动

```bash
python main.py
```

- 本机访问：http://localhost:8080
- 手机访问：http://{局域网IP}:8080

### 4. 使用

1. 在首页输入 Python 项目的目录路径，创建项目并扫描
2. 进入函数浏览器，左右切换函数阅读代码
3. 展开 AI 解读面板查看函数分析，点击行右侧 `?` 按钮获取行级解释
4. 添加备注或使用 AI 自动生成备注
5. 在导出页面下载阅后记录

## 项目结构

```
codereader/
├── main.py                 # 应用入口
├── config.py               # 配置加载（读取 config.toml）
├── config.example.toml     # 配置模板
├── requirements.txt
├── app/                    # FastAPI 应用
│   ├── database.py         # SQLite 数据库管理
│   ├── models.py           # Pydantic 模型
│   ├── routers/            # API 路由
│   └── services/           # 业务逻辑
├── analyzer/               # Python 代码分析引擎
├── static/                 # 前端静态文件
│   ├── index.html
│   ├── css/
│   ├── js/
│   └── lib/                # 第三方 JS 库
└── data/                   # 运行时数据（SQLite 数据库）
```

## 配置说明

| 段 | 配置项 | 默认值 | 说明 |
|---|---|---|---|
| `[server]` | `host` | `0.0.0.0` | 监听地址 |
| `[server]` | `port` | `8080` | 监听端口 |
| `[analysis]` | `include` | `["*.py"]` | 扫描文件模式 |
| `[analysis]` | `exclude` | *(见模板)* | 排除目录/文件模式 |
| `[ai]` | `base_url` | `https://api.anthropic.com` | Claude API 地址（支持代理网关） |
| `[ai]` | `api_key` | `""` | Claude API Key |
| `[ai]` | `model` | `claude-sonnet-4-20250514` | 模型名称 |

## License

MIT
