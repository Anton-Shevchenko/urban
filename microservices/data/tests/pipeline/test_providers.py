"""Retry, backoff and throttling behaviour shared by all external providers."""

from __future__ import annotations

import threading
import time

import pytest
import requests

from pipeline import providers
from pipeline.providers import NOMINATIM, OVERPASS, Provider, ProviderError

# Captured before the autouse fixture stubs out the shared time module.
_real_sleep = time.sleep


class _Resp:
    def __init__(self, status_code=200, text="{}", payload=None):
        self.status_code = status_code
        self.text = text
        self._payload = payload if payload is not None else {}

    def json(self):
        return self._payload


@pytest.fixture(autouse=True)
def no_sleeping(monkeypatch):
    """Keep retry tests instant without losing the retry accounting."""
    monkeypatch.setattr(providers.time, "sleep", lambda _s: None)


def _stub(monkeypatch, responses):
    """Serve `responses` in order; raise them if they are exceptions."""
    calls: list[dict] = []

    def fake_request(method, url, **kwargs):
        calls.append({"method": method, "url": url, **kwargs})
        item = responses[min(len(calls) - 1, len(responses) - 1)]
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr(providers.requests, "request", fake_request)
    return calls


def test_a_successful_call_is_not_retried(monkeypatch):
    calls = _stub(monkeypatch, [_Resp()])
    provider = Provider(name="t", attempts=4)

    assert provider.get("https://example.test").status_code == 200
    assert len(calls) == 1


def test_rate_limit_responses_are_retried(monkeypatch):
    calls = _stub(monkeypatch, [_Resp(status_code=429), _Resp(status_code=429), _Resp()])
    provider = Provider(name="t", attempts=3)

    assert provider.get("https://example.test").status_code == 200
    assert len(calls) == 3


def test_client_errors_are_returned_without_retrying(monkeypatch):
    calls = _stub(monkeypatch, [_Resp(status_code=404)])
    provider = Provider(name="t", attempts=3)

    assert provider.get("https://example.test").status_code == 404
    assert len(calls) == 1


def test_transport_errors_are_retried_then_surface_as_provider_error(monkeypatch):
    calls = _stub(monkeypatch, [requests.ConnectionError("refused")])
    provider = Provider(name="t", attempts=3)

    with pytest.raises(ProviderError):
        provider.get("https://example.test")
    assert len(calls) == 3


def test_backoff_grows_between_attempts(monkeypatch):
    _stub(monkeypatch, [_Resp(status_code=503)])
    slept: list[float] = []
    monkeypatch.setattr(providers.time, "sleep", slept.append)
    provider = Provider(name="t", attempts=4, backoff_s=1.0)

    with pytest.raises(ProviderError):
        provider.get("https://example.test")

    assert len(slept) == 3
    assert slept[0] < slept[1] < slept[2]


def test_throttling_spaces_out_requests(monkeypatch):
    _stub(monkeypatch, [_Resp()])
    waited: list[float] = []
    monkeypatch.setattr(providers.time, "sleep", waited.append)
    provider = Provider(name="t", min_interval_s=0.5)

    provider.get("https://example.test")
    provider.get("https://example.test")

    assert waited and waited[0] > 0


def test_nominatim_honours_the_one_request_per_second_policy():
    assert NOMINATIM.min_interval_s >= 1.0


def test_user_agent_is_always_sent(monkeypatch):
    calls = _stub(monkeypatch, [_Resp()])
    Provider(name="t").get("https://example.test")
    assert calls[0]["headers"]["User-Agent"]


def test_rotation_moves_to_the_next_mirror(monkeypatch):
    seen: list[str] = []

    def fake_request(method, url, **kwargs):
        seen.append(url)
        if url == "https://a.test":
            return _Resp(status_code=504)
        return _Resp(text='{"elements": []}', payload={"elements": []})

    monkeypatch.setattr(providers.requests, "request", fake_request)

    data = OVERPASS.post_json_rotating(["https://a.test", "https://b.test"], data={"data": "x"})

    assert data == {"elements": []}
    assert seen[-1] == "https://b.test"


def test_rotation_rejects_non_json_bodies(monkeypatch):
    monkeypatch.setattr(
        providers.requests,
        "request",
        lambda method, url, **kwargs: _Resp(text="<html>busy</html>"),
    )

    with pytest.raises(ProviderError):
        OVERPASS.post_json_rotating(["https://a.test"], data={"data": "x"})


def test_throttle_is_shared_across_threads(monkeypatch):
    """Two concurrent city generations must share one request budget."""
    monkeypatch.setattr(providers.time, "sleep", _real_sleep)
    monkeypatch.setattr(providers.requests, "request", lambda *a, **k: _Resp())
    provider = Provider(name="t", min_interval_s=0.05)
    stamps: list[float] = []

    def call() -> None:
        provider.get("https://example.test")
        stamps.append(time.monotonic())

    threads = [threading.Thread(target=call) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    stamps.sort()
    assert stamps[-1] - stamps[0] >= 0.05
