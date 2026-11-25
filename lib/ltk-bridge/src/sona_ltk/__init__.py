"""Sona LTK Manager 本地桥接后台。"""

__version__ = "0.1.0"

try:  # 发布流水线在构建前写入该文件；源码/开发构建没有它
  from ._build import BUILD_VERSION as build_version
except ImportError:  # pragma: no cover - 仅源码运行
  build_version = "dev"

__all__ = ["__version__", "build_version"]
