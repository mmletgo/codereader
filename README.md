# CodeReader

**在手机上高效阅读 Python 代码** — 一款专为代码审阅设计的 Web 应用，通过 AST 分析自动解析函数调用关系，结合 AI 辅助解读，让你随时随地深入理解代码逻辑。

> 厌倦了在手机上用 GitHub 看代码时的糟糕体验？CodeReader 为移动端量身打造，同时完美适配 PC 端，让代码阅读不再是桌面专属。

---

## 界面预览

### PC 端

<table>
  <tr>
    <td><b>项目首页</b></td>
    <td><b>函数浏览器</b></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/pc-home.png" width="400" alt="PC端项目首页"></td>
    <td><img src="docs/screenshots/pc-browse.png" width="400" alt="PC端函数浏览器"></td>
  </tr>
  <tr>
    <td><b>调用关系图</b></td>
    <td><b>导出阅后记录</b></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/pc-graph.png" width="400" alt="PC端调用关系图"></td>
    <td><img src="docs/screenshots/pc-export.png" width="400" alt="PC端导出页面"></td>
  </tr>
</table>

### 移动端

<table>
  <tr>
    <td><b>项目首页</b></td>
    <td><b>函数浏览器</b></td>
    <td><b>调用关系图</b></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/mobile-home.png" width="200" alt="移动端项目首页"></td>
    <td><img src="docs/screenshots/mobile-browse.png" width="200" alt="移动端函数浏览器"></td>
    <td><img src="docs/screenshots/mobile-graph.png" width="200" alt="移动端调用关系图"></td>
  </tr>
</table>

---

## 为什么用 CodeReader？

- **移动优先** — 触屏友好的左右切换浏览，告别桌面依赖
- **按调用链阅读** — 不是逐文件看代码，而是沿着函数调用关系从入口到细节，真正理解执行流程
- **AI 加持** — Claude 为每个函数生成解读摘要，行级代码解释一按即达
- **阅读进度追踪** — 自动标记已读函数，筛选未读内容，再也不漏看
- **结构化导出** — 把你的阅读笔记导出为 JSON/Markdown，直接喂给 AI 做进一步分析

---

## 功能详解

### 1. 项目扫描

输入 Python 项目的目录路径，CodeReader 会：
- 递归扫描所有 `.py` 文件
- 使用 AST 解析提取每一个函数/方法定义
- 分析函数间的调用关系，构建调用图
- 按调用链排序：从入口函数开始，DFS 遍历整棵调用树

### 2. 函数浏览器

核心阅读界面，支持：
- **左右切换** — 按调用关系排序的函数序列，上一个/下一个快速切换
- **语法高亮** — highlight.js 驱动的代码着色
- **行级调用标记** — 每行代码旁的 `f(N)` 按钮，展示该行调用了哪些项目内函数（含函数签名和 docstring），点击可直接跳转到被调用函数
- **行级解释** — 每行右侧的 `?` 按钮，AI 实时解释该行代码含义
- **已读状态** — 浏览过的函数自动标记，支持筛选未读/有备注函数
- **PC 端侧边栏** — 宽屏下左侧显示完整函数列表，按文件分组，搜索过滤，点击直达

### 3. AI 辅助阅读

- **函数级解读** — 可折叠面板，一键生成函数的业务逻辑分析、代码逻辑摘要、输入输出说明
- **智能缓存** — 按函数体 SHA256 哈希缓存，函数未变则复用，变了自动失效重新生成
- **预加载** — 浏览当前函数时自动预加载相邻函数的 AI 解读
- **AI 自动备注** — 一键让 AI 生成结构化备注

### 4. 调用关系图

- D3.js 绘制的横向树状图，直观展示函数调用层级
- 节点可点击，直接跳转到对应函数的代码浏览页面
- 支持缩放和拖拽

### 5. 阅后备注

- 为每个函数添加备注，支持 5 种类型标签：通用 / Bug / TODO / 重构 / 疑问
- 持久化存储在 SQLite 中
- 重新扫描项目时通过函数限定名自动保留和重新绑定备注

### 6. 导出

- 一键导出所有有备注的函数记录
- 支持 JSON 和 Markdown 两种格式
- JSON 格式面向 AI 优化：包含函数签名、完整代码、调用关系、备注等完整上下文，方便直接喂给 LLM 做进一步分析

---

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置（可选）

```bash
cp config.example.toml config.toml
```

编辑 `config.toml`，AI 功能需要填写 API Key：

```toml
[ai]
base_url = "https://api.anthropic.com"
api_key = "sk-ant-..."
model = "claude-sonnet-4-20250514"
```

> 不配置也能启动，所有功能正常使用，仅 AI 解读/自动备注不可用。

### 3. 启动

```bash
python main.py
```

- 本机访问：`http://localhost:8080`
- 手机访问：`http://{局域网IP}:8080`（确保手机和电脑在同一网络）

### 4. 使用流程

1. 在首页点击 `+` 按钮，输入 Python 项目的目录路径，创建并扫描项目
2. 点击项目卡片进入函数浏览器，左右切换函数阅读代码
3. 点击行旁 `f(N)` 按钮查看调用关系，`?` 按钮获取 AI 行级解释
4. 展开底部 AI 解读面板查看函数整体分析
5. 在备注区添加阅读笔记或使用 AI 自动生成
6. 进入导出页面下载所有阅后记录

---

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | FastAPI + uvicorn |
| 数据库 | SQLite（标准库 sqlite3，零依赖） |
| 代码分析 | Python ast 模块 |
| AI | Anthropic Claude API（anthropic SDK） |
| 前端 | 纯 HTML/CSS/JS（无框架） |
| 代码高亮 | highlight.js |
| 调用关系图 | D3.js |

## 项目结构

```
codereader/
├── main.py                 # 应用入口，FastAPI 实例创建
├── config.py               # 配置加载（读取 config.toml）
├── config.example.toml     # 配置模板
├── requirements.txt
├── app/                    # FastAPI 应用
│   ├── database.py         #   SQLite 数据库管理
│   ├── models.py           #   Pydantic 数据模型
│   ├── routers/            #   API 路由（项目/函数/备注/导出/AI）
│   └── services/           #   业务逻辑层
├── analyzer/               # Python 代码分析引擎
│   ├── scanner.py          #   文件扫描
│   ├── python_analyzer.py  #   AST 解析，提取函数定义和调用
│   ├── call_resolver.py    #   调用关系解析
│   └── engine.py           #   分析引擎入口
├── static/                 # 前端静态文件
│   ├── index.html          #   单页应用入口
│   ├── css/                #   样式（含响应式适配）
│   ├── js/                 #   业务逻辑（浏览/AI/备注/导出/调用图）
│   └── lib/                #   第三方 JS 库（highlight.js, D3.js）
└── data/                   # 运行时数据（SQLite 数据库，gitignored）
```

## 配置说明

| 段 | 配置项 | 默认值 | 说明 |
|---|---|---|---|
| `[server]` | `host` | `0.0.0.0` | 监听地址 |
| `[server]` | `port` | `8080` | 监听端口 |
| `[analysis]` | `include` | `["*.py"]` | 扫描文件模式 |
| `[analysis]` | `exclude` | *(见模板)* | 排除目录/文件模式 |
| `[ai]` | `base_url` | `https://api.anthropic.com` | Claude API 地址（支持自定义代理网关） |
| `[ai]` | `api_key` | `""` | Claude API Key |
| `[ai]` | `model` | `claude-sonnet-4-20250514` | 模型名称 |

## License

MIT
