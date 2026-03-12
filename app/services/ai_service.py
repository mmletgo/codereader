"""AI辅助分析服务 — 函数解读、行级解释、自动备注"""
import hashlib
import json
import re
import sqlite3
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
