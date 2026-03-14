"""AI辅助分析服务 — 函数解读、行级解释、自动备注、函数级AI对话"""
import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import anthropic

from config import CLAUDE_API_BASE_URL, CLAUDE_API_KEY, CLAUDE_MODEL
from app.database import fetch_one, fetch_all, execute
from app.models import AIExplanationResponse, AILineExplainResponse, NoteResponse


def _get_client() -> anthropic.Anthropic:
    """获取 Anthropic 客户端"""
    return anthropic.Anthropic(
        api_key=CLAUDE_API_KEY,
        base_url=CLAUDE_API_BASE_URL,
    )


def _call_claude(prompt: str, system: str = "") -> str:
    """调用 Claude API"""
    client = _get_client()
    messages: list[dict[str, str]] = [{"role": "user", "content": prompt}]
    kwargs: dict[str, Any] = {
        "model": CLAUDE_MODEL,
        "max_tokens": 4096,
        "messages": messages,
    }
    if system:
        kwargs["system"] = system
    response = client.messages.create(**kwargs)
    return response.content[0].text


def _hash_body(body: str) -> str:
    """计算函数体的SHA256哈希"""
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _build_func_context(conn: sqlite3.Connection, function_id: int) -> dict[str, Any] | None:
    """从数据库获取函数完整上下文"""
    func = fetch_one(conn, """
        SELECT f.*, fi.rel_path
        FROM functions f
        JOIN files fi ON f.file_id = fi.id
        WHERE f.id = ?
    """, (function_id,))
    if not func:
        return None

    # 获取调用者
    callers = fetch_all(conn, """
        SELECT f2.qualified_name
        FROM call_relations cr
        JOIN functions f2 ON cr.caller_id = f2.id
        WHERE cr.callee_id = ?
    """, (function_id,))

    # 获取被调用者
    callees = fetch_all(conn, """
        SELECT f2.qualified_name
        FROM call_relations cr
        JOIN functions f2 ON cr.callee_id = f2.id
        WHERE cr.caller_id = ?
    """, (function_id,))

    return {
        "qualified_name": func["qualified_name"],
        "signature": func["signature"],
        "body": func["body"],
        "file_path": func["rel_path"],
        "start_line": func["start_line"],
        "end_line": func["end_line"],
        "docstring": func["docstring"],
        "callers": [c["qualified_name"] for c in callers],
        "callees": [c["qualified_name"] for c in callees],
    }


def get_or_generate_explanation(
    conn: sqlite3.Connection, function_id: int
) -> AIExplanationResponse:
    """获取或生成函数AI解读（带缓存，hash比对）"""
    ctx = _build_func_context(conn, function_id)
    if not ctx:
        raise ValueError(f"函数 {function_id} 不存在")

    body_hash = _hash_body(ctx["body"])

    # 查缓存
    cached = fetch_one(
        conn,
        "SELECT * FROM ai_explanations WHERE function_id = ?",
        (function_id,),
    )
    if cached and cached["func_body_hash"] == body_hash:
        return AIExplanationResponse(
            function_id=function_id,
            explanation=cached["explanation"],
            cached=True,
        )

    # 生成解读
    callers_str = ", ".join(ctx["callers"]) if ctx["callers"] else "无"
    callees_str = ", ".join(ctx["callees"]) if ctx["callees"] else "无"

    prompt = f"""请分析以下Python函数，给出简洁的中文解读。包含：
1. **功能概述**：一句话说明函数做什么
2. **详细逻辑**：分步骤描述核心逻辑（用编号列表）
3. **注意事项**：值得注意的边界情况、潜在问题或设计考量（如有）

函数信息：
- 完整名称：{ctx["qualified_name"]}
- 文件：{ctx["file_path"]}:{ctx["start_line"]}-{ctx["end_line"]}
- 调用者：{callers_str}
- 调用的函数：{callees_str}

代码：
```python
{ctx["body"]}
```

请直接输出分析内容，不要重复函数名。使用Markdown格式。"""

    explanation = _call_claude(
        prompt,
        system="你是一个代码阅读助手，帮助用户理解Python代码。回答简洁准确，使用中文。",
    )

    # 存入/更新缓存
    if cached:
        execute(
            conn,
            "UPDATE ai_explanations SET explanation = ?, func_body_hash = ?, created_at = CURRENT_TIMESTAMP WHERE function_id = ?",
            (explanation, body_hash, function_id),
        )
    else:
        conn.execute(
            "INSERT INTO ai_explanations (function_id, explanation, func_body_hash) VALUES (?, ?, ?)",
            (function_id, explanation, body_hash),
        )

    return AIExplanationResponse(
        function_id=function_id,
        explanation=explanation,
        cached=False,
    )


