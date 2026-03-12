"""CodeReader 配置文件"""
from pathlib import Path

# 服务器配置
HOST: str = "0.0.0.0"
PORT: int = 8080

# 数据目录
DATA_DIR: Path = Path(__file__).parent / "data"
DB_PATH: Path = DATA_DIR / "codereader.db"
EXPORT_DIR: Path = DATA_DIR / "exports"

# 静态文件目录
STATIC_DIR: Path = Path(__file__).parent / "static"

# 代码分析默认配置
DEFAULT_INCLUDE: list[str] = ["*.py"]
DEFAULT_EXCLUDE: list[str] = [
    "__pycache__", ".git", ".venv", "venv", "env",
    "node_modules", ".tox", ".mypy_cache", ".pytest_cache",
    "*.pyc", "*.pyo", ".eggs", "*.egg-info",
    "dist", "build", ".hg", ".svn",
]

# AI配置（Claude API）
CLAUDE_API_BASE_URL: str = "https://api.anthropic.com"
CLAUDE_API_KEY: str = ""
CLAUDE_MODEL: str = "claude-sonnet-4-20250514"
