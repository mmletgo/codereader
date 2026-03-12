"""CodeReader 应用入口"""
import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from config import HOST, PORT, STATIC_DIR
from app.database import init_db
from app.routers import projects, functions, notes, call_graph, export

app = FastAPI(title="CodeReader", version="1.0.0")

# API 路由
app.include_router(projects.router, prefix="/api/v1/projects", tags=["projects"])
app.include_router(functions.router, prefix="/api/v1/functions", tags=["functions"])
app.include_router(notes.router, prefix="/api/v1/notes", tags=["notes"])
app.include_router(call_graph.router, prefix="/api/v1/call_graph", tags=["call_graph"])
app.include_router(export.router, prefix="/api/v1/export", tags=["export"])

# 静态文件（前端）- 必须放在API路由之后
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


@app.on_event("startup")
async def startup() -> None:
    init_db()


if __name__ == "__main__":
    uvicorn.run("main:app", host=HOST, port=PORT, reload=True)
