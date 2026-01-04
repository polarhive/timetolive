"""
PESU timetable parsing utilities.

This module contains functions for parsing HTML and rendering timetables.
"""

import logging
# Use root logger so messages flow to Flask's console via root configuration
logger = logging.getLogger()
import json
import re
from datetime import datetime

from bs4 import BeautifulSoup
import requests


# Subject mapping cache
_SUBJECT_MAPPING = None
_MAPPING_URL = "https://raw.githubusercontent.com/polarhive/attend/refs/heads/main/frontend/web/mapping.json"


def _load_subject_mapping():
    """Fetch subject mapping JSON (cached). Returns a dict mapping codes to labels."""
    global _SUBJECT_MAPPING
    if _SUBJECT_MAPPING is not None:
        return _SUBJECT_MAPPING
    try:
        resp = requests.get(_MAPPING_URL, timeout=5)
        if resp.ok:
            data = resp.json()
            _SUBJECT_MAPPING = data.get("SUBJECT_MAPPING") or {}
        else:
            _SUBJECT_MAPPING = {}
    except Exception as e:
        logger.warning(f"Failed to load subject mapping: {e}")
        _SUBJECT_MAPPING = {}
    return _SUBJECT_MAPPING


class AuthenticationError(Exception):
    """Raised when authentication or CSRF extraction fails."""


class TimetableScrapingError(Exception):
    """Raised on timetable-specific scraping/parsing failures."""


def build_schedule(
    meta: dict, template_details: list, days: list, tt_json: dict
) -> dict:
    """Build the schedule dict from extracted JS variables and metadata."""
    logger.debug(
        f"build_schedule: template_details type={type(template_details)} len={len(template_details) if hasattr(template_details,'__len__') else 'n/a'}"
    )
    logger.debug(f"build_schedule: days={days}")
    logger.debug(f"build_schedule: tt_json keys={list(tt_json.keys())[:10]}")

    # Build ordered time slots from template details
    slots_by_order: dict[int, dict] = {}
    for item in template_details:
        ordered = int(item.get("orderedBy", 0))
        status = item.get("timeTableTemplateDetailsStatus")
        if status == 1:
            label = item.get("additionalInfo") or "BREAK"
        else:
            additional = item.get("additionalInfo")
            if additional:
                label = additional
            else:
                start = item.get("startTime")
                end = item.get("endTime")
                try:
                    fmt = "%I:%M:%S %p"
                    start_t = datetime.strptime(start, fmt)
                    end_t = datetime.strptime(end, fmt)
                    label = (
                        f"{start_t.strftime('%I:%M %p')}-{end_t.strftime('%I:%M %p')}"
                    )
                except Exception:
                    label = f"{start or ''}-{end or ''}"
        slots_by_order[ordered] = {
            "orderedBy": ordered,
            "label": label,
            "status": status,
        }

    schedule = []
    max_day_idx = len(days)
    ordered_keys = sorted(slots_by_order.keys())
    # Filter to include only slots up to "04:00 PM-04:45 PM" (orderedBy: 9)
    ordered_keys = [k for k in ordered_keys if k <= 9]

    for day_idx in range(1, max_day_idx + 1):
        day_name = days[day_idx - 1] if day_idx - 1 < len(days) else f"Day {day_idx}"
        day_slots = []
        for ordered in ordered_keys:
            slot_meta = slots_by_order[ordered]
            pattern = re.compile(rf"ttDivText_{day_idx}_{ordered}_[0-9]+")
            cells = []
            mapping = _load_subject_mapping()

            for k, v in tt_json.items():
                if pattern.fullmatch(k):
                    # Parse multiple subjects into separate cells
                    current_cell = None
                    for entry in v:
                        if entry.startswith("ttSubject"):
                            if current_cell:
                                cells.append(current_cell)
                            parts = entry.split("&&")
                            val = parts[-1] if parts else entry
                            code, name = val.split("-", 1) if "-" in val else (val, "")

                            # Get mapped subject code if available
                            sub_code = mapping.get(code, "")

                            current_cell = {
                                "subject": val,
                                "code": code,
                                "name": name,
                                "sub_code": sub_code,
                                "faculties": [],
                                "raw": [entry],
                            }
                        elif entry.startswith("ttFaculty") and current_cell:
                            parts = entry.split("&&")
                            val = parts[-1] if parts else entry
                            current_cell["faculties"].append(val)
                            current_cell["raw"].append(entry)
                    if current_cell:
                        cells.append(current_cell)
            day_slots.append({"slot": slot_meta, "cells": cells})
        schedule.append({"day": day_name, "slots": day_slots})

    # Return parsed structure
    return {"meta": meta, "schedule": schedule}


def parse_admin_html(html_text: str) -> dict:
    """Parse the admin timetable HTML and return structured data.

    This extracts the same metadata and JS variables (`timeTableTemplateDetailsJson`,
    `days`, `timeTableJson`) used by `fetch_timetable` and returns the canonical
    dict: {"meta": {...}, "schedule": [...]}
    """
    soup = BeautifulSoup(html_text, "html.parser")

    # Extract simple metadata (Batch, Class Name, Department, Section, Room)
    meta = {}
    for span in soup.find_all("span", {"class": "lbl-title-light"}):
        label = span.get_text(strip=True).rstrip(":")
        value = ""
        if span.next_sibling:
            value = str(span.next_sibling).strip()
        meta[label] = value

    script_text = "\n".join(
        script.string for script in soup.find_all("script") if script.string
    )

    def _extract_js_json(varname: str):
        m = re.search(rf"var\s+{re.escape(varname)}\s*=\s*([\s\S]*?);", script_text)
        if not m:
            raise TimetableScrapingError(f"Could not find JS variable: {varname}")
        js_text = m.group(1)
        try:
            return json.loads(js_text)
        except json.JSONDecodeError as e:
            raise TimetableScrapingError(
                f"Failed to parse {varname} as JSON: {e}\nsnippet: {js_text[:200]}"
            )

    try:
        template_details = _extract_js_json("timeTableTemplateDetailsJson")
    except TimetableScrapingError:
        logger.debug(
            "timeTableTemplateDetailsJson not found; continuing with empty templates"
        )
        template_details = []

    try:
        days = _extract_js_json("days")
    except TimetableScrapingError:
        logger.debug("days not found; defaulting to empty list")
        days = []

    try:
        tt_json = _extract_js_json("timeTableJson")
    except TimetableScrapingError:
        logger.debug("timeTableJson not found; defaulting to empty dict")
        tt_json = {}

    logger.debug(
        f"parse_admin_html: template_details type={type(template_details)} len={len(template_details) if hasattr(template_details,'__len__') else 'n/a'}"
    )
    logger.debug(f"parse_admin_html: days={days}")
    logger.debug(f"parse_admin_html: tt_json keys={list(tt_json.keys())[:10]}")

    return build_schedule(meta, template_details, days, tt_json)
