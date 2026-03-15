# CodeReader - 移动端代码阅读器

## 项目概述
移动端Web应用，分析代码库的函数调用关系，提供左右切换函数浏览、阅后备注、一键导出等功能。支持 Python、JavaScript、TypeScript 代码分析。

## 技术栈
- 后端: FastAPI + uvicorn + SQLite (标准库sqlite3)
- 代码分析: Python ast 模块 + tree-sitter (JS/TS)
- AI: Anthropic Claude API (anthropic SDK)
- 前端: 纯HTML/CSS/JS + highlight.js(代码高亮，支持Python/JS/TS) + D3.js(调用关系图)
- 第三方JS库: 本地存储在 static/lib/

## 目录结构
- `main.py` — 应用入口，FastAPI实例创建，路由注册，静态文件挂载，GZip压缩中间件，Cache-Control静态资源缓存头，CORS中间件（Android WebView跨域）
- `config.py` — 配置加载（从config.toml读取，缺省用默认值）
- `config.example.toml` — 配置模板（复制为config.toml使用，config.toml被git忽略）
- `app/` — FastAPI应用（路由、服务、数据库、模型）
- `analyzer/` — 代码分析引擎（Python AST + JS/TS tree-sitter解析、调用关系解析）
- `static/` — 前端静态文件（HTML/CSS/JS）
- `android/` — Android WebView封装项目（Kotlin + Gradle）
- `data/` — 运行时数据（SQLite数据库文件）
- `tests/` — 测试代码
- `docs/` — 项目文档

## 核心功能
1. **项目扫描**: 指定目录路径，递归扫描源文件（Python/JS/TS），提取所有函数定义和调用关系
2. **函数浏览**: 按调用关系排序，左右切换函数，上下滚动查看代码（语法高亮），自动标记已读，支持筛选未读函数，行级显示调用的项目内函数（f(N)按钮展开查看函数名+docstring，可点击跳转），后台自动预加载所有函数详情和AI解读（进度条显示）
3. **调用关系图**: D3.js横向树状图，展示函数调用关系，节点可点击跳转
4. **阅后备注**: 为每个函数添加备注（类型：general/bug/todo/refactor/question），持久化存储
5. **导出**: 一键导出项目所有阅后记录（JSON/Markdown），面向AI优化的结构化格式
6. **AI辅助阅读**: 函数级AI解读（可折叠面板，带缓存和预加载）、行级代码解释（每行右侧?按钮）、AI自动备注生成
7. **AI阅读路径**: 用户输入关注主题，AI从项目函数中选择相关函数并按推荐顺序排列成阅读路径，支持进度跟踪
8. **AI对话**: 函数级AI对话，针对当前函数向AI提问，AI可使用工具（read_file/search_functions/get_call_relations）查阅项目代码，对话记录持久化到数据库，支持重置
9. **离线缓存(PWA)**: 项目数据自动/手动下载到IndexedDB供离线浏览（进入浏览页自动触发后台缓存，包括全量函数详情+AI解读自动生成+附加数据，完成后标记为离线可用；项目列表页也可手动触发），Service Worker缓存静态资源支持PWA离线启动，离线写操作（标记已读/备注/进度）入队列在网络恢复后自动同步，AI功能离线时自动禁用

## 数据流
用户指定目录 → scanner扫描文件 → 按扩展名分派分析器(PythonAnalyzer/JsAnalyzer)提取函数+调用 → call_resolver解析调用关系 → engine存入SQLite → API提供数据 → 前端渲染（动态选择语言高亮）

## 函数浏览排序逻辑
默认按调用关系排序：找到入口函数（无调用者），DFS遍历调用链，赋予sort_order值。未被调用链覆盖的函数按文件路径+行号追加。

## 启动方式
```bash
cd /home/hans/python_project/codereader
python main.py
```
- 服务监听 0.0.0.0:8080
- 本机访问: http://localhost:8080
- 局域网手机访问: http://{本机IP}:8080

### HTTPS（PWA离线必需）
PWA离线启动需要HTTPS（Service Worker要求）。通过 Tailscale 提供合法HTTPS：
```bash
sudo tailscale serve --bg 8080    # 自动签发Let's Encrypt证书
```
手机通过 `https://{机器名}.{tailnet}.ts.net/` 访问，浏览器完全信任。

### Android APK（推荐）
原生WebView封装，静态文件打包在APK内，API请求发往用户配置的远程服务器：
```bash
cd android
bash sync_assets.sh                           # 同步前端静态文件
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 ./gradlew assembleDebug  # 构建APK
# 产物: app/build/outputs/apk/debug/app-debug.apk
```
首次启动弹出服务器地址输入框（如 `http://192.168.1.100:8080`），之后自动连接。
离线体验：静态文件从APK加载（永远可用）+ IndexedDB缓存数据 = 无需网络即可浏览已缓存项目。

### 添加到手机桌面（PWA方式，备用）
通过Tailscale HTTPS访问后，手机浏览器会显示PWA安装引导：
- Android Chrome: 菜单(⋮) → 添加到主屏幕 / 安装应用
- iOS Safari: 分享按钮(⬆) → 添加到主屏幕
安装后可从桌面图标直接启动，服务器未运行时仍可浏览已缓存的项目数据。

## 重要设计决策
- 分析引擎(engine.py)支持 `existing_project_id` 参数用于重新扫描，避免UNIQUE约束冲突
- 重新扫描时通过qualified_name保留并重新绑定用户备注
- 前端路由使用hash模式（#/project/{id}/browse 等），支持 ?func={id} 参数直接跳转函数
- 导出格式面向AI优化：JSON包含函数签名+代码+调用关系+备注的完整上下文
- AI解读缓存：按函数体SHA256哈希判断失效，函数未变则复用缓存，变了则重新生成
- AI配置：config.toml的[ai]段配置base_url/api_key/model，支持自定义代理网关
- 配置管理：config.toml（实际配置，gitignored）+ config.example.toml（模板，git跟踪）
- Android封装：前端静态文件打包进APK通过WebViewAssetLoader以HTTPS加载，API通过JS Bridge获取用户配置的服务器地址，CORS中间件允许`appassets.androidplatform.net`跨域，WebView中跳过SW/PWA注册
- Android热更新：服务器启动时计算静态文件哈希(`/api/v1/static-version/`)，`sync_assets.sh`打包时用同算法写入APK的`version.json`，APP启动时比较版本→不一致则从服务器下载JS/CSS到IndexedDB(`codereader-hotupdate`)→`index.html`动态加载器优先使用热更新文件→下次启动即生效