def generate_line_explanation(
    conn: sqlite3.Connection,
    function_id: int,
    line_number: int,
    line_content: str,
) -> AILineExplainResponse:
    """生成行级代码解释"""
    ctx = _build_func_context(conn, function_id)
    if not ctx:
        raise ValueError(f"函数 {function_id} 不存在")

    prompt = f"""请解释以下Python代码中第 {line_number} 行的含义和作用。

函数完整代码（{ctx["qualified_name"]}）：
```python
{ctx["body"]}
```

需要解释的行（第{line_number}行）：
```python
{line_content}
```

请用1-3句简洁的中文解释这行代码在函数中的作用。不需要标题或格式，直接说明即可。"""

    explanation = _call_claude(
        prompt,
        system="你是一个代码阅读助手，帮助用户理解Python代码中的特定行。回答简洁准确，使用中文。",
    )

    return AILineExplainResponse(
        line_number=line_number,
        explanation=explanation,
    )


def generate_auto_notes(
    conn: sqlite3.Connection,
    function_id: int,
    project_id: int,
) -> list[NoteResponse]:
    """生成AI自动备注"""
    ctx = _build_func_context(conn, function_id)
    if not ctx:
        raise ValueError(f"函数 {function_id} 不存在")

    prompt = f"""分析以下Python函数，生成结构化的代码审查备注。

函数：{ctx["qualified_name"]}
文件：{ctx["file_path"]}:{ctx["start_line"]}-{ctx["end_line"]}

代码：
```python
{ctx["body"]}
```

请返回一个JSON数组，每个元素包含：
- "note_type": 备注类型，取值为 "bug"（潜在bug）, "todo"（待改进）, "refactor"（重构建议）, "question"（疑问点）, "general"（通用备注）
- "content": 备注内容（简洁的中文描述）

只输出有价值的备注（1-5条），不要凑数。如果代码没什么问题，可以只输出1条general类型的概括。
请只返回JSON数组，不要包含其他文本或markdown代码块标记。"""

    result_text = _call_claude(
        prompt,
        system="你是一个代码审查助手。输出纯JSON数组，不包含任何其他内容。",
    )

    # 解析JSON（处理可能的markdown包裹）
    text = result_text.strip()
    if text.startswith("```"):
        # 去除markdown代码块
        lines = text.split("\n")
        text = "\n".join(lines[1:-1]) if len(lines) > 2 else text

    try:
        notes_data: list[dict[str, str]] = json.loads(text)
    except json.JSONDecodeError:
        # 尝试提取JSON数组
        match = re.search(r'\[.*\]', text, re.DOTALL)
        if match:
            notes_data = json.loads(match.group())
        else:
            raise ValueError("AI返回的备注格式无法解析")

    # 批量插入notes
    created_notes: list[NoteResponse] = []
    for note_data in notes_data:
        note_type = note_data.get("note_type", "general")
        content = note_data.get("content", "")
        if not content:
            continue

        # 验证note_type
        valid_types = {"general", "bug", "todo", "refactor", "question"}
        if note_type not in valid_types:
            note_type = "general"

        cursor = conn.execute(
            "INSERT INTO notes (function_id, project_id, content, note_type, source) VALUES (?, ?, ?, ?, 'ai')",
            (function_id, project_id, content, note_type),
        )
        note_id = cursor.lastrowid
        row = fetch_one(conn, "SELECT * FROM notes WHERE id = ?", (note_id,))
        if row:
            created_notes.append(NoteResponse(**row))

    return created_notes


# ========== AI Chat ==========

def _build_directory_tree(rel_paths: list[str]) -> str:
    """从文件相对路径列表构建简化目录树文本"""
    dirs: set[str] = set()
    for p in rel_paths:
        parts = p.split("/")
        for i in range(1, len(parts)):
            dirs.add("/".join(parts[:i]))

    all_entries = sorted(dirs | set(rel_paths))
    if len(all_entries) > 100:
        # 太多条目时只显示目录
        all_entries = sorted(dirs)
        if len(all_entries) > 50:
            all_entries = all_entries[:50]
            all_entries.append("... (更多目录省略)")

    return "\n".join(all_entries)


