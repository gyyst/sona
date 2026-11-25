"""GitHub 下载候选地址与主机白名单。

代理只来自用户配置，支持前缀拼接与 `{url}` 模板；不使用清单返回的任意 URL。
"""

from __future__ import annotations

from urllib.parse import urlparse

PROXY_PLACEHOLDER = "{url}"
PROXY_PROBE_URL = "https://raw.githubusercontent.com/gyyst/sona/probe"

GITHUB_DOWNLOAD_HOSTS = frozenset(
  {
    "github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
  },
)


def proxy_candidates(url: str, proxy: str | None, fallback: bool) -> list[str]:
  """代理优先；支持前缀拼接与 `{url}` 模板，按需追加直连。"""

  cleaned = (proxy or "").strip().rstrip("/")
  if not cleaned or not is_github_url(url):
    return [url]
  if PROXY_PLACEHOLDER in cleaned:
    proxied = cleaned.replace(PROXY_PLACEHOLDER, url)
  else:
    proxied = f"{cleaned}/{url}"
  return [proxied, url] if fallback else [proxied]


def proxy_host(proxy: str | None) -> str | None:
  """提取代理主机，仅用于扩充本次下载的主机白名单。"""

  cleaned = (proxy or "").strip().rstrip("/")
  if not cleaned:
    return None
  sample = cleaned.replace(PROXY_PLACEHOLDER, PROXY_PROBE_URL)
  host = urlparse(sample).hostname
  return host.lower() if host else None


def allowed_hosts(proxy: str | None) -> frozenset[str]:
  hosts = set(GITHUB_DOWNLOAD_HOSTS)
  host = proxy_host(proxy)
  if host:
    hosts.add(host)
  return frozenset(hosts)


def is_github_url(url: str) -> bool:
  try:
    parsed = urlparse(url)
  except ValueError:
    return False
  return parsed.scheme == "https" and (parsed.hostname or "").lower() in GITHUB_DOWNLOAD_HOSTS
