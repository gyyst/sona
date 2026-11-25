"""后台运行时自更新：清单、下载、解压与替换脚本。"""

from .archive import UpdateArchiveError, extract_runtime
from .download import UpdateDownloadError, download_archive, fetch_manifest
from .manifest import (
  BackendUpdateManifest,
  LocalComparison,
  ManifestFile,
  UpdateManifestError,
  compare_local_files,
  runtime_files,
  sha256_file,
)
from .script import (
  LOG_RELATIVE_PATH,
  PLAN_FILE,
  SCRIPT_FILE,
  STAGING_DIR,
  ZIP_FILE,
  UpdatePlan,
  cleanup_stale_update_files,
  launch_update_script,
  render_update_script,
  write_update_plan,
  write_update_script,
)

__all__ = [
  "LOG_RELATIVE_PATH",
  "PLAN_FILE",
  "SCRIPT_FILE",
  "STAGING_DIR",
  "ZIP_FILE",
  "BackendUpdateManifest",
  "LocalComparison",
  "ManifestFile",
  "UpdateArchiveError",
  "UpdateDownloadError",
  "UpdateManifestError",
  "UpdatePlan",
  "cleanup_stale_update_files",
  "compare_local_files",
  "download_archive",
  "extract_runtime",
  "fetch_manifest",
  "launch_update_script",
  "render_update_script",
  "runtime_files",
  "sha256_file",
  "write_update_plan",
  "write_update_script",
]
