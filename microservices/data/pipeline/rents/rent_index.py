"""Destatis Index der Nettokaltmieten (2020 = 100), national series."""

from __future__ import annotations

from html.parser import HTMLParser

import pandas as pd

from pipeline import config
from pipeline.common import log
from pipeline.providers import DOWNLOAD

STEP = "rent_index"

_MONTHS = {
    "januar": 1,
    "jan": 1,
    "februar": 2,
    "feb": 2,
    "märz": 3,
    "maerz": 3,
    "mar": 3,
    "april": 4,
    "apr": 4,
    "mai": 5,
    "juni": 6,
    "jun": 6,
    "juli": 7,
    "jul": 7,
    "august": 8,
    "aug": 8,
    "september": 9,
    "sep": 9,
    "oktober": 10,
    "okt": 10,
    "november": 11,
    "nov": 11,
    "dezember": 12,
    "dez": 12,
}


def _norm(text: str) -> str:
    return text.replace("\u00ad", "").replace("\xa0", " ").strip().casefold()


def _number(text: str) -> float | None:
    token = text.strip().replace("\xa0", "").replace(" ", "")
    if not token or token in {"-", ".", "…", "/"}:
        return None
    if "," in token:
        token = token.replace(".", "").replace(",", ".")
    try:
        return float(token)
    except ValueError:
        return None


def _month(text: str) -> int | None:
    return _MONTHS.get(_norm(text))


class _TableParser(HTMLParser):
    """Keep abbr titles and ignore the abbreviated inner text (``August`` + ``Aug``)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[str]] = []
        self._in_cell = False
        self._skip_data = False
        self._row: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = {key: value or "" for key, value in attrs}
        if tag == "tr":
            self._row = []
        elif tag in {"td", "th"}:
            self._in_cell = True
        elif tag == "abbr" and self._in_cell:
            title = attr.get("title", "").strip()
            if title:
                self._row.append(title)
            self._skip_data = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "abbr":
            self._skip_data = False
        elif tag in {"td", "th"}:
            self._in_cell = False
        elif tag == "tr" and self._row:
            self.rows.append(self._row)
            self._row = []

    def handle_data(self, data: str) -> None:
        if not self._in_cell or self._skip_data:
            return
        text = data.strip()
        if text:
            self._row.append(text)


def parse_net_rent_index(html: str) -> list[tuple[int, int, float]]:
    """``(year, month, index)`` for Nettokaltmiete.

    On the Destatis vpi044a table that series is the rightmost value column.
    A year cell with rowspan applies to the following months until the next year.
    """
    parser = _TableParser()
    parser.feed(html)
    series: list[tuple[int, int, float]] = []
    year: int | None = None
    in_series = False
    for row in parser.rows:
        folded = [_norm(cell) for cell in row]
        if any("nettokaltmiete" in cell and "ohne" not in cell for cell in folded):
            in_series = True
            continue
        if not in_series:
            continue
        if folded and folded[0].isdigit() and len(folded[0]) == 4:
            year = int(folded[0])
            rest = row[1:]
        else:
            rest = row
        month = next((_month(cell) for cell in rest if _month(cell) is not None), None)
        numbers = [value for cell in rest if (value := _number(cell)) is not None]
        if year is None or month is None or not numbers:
            continue
        series.append((year, month, numbers[-1]))
    return series


def factor_from_series(series: list[tuple[int, int, float]]) -> tuple[float, str] | None:
    """``latest / May 2022``. None when either point is missing or not positive."""
    base = next((value for year, month, value in series if year == 2022 and month == 5), None)
    if not series or base is None or base <= 0:
        return None
    year, month, latest = max(series)
    if latest <= 0:
        return None
    return latest / base, f"{year:04d}-{month:02d}"


def load_index_factor() -> tuple[float, str] | None:
    """Download the national series, or reuse the cached CSV. Never invent a factor."""
    cache = config.MARKET_CACHE_DIR / "nettokaltmiete_index.csv"
    series: list[tuple[int, int, float]] | None = None
    try:
        resp = DOWNLOAD.get(config.DESTATIS_RENT_INDEX_URL)
        resp.raise_for_status()
        series = parse_net_rent_index(resp.text)
        if series:
            pd.DataFrame(series, columns=["year", "month", "index"]).to_csv(cache, index=False)
    except Exception as exc:  # noqa: BLE001 - offline runs keep the last official series
        log(STEP, f"Destatis index unavailable ({type(exc).__name__}: {exc})")
    if not series and cache.exists():
        frame = pd.read_csv(cache)
        series = [
            (int(row.year), int(row.month), float(row.index))
            for row in frame.itertuples(index=False)
        ]
    if not series:
        return None
    factor = factor_from_series(series)
    if factor is None:
        log(STEP, "Destatis index has no May 2022 base; rents stay in census euros")
    return factor
