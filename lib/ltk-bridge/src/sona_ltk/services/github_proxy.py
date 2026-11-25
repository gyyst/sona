"""GitHub 下载地址的代理前缀处理。"""

from __future__ import annotations

from urllib.parse import urlparse

GITHUB_HOSTS = frozenset(
  {
    "raw.githubusercontent.com",
    "github.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
  },
)

PROXY_PLACEHOLDER = "{url}"
_PLACEHOLDER_SAMPLE = "https://raw.githubusercontent.com/sona/probe"


def is_github_url(url: str) -> bool:
  """只代理 GitHub 家族主机，避免给自定义镜像二次套代理。"""

  try:
    parsed = urlparse(url)
  except ValueError:
    return False
  return parsed.scheme == "https" and parsed.hostname in GITHUB_HOSTS


def build_proxy_url(proxy: str, url: str) -> str:
  """支持前缀拼接与 `{url}` 模板两种自定义形式。"""

  normalized = proxy.rstrip("/")
  if PROXY_PLACEHOLDER in normalized:
    return normalized.replace(PROXY_PLACEHOLDER, url)
  return f"{normalized}/{url}"


def proxy_candidates(url: str, proxy: str | None, fallback: bool) -> list[str]:
  """返回下载候选地址：代理优先，按需追加直连。"""

  if not proxy or not is_github_url(url):
    return [url]
  candidates = [build_proxy_url(proxy, url)]
  if fallback:
    candidates.append(url)
  return candidates


def proxy_host(proxy: str | None) -> str | None:
  """提取代理主机，供 LTK Manager 下载白名单使用。"""

  if not proxy:
    return None
  sample = proxy.rstrip("/").replace(PROXY_PLACEHOLDER, _PLACEHOLDER_SAMPLE)
  host = urlparse(sample).hostname
  return host.lower() if host else None
