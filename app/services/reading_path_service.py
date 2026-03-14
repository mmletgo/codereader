"""AI阅读路径服务 — 生成、查询、管理阅读路径"""
import json
import re
import sqlite3
from typing import Any

import anthropic

from config import CLAUDE_API_BASE_URL, CLAUDE_API_KEY, CLAUDE_MODEL
from app.database import fetch_one, fetch_all, execute, insert_row
from app.models import (
    ReadingPathDetailResponse,
    ReadingPathFunctionItem,
    ReadingPathListItem,
)


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


def _parse_ai_json(text: str) -> dict[str, Any]:
    """解析AI返回的JSON（处理markdown代码块包裹的情况）"""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1]) if len(lines) > 2 else text

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # 尝试提取JSON对象
        match = re.search(r'\{.*\}', text, re.DOTALL)
        if match:
            return json.loads(match.group())
        raise ValueError("AI返回的JSON格式无法解析")


def generate_reading_path(
    conn: sqlite3.Connection,
    project_id: int,
    user_query: str,
) -> ReadingPathDetailResponse:
    """AI生成阅读路径"""
    # 1. 查询项目所有函数概要
    functions = fetch_all(conn, """
        SELECT f.qualified_name, f.signature, f.docstring, fi.rel_path AS file_path
        FROM functions f
        JOIN files fi ON f.file_id = fi.id
        WHERE f.project_id = ?
        ORDER BY f.sort_order
    """, (project_id,))

    if not functions:
        raise ValueError(f"项目 {project_id} 没有函数数据")

    # 2. 查询调用关系
    call_relations = fetch_all(conn, """
        SELECT caller.qualified_name AS caller_name, callee.qualified_name AS callee_name
        FROM call_relations cr
        JOIN functions caller ON cr.caller_id = caller.id
        JOIN functions callee ON cr.callee_id = callee.id
        WHERE cr.project_id = ?
    """, (project_id,))

    # 3. 构造函数概要列表
    func_summaries: list[str] = []
    for func in functions:
        docstring = func["docstring"] or ""
        if len(docstring) > 100:
            docstring = docstring[:100] + "..."
        func_summaries.append(
            f"- {func['qualified_name']} | {func['file_path']} | {func['signature']} | {docstring}"
        )

    # 构造调用关系列表
    call_lines: list[str] = []
    for rel in call_relations:
        call_lines.append(f"- {rel['caller_name']} -> {rel['callee_name']}")

    func_list_text = "\n".join(func_summaries)
    call_list_text = "\n".join(call_lines) if call_lines else "无调用关系数据"

    prompt = f"""这是一个Python项目的函数列表和调用关系。用户想了解"{user_query}"相关的逻辑。

## 函数列表（格式：qualified_name | 文件路径 | 签名 | docstring）
{func_list_text}

## 调用关系（格式：调用者 -> 被调用者）
{call_list_text}

请从上面的函数列表中选择与用户关注点相关的函数，按推荐的阅读顺序排列。

要求：
1. 选择真正相关的函数，不要凑数，通常5-15个
2. 按照从基础到高级、从被调用到调用者的顺序排列（让读者先理解底层再理解上层）
3. 每个函数给出简短的阅读理由

请返回如下JSON格式（不要包含其他文本）：
{{
    "name": "路径名称（简短描述这条阅读路径的主题）",
    "description": "路径描述（一两句话说明这条路径帮助读者理解什么）",
    "functions": [
        {{"qualified_name": "xxx", "reason": "为什么要读这个函数"}}
    ]
}}"""

    result_text = _call_claude(
        prompt,
        system="你是一个代码阅读顾问，帮助用户规划代码阅读路径。输出纯JSON，使用中文。",
    )

    # 4. 解析AI返回的JSON
    ai_result = _parse_ai_json(result_text)

    # 5. 验证每个qualified_name在项目中存在
    existing_names: set[str] = {f["qualified_name"] for f in functions}
    validated_items: list[ReadingPathFunctionItem] = []
    for item in ai_result.get("functions", []):
        qname = item.get("qualified_name", "")
        if qname in existing_names:
            validated_items.append(ReadingPathFunctionItem(
                qualified_name=qname,
                reason=item.get("reason", ""),
            ))

    if not validated_items:
        raise ValueError("AI未能匹配到项目中存在的函数")

    # 6. 存入数据库
    function_items_json = json.dumps(
        [{"qualified_name": it.qualified_name, "reason": it.reason} for it in validated_items],
        ensure_ascii=False,
    )
    path_id = insert_row(conn, "reading_paths", {
        "project_id": project_id,
        "name": ai_result.get("name", user_query),
        "description": ai_result.get("description", ""),
        "function_items": function_items_json,
        "last_index": 0,
    })

    # 查询创建时间
    row = fetch_one(conn, "SELECT created_at FROM reading_paths WHERE id = ?", (path_id,))
    created_at = row["created_at"] if row else ""

    # 7. 为每个item填充function_id
    for item in validated_items:
        func_row = fetch_one(
            conn,
            "SELECT id FROM functions WHERE qualified_name = ? AND project_id = ?",
            (item.qualified_name, project_id),
        )
        if func_row:
            item.function_id = func_row["id"]

    return ReadingPathDetailResponse(
        id=path_id,
        project_id=project_id,
        name=ai_result.get("name", user_query),
        description=ai_result.get("description", ""),
        functions=validated_items,
        last_index=0,
        created_at=created_at,
    )