def _build_chat_context(conn: sqlite3.Connection, function_id: int) -> dict[str, Any] | None:
    """构建对话所需的完整上下文（项目信息+目录结构+函数上下文+调用关系摘要）"""
    func = fetch_one(conn, """
        SELECT f.*, fi.rel_path
        FROM functions f
        JOIN files fi ON f.file_id = fi.id
        WHERE f.id = ?
    """, (function_id,))
    if not func:
        return None

    project_id = func["project_id"]
    project = fetch_one(conn, "SELECT * FROM projects WHERE id = ?", (project_id,))
    if not project:
        return None

    # 项目目录结构
    files = fetch_all(conn, "SELECT rel_path FROM files WHERE project_id = ?", (project_id,))
    dir_tree = _build_directory_tree([f["rel_path"] for f in files])

    # 函数上下文（复用现有函数）
    func_ctx = _build_func_context(conn, function_id)
    if not func_ctx:
        return None

    # 调用者详细信息
    callers_detail = fetch_all(conn, """
        SELECT f2.qualified_name, f2.signature, f2.docstring
        FROM call_relations cr
        JOIN functions f2 ON cr.caller_id = f2.id
        WHERE cr.callee_id = ?
    """, (function_id,))

    # 被调用者详细信息
    callees_detail = fetch_all(conn, """
        SELECT f2.qualified_name, f2.signature, f2.docstring
        FROM call_relations cr
        JOIN functions f2 ON cr.callee_id = f2.id
        WHERE cr.caller_id = ?
    """, (function_id,))

    return {
        "project_name": project["name"],
        "root_path": project["root_path"],
        "file_count": project["file_count"],
        "func_count": project["func_count"],
        "project_id": project_id,
        "directory_tree": dir_tree,
        "qualified_name": func_ctx["qualified_name"],
        "signature": func_ctx["signature"],
        "body": func_ctx["body"],
        "file_path": func_ctx["file_path"],
        "start_line": func_ctx["start_line"],
        "end_line": func_ctx["end_line"],
        "callers_detail": callers_detail,
        "callees_detail": callees_detail,
    }


_CHAT_TOOLS: list[dict[str, Any]] = [
    {
        "name": "read_file",
        "description": "读取项目中指定文件的内容。路径为相对于项目根目录的相对路径。",
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "文件的相对路径，如 'src/main.py'"
                }
            },
            "required": ["file_path"]
        }
    },
    {
        "name": "search_functions",
        "description": "在项目中搜索函数。支持按名称模糊匹配，返回匹配函数的签名、文件位置和docstring。",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "搜索关键词，匹配函数名或qualified_name"
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "get_call_relations",
        "description": "查看指定函数的调用关系（谁调用了它，它调用了谁）。",
        "input_schema": {
            "type": "object",
            "properties": {
                "qualified_name": {
                    "type": "string",
                    "description": "函数的qualified_name，如 'MyClass.my_method'"
                }
            },
            "required": ["qualified_name"]
        }
    },
]


def _execute_tool(
    conn: sqlite3.Connection,
    project_root: str,
    project_id: int,
    tool_name: str,
    tool_input: dict[str, Any],
) -> str:
    """执行工具调用，返回结果字符串"""
    if tool_name == "read_file":
        return _tool_read_file(project_root, tool_input.get("file_path", ""))
    elif tool_name == "search_functions":
        return _tool_search_functions(conn, project_id, tool_input.get("query", ""))
    elif tool_name == "get_call_relations":
        return _tool_get_call_relations(conn, project_id, tool_input.get("qualified_name", ""))
    else:
        return f"未知工具: {tool_name}"


def _tool_read_file(project_root: str, file_path: str) -> str:
    """读取项目中的文件"""
    if not file_path:
        return "错误: 未指定文件路径"

    root = Path(project_root).resolve()
    target = (root / file_path).resolve()

    # 安全检查：确保在项目目录内
    if not str(target).startswith(str(root)):
        return "错误: 文件路径超出项目目录范围"

    if not target.exists():
        return f"错误: 文件不存在: {file_path}"

    if not target.is_file():
        return f"错误: 不是文件: {file_path}"

    try:
        content = target.read_text(encoding="utf-8")
        # 截断过长内容
        if len(content) > 10000:
            content = content[:10000] + "\n\n... (文件内容已截断，共 {} 字符)".format(len(content))
        return content
    except Exception as e:
        return f"错误: 读取文件失败: {e}"


def _tool_search_functions(conn: sqlite3.Connection, project_id: int, query: str) -> str:
    """搜索项目中的函数"""
    if not query:
        return "错误: 未指定搜索关键词"

    pattern = f"%{query}%"
    results = fetch_all(conn, """
        SELECT f.qualified_name, f.signature, fi.rel_path, f.start_line, f.docstring
        FROM functions f
        JOIN files fi ON f.file_id = fi.id
        WHERE f.project_id = ? AND (f.name LIKE ? OR f.qualified_name LIKE ?)
        LIMIT 20
    """, (project_id, pattern, pattern))

    if not results:
        return f"未找到匹配 '{query}' 的函数"

    lines: list[str] = []
    for r in results:
        doc = r["docstring"].split("\n")[0] if r["docstring"] else "无文档"
        lines.append(f"- {r['qualified_name']} ({r['rel_path']}:{r['start_line']})")
        lines.append(f"  签名: {r['signature']}")
        lines.append(f"  说明: {doc}")

    return "\n".join(lines)


