"""后台更新测试共用的清单构造器。"""

from __future__ import annotations

import hashlib
from collections.abc import Callable

import pytest

from sona_ltk.services.update.manifest import BackendUpdateManifest

ManifestFactory = Callable[..., BackendUpdateManifest]


@pytest.fixture
def make_manifest() -> ManifestFactory:
  def _make(
    files: dict[str, bytes],
    *,
    release: str = "v2026.11.25.8",
    archive_size: int = 1024,
    archive_sha256: str | None = None,
  ) -> BackendUpdateManifest:
    return BackendUpdateManifest.model_validate(
      {
        "release": release,
        "sha256": archive_sha256 or "b" * 64,
        "size": archive_size,
        "files": {
          name: {"sha256": hashlib.sha256(content).hexdigest(), "size": len(content)}
          for name, content in files.items()
        },
      },
    )

  return _make