def get_reading_paths(
    conn: sqlite3.Connection,
    project_id: int,
) -> list[ReadingPathListItem]:
    """获取项目的阅读路径列表"""
    rows = fetch_all(
        conn,
        "SELECT * FROM reading_paths WHERE project_id = ? ORDER BY created_at DESC",
        (project_id,),
    )
    result: list[ReadingPathListItem] = []
    for row in rows:
        items: list[dict[str, str]] = json.loads(row["function_items"])
        result.append(ReadingPathListItem(
            id=row["id"],
            project_id=row["project_id"],
            name=row["name"],
            description=row["description"],
            function_count=len(items),
            last_index=row["last_index"],
            created_at=row["created_at"],
        ))
    return result


def get_reading_path_detail(
    conn: sqlite3.Connection,
    path_id: int,
) -> ReadingPathDetailResponse | None:
    """获取阅读路径详情"""
    row = fetch_one(conn, "SELECT * FROM reading_paths WHERE id = ?", (path_id,))
    if not row:
        return None

    items_data: list[dict[str, str]] = json.loads(row["function_items"])
    project_id: int = row["project_id"]

    # 将qualified_name映射为当前function_id
    function_items: list[ReadingPathFunctionItem] = []
    for item in items_data:
        qname = item.get("qualified_name", "")
        reason = item.get("reason", "")
        func_row = fetch_one(
            conn,
            "SELECT id FROM functions WHERE qualified_name = ? AND project_id = ?",
            (qname, project_id),
        )
        function_items.append(ReadingPathFunctionItem(
            qualified_name=qname,
            reason=reason,
            function_id=func_row["id"] if func_row else None,
        ))

    return ReadingPathDetailResponse(
        id=row["id"],
        project_id=project_id,
        name=row["name"],
        description=row["description"],
        functions=function_items,
        last_index=row["last_index"],
        created_at=row["created_at"],
    )


def delete_reading_path(
    conn: sqlite3.Connection,
    path_id: int,
) -> bool:
    """删除阅读路径"""
    affected = execute(conn, "DELETE FROM reading_paths WHERE id = ?", (path_id,))
    return affected > 0


def update_progress(
    conn: sqlite3.Connection,
    path_id: int,
    last_index: int,
) -> None:
    """更新阅读进度"""
    affected = execute(
        conn,
        "UPDATE reading_paths SET last_index = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (last_index, path_id),
    )
    if affected == 0:
        raise ValueError(f"阅读路径 {path_id} 不存在")
