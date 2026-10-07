"""Minimal xlsx reader. The public GREIX workbook does not need openpyxl."""

from __future__ import annotations

import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def _column_index(ref: str) -> int:
    letters = "".join(ch for ch in ref if ch.isalpha())
    number = 0
    for ch in letters:
        number = number * 26 + (ord(ch.upper()) - 64)
    return number - 1


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    values: list[str] = []
    for item in root.findall("m:si", _NS):
        values.append("".join(node.text or "" for node in item.iter(f"{{{_NS['m']}}}t")))
    return values


def _sheet_path(archive: zipfile.ZipFile, sheet: str | None) -> str:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {node.get("Id"): node.get("Target") for node in rels}
    chosen: str | None = None
    for node in workbook.findall("m:sheets/m:sheet", _NS):
        name = node.get("name") or ""
        target = targets.get(node.get(f"{_REL}id"))
        if target is None:
            continue
        path = target if target.startswith("xl/") else f"xl/{target.lstrip('/')}"
        if sheet is None or name == sheet:
            chosen = path
            if sheet is not None:
                break
    if chosen is None:
        raise ValueError(f"sheet {sheet!r} not in workbook")
    return chosen


def _cell_value(cell: ET.Element, shared: list[str]) -> object:
    kind = cell.get("t")
    if kind == "inlineStr":
        return "".join(node.text or "" for node in cell.iter(f"{{{_NS['m']}}}t"))
    node = cell.find("m:v", _NS)
    if node is None or node.text is None:
        return None
    raw = node.text
    if kind == "s":
        return shared[int(raw)]
    if kind == "b":
        return raw == "1"
    try:
        number = float(raw)
    except ValueError:
        return raw
    if number.is_integer():
        return int(number)
    return number


def read_xlsx_rows(path: Path, sheet: str | None = None) -> list[dict[str, object]]:
    """First row is the header. Empty rows are skipped."""
    with zipfile.ZipFile(path) as archive:
        shared = _shared_strings(archive)
        root = ET.fromstring(archive.read(_sheet_path(archive, sheet)))
    matrix: list[list[object]] = []
    for row in root.findall(".//m:sheetData/m:row", _NS):
        values: dict[int, object] = {}
        for cell in row.findall("m:c", _NS):
            ref = cell.get("r") or ""
            index = _column_index(ref) if ref else len(values)
            values[index] = _cell_value(cell, shared)
        if not values:
            continue
        width = max(values) + 1
        matrix.append([values.get(i) for i in range(width)])
    if not matrix:
        return []
    header = [str(cell).strip() if cell is not None else "" for cell in matrix[0]]
    records: list[dict[str, object]] = []
    for raw in matrix[1:]:
        record = {key: raw[i] if i < len(raw) else None for i, key in enumerate(header) if key}
        if any(value not in (None, "") for value in record.values()):
            records.append(record)
    return records
