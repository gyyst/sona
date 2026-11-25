"""GitHub 代理候选与主机白名单测试。"""

from __future__ import annotations

import pytest

from sona_ltk.services.update.proxy import allowed_hosts, proxy_candidates, proxy_host

ARCHIVE = "https://github.com/gyyst/sona/releases/download/v2026.11.25.8/sona-v2026.11.25.8.zip"


def test_prefix_proxy_then_direct() -> None:
  candidates = proxy_candidates(ARCHIVE, "https://gh-proxy.org/", True)
  assert candidates == [f"https://gh-proxy.org/{ARCHIVE}", ARCHIVE]


def test_template_proxy() -> None:
  candidates = proxy_candidates(ARCHIVE, "https://mirror.example.com/{url}", True)
  assert candidates == [f"https://mirror.example.com/{ARCHIVE}", ARCHIVE]


def test_proxy_without_fallback() -> None:
  assert proxy_candidates(ARCHIVE, "https://gh-proxy.org", False) == [
    f"https://gh-proxy.org/{ARCHIVE}",
  ]


@pytest.mark.parametrize("proxy", [None, "", "   "])
def test_no_proxy_returns_direct(proxy: str | None) -> None:
  assert proxy_candidates(ARCHIVE, proxy, True) == [ARCHIVE]


def test_non_github_url_is_not_proxied() -> None:
  url = "https://mirror.example.com/sona.zip"
  assert proxy_candidates(url, "https://gh-proxy.org", True) == [url]


def test_proxy_host_is_extracted() -> None:
  assert proxy_host("https://gh-proxy.org/") == "gh-proxy.org"
  assert proxy_host("https://mirror.example.com/{url}") == "mirror.example.com"
  assert proxy_host(None) is None


def test_allowed_hosts_only_adds_configured_proxy() -> None:
  hosts = allowed_hosts("https://gh-proxy.org")
  assert "github.com" in hosts
  assert "raw.githubusercontent.com" in hosts
  assert "gh-proxy.org" in hosts
  assert "evil.example.com" not in hosts
