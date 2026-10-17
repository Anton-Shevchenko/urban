"""One retry / backoff / throttle wrapper for every external data provider.

Before this module each caller invented its own policy: Overpass rotated
mirrors with a flat 3 s sleep, Nominatim ignored its documented 1 req/s limit,
and the WFS and GTFS downloads had no retry at all. Getting rate-limited by
Nominatim used to fail a city generation twenty minutes in.

Usage::

    from .providers import NOMINATIM, OVERPASS, WFS

    resp = NOMINATIM.get(config.NOMINATIM_URL, params={...})
    data = OVERPASS.post_json_rotating(config.OVERPASS_ENDPOINTS, data={...})
"""

from __future__ import annotations

import random
import threading
import time
from dataclasses import dataclass, field

import requests

from . import config
from .common import log

# Status codes worth retrying: rate limits and transient server errors.
_RETRY_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


class ProviderError(RuntimeError):
    """Raised when a provider stayed unavailable across every attempt."""


@dataclass
class Provider:
    """Rate-limited HTTP client with exponential backoff and jitter.

    Attributes:
        name: used in log lines.
        min_interval_s: minimum gap between requests, per process. Nominatim's
            usage policy is 1 req/s; Overpass mirrors tolerate more.
        attempts: total tries per URL, including the first.
        timeout_s: per-request timeout.
        backoff_s: base delay; attempt *n* waits ``backoff_s * 2**(n-1)``.
    """

    name: str
    min_interval_s: float = 0.0
    attempts: int = 4
    timeout_s: float = 60.0
    backoff_s: float = 2.0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _last_request: float = field(default=0.0, repr=False)

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {"User-Agent": config.USER_AGENT}
        if extra:
            headers.update(extra)
        return headers

    def _throttle(self) -> None:
        if self.min_interval_s <= 0:
            return
        # Hold the lock across the sleep so concurrent city generations share
        # one request budget instead of each honouring the limit separately.
        with self._lock:
            wait = self.min_interval_s - (time.monotonic() - self._last_request)
            if wait > 0:
                time.sleep(wait)
            self._last_request = time.monotonic()

    def _sleep_before_retry(self, attempt: int) -> None:
        delay = self.backoff_s * (2 ** (attempt - 1))
        # Jitter avoids synchronised retries when several cities generate at once.
        time.sleep(delay * (0.7 + 0.6 * random.random()))

    def request(
        self,
        method: str,
        url: str,
        *,
        params: dict | None = None,
        data: dict | None = None,
        json_body: dict | None = None,
        headers: dict[str, str] | None = None,
        timeout_s: float | None = None,
        attempts: int | None = None,
    ) -> requests.Response:
        total = attempts or self.attempts
        last_error: Exception | None = None

        for attempt in range(1, total + 1):
            self._throttle()
            try:
                resp = requests.request(
                    method,
                    url,
                    params=params,
                    data=data,
                    json=json_body,
                    headers=self._headers(headers),
                    timeout=timeout_s or self.timeout_s,
                )
            except requests.RequestException as exc:
                last_error = exc
                log(self.name, f"attempt {attempt}/{total} {url} failed: {exc}")
            else:
                if resp.status_code not in _RETRY_STATUS:
                    return resp
                last_error = ProviderError(f"HTTP {resp.status_code} from {url}")
                log(self.name, f"attempt {attempt}/{total} {url} -> HTTP {resp.status_code}")

            if attempt < total:
                self._sleep_before_retry(attempt)

        raise ProviderError(f"{self.name}: {url} unavailable after {total} attempts") from last_error

    def get(self, url: str, **kwargs) -> requests.Response:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs) -> requests.Response:
        return self.request("POST", url, **kwargs)

    def get_json(self, url: str, **kwargs) -> dict:
        resp = self.get(url, **kwargs)
        resp.raise_for_status()
        return resp.json()

    def post_json_rotating(self, urls: list[str], **kwargs) -> dict:
        """Try each mirror in turn; the first JSON response wins.

        Mirrors are independent, so one attempt per mirror per round beats
        exhausting retries against a single busy endpoint.
        """
        last_error: Exception | None = None
        for url in urls:
            try:
                resp = self.post(url, attempts=2, **kwargs)
            except ProviderError as exc:
                last_error = exc
                continue
            text = resp.text.lstrip()
            if resp.status_code == 200 and text.startswith("{"):
                return resp.json()
            last_error = ProviderError(f"non-JSON response from {url} (HTTP {resp.status_code})")
            log(self.name, f"rotating away from {url}: {last_error}")
        raise ProviderError(f"{self.name}: every endpoint failed") from last_error


# Nominatim's usage policy is an absolute maximum of 1 request per second.
NOMINATIM = Provider(name="nominatim", min_interval_s=1.1, attempts=4, timeout_s=30)

# Public Photon (Komoot). Used only for German place suggestions.
PHOTON = Provider(name="photon", min_interval_s=0.2, attempts=3, timeout_s=12, backoff_s=0.8)

OVERPASS = Provider(
    name="overpass",
    min_interval_s=1.0,
    attempts=2,
    timeout_s=config.OVERPASS_TIMEOUT,
    backoff_s=3.0,
)

# Municipal WFS / open-data endpoints: slow but not rate limited.
WFS = Provider(name="wfs", min_interval_s=0.0, attempts=3, timeout_s=120, backoff_s=2.0)

# Large file downloads (GTFS feeds); retry but do not hammer.
DOWNLOAD = Provider(name="download", min_interval_s=0.0, attempts=3, timeout_s=180, backoff_s=5.0)

# Routing providers (OpenRouteService and similar).
ROUTING = Provider(name="routing", min_interval_s=0.5, attempts=3, timeout_s=120, backoff_s=2.0)