def _tool_get_call_relations(conn: sqlite3.Connection, project_id: int, qualified_name: str) -> str:
    """查看函数的调用关系"""
    if not qualified_name:
        return "错误: 未指定函数名"

    func = fetch_one(conn, """
        SELECT f.id, f.qualified_name, f.signature
        FROM functions f
        WHERE f.project_id = ? AND f.qualified_name = ?
    """, (project_id, qualified_name))

    if not func:
        return f"未找到函数: {qualified_name}"

    func_id = func["id"]

    # 调用者
    callers = fetch_all(conn, """
        SELECT f2.qualified_name, f2.signature, fi.rel_path, f2.docstring
        FROM call_relations cr
        JOIN functions f2 ON cr.caller_id = f2.id
        JOIN files fi ON f2.file_id = fi.id
        WHERE cr.callee_id = ?
    """, (func_id,))

    # 被调用者
    callees = fetch_all(conn, """
        SELECT f2.qualified_name, f2.signature, fi.rel_path, f2.docstring
        FROM call_relations cr
        JOIN functions f2 ON cr.callee_id = f2.id
        JOIN files fi ON f2.file_id = fi.id
        WHERE cr.caller_id = ?
    """, (func_id,))

    lines: list[str] = [f"函数: {func['qualified_name']}"]
    lines.append(f"签名: {func['signature']}")
    lines.append("")

    lines.append(f"调用者 ({len(callers)}):")
    if callers:
        for c in callers:
            doc = c["docstring"].split("\n")[0] if c["docstring"] else "无文档"
            lines.append(f"  - {c['qualified_name']} ({c['rel_path']}) — {doc}")
    else:
        lines.append("  (无)")

    lines.append("")
    lines.append(f"被调用函数 ({len(callees)}):")
    if callees:
        for c in callees:
            doc = c["docstring"].split("\n")[0] if c["docstring"] else "无文档"
            lines.append(f"  - {c['qualified_name']} ({c['rel_path']}) — {doc}")
    else:
        lines.append("  (无)")

    return "\n".join(lines)


def _call_claude_chat(
    conn: sqlite3.Connection,
    project_root: str,
    project_id: int,
    messages: list[dict[str, Any]],
    system: str = "",
) -> str:
    """调用 Claude API（支持 tool use 循环）"""
    client = _get_client()

    max_iterations = 5
    text_parts: list[str] = []

    for _ in range(max_iterations):
        kwargs: dict[str, Any] = {
            "model": CLAUDE_MODEL,
            "max_tokens": 4096,
            "messages": messages,
            "tools": _CHAT_TOOLS,
        }
        if system:
            kwargs["system"] = system

        response = client.messages.create(**kwargs)

        # 收集本轮所有 content blocks
        text_parts = []
        tool_results: list[dict[str, Any]] = []

        for block in response.content:
            if block.type == "text":
                text_parts.append(block.text)
            elif block.type == "tool_use":
                result = _execute_tool(conn, project_root, project_id, block.name, block.input)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result,
                })

        if response.stop_reason == "end_turn" or not tool_results:
            return "\n".join(text_parts) if text_parts else "（AI未返回文本回复）"

        # AI 请求了工具，追加 assistant message + tool results，继续循环
        messages.append({"role": "assistant", "content": response.content})
        messages.append({"role": "user", "content": tool_results})

    # 达到最大循环次数，返回已有的文本
    return "\n".join(text_parts) if text_parts else "（AI工具调用次数已达上限）"


def get_chat_history(
    conn: sqlite3.Connection, function_id: int
) -> dict[str, Any]:
    """获取对话历史"""
    func = fetch_one(conn, """
        SELECT f.body FROM functions f WHERE f.id = ?
    """, (function_id,))
    if not func:
        raise ValueError(f"函数 {function_id} 不存在")

    current_hash = _hash_body(func["body"])

    conv = fetch_one(conn,
        "SELECT * FROM ai_conversations WHERE function_id = ?",
        (function_id,),
    )

    if not conv:
        return {
            "function_id": function_id,
            "messages": [],
            "func_body_changed": False,
        }

    messages = json.loads(conv["messages"])
    func_body_changed = conv["func_body_hash"] != current_hash

    return {
        "function_id": function_id,
        "messages": messages,
        "func_body_changed": func_body_changed,
    }


