"""代码分析引擎基础类型定义和抽象接口"""
from dataclasses import dataclass, field
from abc import ABC, abstractmethod


@dataclass
class FunctionInfo:
    """从源代码中提取的函数信息"""
    name: str
    qualified_name: str          # ClassName.method_name 或 module_func
    signature: str               # 完整签名行
    start_line: int              # 1-based
    end_line: int                # 1-based
    body: str                    # 函数体完整代码
    is_async: bool = False
    is_method: bool = False
    class_name: str | None = None
    decorators: list[str] = field(default_factory=list)
    docstring: str | None = None
    file_rel_path: str = ""      # 相对于项目根目录的路径


@dataclass
class CallInfo:
    """函数内的一次调用信息"""
    caller_qualified_name: str   # 调用者的 qualified_name
    callee_name: str             # 被调用的名称（可能未解析）
    call_line: int               # 调用发生的行号


@dataclass
class ImportInfo:
    """import 语句信息"""
    module: str                  # 模块路径
    name: str                    # 导入的名称
    alias: str                   # 使用的别名（无别名则等于name）


@dataclass
class FileAnalysisResult:
    """单个文件的分析结果"""
    rel_path: str                # 相对路径
    language: str                # 语言
    content: str                 # 文件完整内容
    line_count: int
    functions: list[FunctionInfo] = field(default_factory=list)
    calls: list[CallInfo] = field(default_factory=list)
    imports: list[ImportInfo] = field(default_factory=list)


class BaseAnalyzer(ABC):
    """代码分析器抽象基类"""

    @abstractmethod
    def analyze_file(self, file_path: str, content: str, rel_path: str) -> FileAnalysisResult:
        """分析单个文件，返回函数定义和调用信息"""
        ...

    @abstractmethod
    def supported_extensions(self) -> list[str]:
        """返回支持的文件扩展名列表"""
        ...
