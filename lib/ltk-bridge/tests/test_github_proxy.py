"""GitHub 代理 URL 构造与配置校验测试。"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from sona_ltk.models.config import DEFAULT_GITHUB_PROXY, BridgeConfig
from sona_ltk.services.github_proxy import (
  build_proxy_url,
  is_github_url,
  proxy_candidates,
  proxy_host,
)

RAW_URL = "https://raw.githubusercontent.com/Alban1911/LeagueSkins/main/skins/28/28001/28001.fantome"


def test_default_config_enables_gh_proxy() -> None:
  config = BridgeConfig()

  assert config.github_proxy == DEFAULT_GITHUB_PROXY == "https://gh-proxy.org"
  assert config.github_proxy_fallback is True


def test_empty_proxy_disables_proxying() -> None:
  config = BridgeConfig(github_proxy="")

  assert config.github_proxy is None


def test_proxy_is_normalized_and_validated() -> None:
  assert BridgeConfig(github_proxy="https://proxy.example/").github_proxy == "https://proxy.example"
  assert (
    BridgeConfig(github_proxy="https://proxy.example/fetch?url={url}").github_proxy
    == "https://proxy.example/fetch?url={url}"
  )

  with pytest.raises(ValidationError):
    BridgeConfig(github_proxy="http://proxy.example")
  with pytest.raises(ValidationError):
    BridgeConfig(github_proxy="https://proxy example")


def test_only_github_hosts_are_proxied() -> None:
  assert is_github_url(RAW_URL)
  assert is_github_url("https://github.com/gyyst/sona/releases/download/v1/a.exe")
  assert not is_github_url("https://cdn.jsdelivr.net/gh/Alban1911/LeagueSkins@main/skins/1/1001/1001.fantome")
  assert not is_github_url("http://raw.githubusercontent.com/a/b")


def test_build_proxy_url_supports_prefix_and_template() -> None:
  assert build_proxy_url("https://gh-proxy.org/", RAW_URL) == f"https://gh-proxy.org/{RAW_URL}"
  assert (
    build_proxy_url("https://proxy.example/fetch?url={url}", RAW_URL)
    == f"https://proxy.example/fetch?url={RAW_URL}"
  )


def test_proxy_candidates_order_and_fallback() -> None:
  assert proxy_candidates(RAW_URL, "https://gh-proxy.org", fallback=True) == [
    f"https://gh-proxy.org/{RAW_URL}",
    RAW_URL,
  ]
  assert proxy_candidates(RAW_URL, "https://gh-proxy.org", fallback=False) == [
    f"https://gh-proxy.org/{RAW_URL}"
  ]
  assert proxy_candidates(RAW_URL, None, fallback=True) == [RAW_URL]
  assert proxy_candidates("https://cdn.jsdelivr.net/x", "https://gh-proxy.org", fallback=True) == [
    "https://cdn.jsdelivr.net/x"
  ]


def test_proxy_host_from_prefix_and_template() -> None:
  assert proxy_host("https://gh-proxy.org/") == "gh-proxy.org"
  assert proxy_host("https://proxy.example/fetch?url={url}") == "proxy.example"
  assert proxy_host(None) is None