def send_chat_message(
    conn: sqlite3.Connection, function_id: int, user_message: str
) -> dict[str, Any]:
    """发送聊天消息，返回AI回复"""
    # 构建上下文
    chat_ctx = _build_chat_context(conn, function_id)
    if not chat_ctx:
        raise ValueError(f"函数 {function_id} 不存在")

    project_id = chat_ctx["project_id"]
    project_root = chat_ctx["root_path"]

    # 构建 system prompt
    callers_summary = "\n".join(
        f"- {c['qualified_name']} | {c['signature']} | {(c['docstring'] or '').split(chr(10))[0]}"
        for c in chat_ctx["callers_detail"]
    ) or "无"

    callees_summary = "\n".join(
        f"- {c['qualified_name']} | {c['signature']} | {(c['docstring'] or '').split(chr(10))[0]}"
        for c in chat_ctx["callees_detail"]
    ) or "无"

    system = f"""你是一个代码阅读助手，正在帮助用户理解一个Python项目中的函数。回答简洁准确，使用中文，支持Markdown格式。

你有 3 个工具可以使用：
- read_file: 读取项目中的文件
- search_functions: 按名称搜索项目中的函数
- get_call_relations: 查看函数的调用关系
当你需要查看其他代码时，请主动使用这些工具，不要猜测代码内容。

## 项目信息
- 项目名称：{chat_ctx["project_name"]}
- 根路径：{chat_ctx["root_path"]}
- 规模：{chat_ctx["file_count"]} 个文件，{chat_ctx["func_count"]} 个函数

## 项目目录结构
{chat_ctx["directory_tree"]}

## 当前函数
- 名称：{chat_ctx["qualified_name"]}
- 文件：{chat_ctx["file_path"]}:{chat_ctx["start_line"]}-{chat_ctx["end_line"]}
- 签名：{chat_ctx["signature"]}

### 调用者（调用了本函数的函数）
{callers_summary}

### 被调用函数（本函数调用的函数）
{callees_summary}

### 代码
```python
{chat_ctx["body"]}
```

请基于以上上下文回答用户问题。需要查看其他代码时请使用工具。"""

    # 读取历史消息
    conv = fetch_one(conn,
        "SELECT * FROM ai_conversations WHERE function_id = ?",
        (function_id,),
    )

    current_hash = _hash_body(chat_ctx["body"])
    func_body_changed = False

    if conv:
        stored_messages: list[dict[str, str]] = json.loads(conv["messages"])
        func_body_changed = conv["func_body_hash"] != current_hash
    else:
        stored_messages = []

    # 构建 API messages（限制最近 20 轮）
    # 保留首条用户消息作为锚点
    api_messages: list[dict[str, str]] = []
    if len(stored_messages) > 40 and stored_messages:
        api_messages.append({"role": stored_messages[0]["role"], "content": stored_messages[0]["content"]})
        api_messages.extend(
            {"role": m["role"], "content": m["content"]}
            for m in stored_messages[-39:]
        )
    else:
        api_messages.extend(
            {"role": m["role"], "content": m["content"]}
            for m in stored_messages
        )

    # 追加新用户消息
    now = datetime.now(timezone.utc).isoformat()
    api_messages.append({"role": "user", "content": user_message})

    # 调用 Claude（带 tool use）
    reply_text = _call_claude_chat(conn, project_root, project_id, api_messages, system)

    reply_time = datetime.now(timezone.utc).isoformat()

    # 更新存储的消息
    stored_messages.append({"role": "user", "content": user_message, "created_at": now})
    stored_messages.append({"role": "assistant", "content": reply_text, "created_at": reply_time})

    messages_json = json.dumps(stored_messages, ensure_ascii=False)

    if conv:
        execute(conn,
            "UPDATE ai_conversations SET messages = ?, func_body_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE function_id = ?",
            (messages_json, current_hash, function_id),
        )
    else:
        conn.execute(
            "INSERT INTO ai_conversations (function_id, project_id, messages, func_body_hash) VALUES (?, ?, ?, ?)",
            (function_id, project_id, messages_json, current_hash),
        )

    reply = {
        "role": "assistant",
        "content": reply_text,
        "created_at": reply_time,
    }

    return {
        "reply": reply,
        "func_body_changed": func_body_changed,
    }


def delete_chat(conn: sqlite3.Connection, function_id: int) -> bool:
    """删除对话历史"""
    rows = execute(conn,
        "DELETE FROM ai_conversations WHERE function_id = ?",
        (function_id,),
    )
    return rows > 0
