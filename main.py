"""CodeReader 应用入口"""
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from config import HOST, PORT, STATIC_DIR
from app.database import init_db
from app.routers import projects, functions, notes, call_graph, export, progress, ai, reading_paths


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    init_db()
    yield


app = FastAPI(title="CodeReader", version="1.0.0", lifespan=lifespan)

# CORS（Android WebView 跨域请求）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://appassets.androidplatform.net"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Gzip 压缩（500字节以上的响应自动压缩）
app.add_middleware(GZipMiddleware, minimum_size=500)


@app.middleware("http")
async def cache_control_middleware(request: Request, call_next) -> Response:  # type: ignore[type-arg]
    """为静态资源添加 Cache-Control 头"""
    response: Response = await call_next(request)
    path = request.url.path
    # API 和 Service Worker 不缓存
    if path.startswith("/api/") or path == "/sw.js":
        response.headers["Cache-Control"] = "no-cache"
    # 带版本号的静态资源长期缓存（?v=N）
    elif request.url.query and "v=" in request.url.query:
        response.headers["Cache-Control"] = "public, max-age=2592000"  # 30天
    # 其他静态资源短期缓存
    elif not path.startswith("/api/"):
        response.headers["Cache-Control"] = "public, max-age=86400"  # 1天
    return response


# API 路由
app.include_router(projects.router, prefix="/api/v1/projects", tags=["projects"])
app.include_router(functions.router, prefix="/api/v1/functions", tags=["functions"])
app.include_router(notes.router, prefix="/api/v1/notes", tags=["notes"])
app.include_router(call_graph.router, prefix="/api/v1/call_graph", tags=["call_graph"])
app.include_router(export.router, prefix="/api/v1/export", tags=["export"])
app.include_router(progress.router, prefix="/api/v1/progress", tags=["progress"])
app.include_router(ai.router, prefix="/api/v1/ai", tags=["ai"])
app.include_router(reading_paths.router, prefix="/api/v1/reading-paths", tags=["reading-paths"])

# 静态文件（前端）- 必须放在API路由之后
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    uvicorn.run("main:app", host=HOST, port=PORT, reload=True)
