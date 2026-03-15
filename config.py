"""CodeReader 配置 — 从 config.toml 加载，缺省使用默认值"""
import tomllib
from pathlib import Path

_PROJECT_ROOT = Path(__file__).parent
_CONFIG_PATH = _PROJECT_ROOT / "config.toml"


def _load_toml() -> dict:
    """加载 config.toml，文件不存在则返回空字典"""
    if _CONFIG_PATH.exists():
        with open(_CONFIG_PATH, "rb") as f:
            return tomllib.load(f)
    return {}


_cfg = _load_toml()
_server = _cfg.get("server", {})
_analysis = _cfg.get("analysis", {})
_ai = _cfg.get("ai", {})

# 服务器配置
HOST: str = _server.get("host", "0.0.0.0")
PORT: int = _server.get("port", 8080)

# 数据目录
DATA_DIR: Path = _PROJECT_ROOT / "data"
DB_PATH: Path = DATA_DIR / "codereader.db"
EXPORT_DIR: Path = DATA_DIR / "exports"

# 静态文件目录
STATIC_DIR: Path = _PROJECT_ROOT / "static"

# 代码分析默认配置
DEFAULT_INCLUDE: list[str] = _analysis.get("include", ["*.py", "*.js", "*.jsx", "*.mjs", "*.ts", "*.tsx"])
DEFAULT_EXCLUDE: list[str] = _analysis.get("exclude", [
    "__pycache__", ".git", ".venv", "venv", "env",
    "node_modules", ".tox", ".mypy_cache", ".pytest_cache",
    "*.pyc", "*.pyo", ".eggs", "*.egg-info",
    "dist", "build", ".hg", ".svn",
])

# AI配置（Claude API）
CLAUDE_API_BASE_URL: str = _ai.get("base_url", "https://api.anthropic.com")
CLAUDE_API_KEY: str = _ai.get("api_key", "")
CLAUDE_MODEL: str = _ai.get("model", "sonnet")
