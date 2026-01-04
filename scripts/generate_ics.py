#!/usr/bin/env python3
"""Generate an example .ics from a timetable JSON for quick verification."""
from datetime import date
import json
from pathlib import Path

# Reuse parsing helpers (copy minimal logic from app.timetable_to_ics)
import re

_DAY_NAME_TO_INDEX = {
    "Monday": 0,
    "Tuesday": 1,
    "Wednesday": 2,
    "Thursday": 3,
    "Friday": 4,
    "Saturday": 5,
    "Sunday": 6,
}
_DAY_TO_BYDAY = {
    k: v
    for k, v in zip(
        _DAY_NAME_TO_INDEX.keys(), ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
    )
}


def _parse_time_range(label: str):
    m = re.search(
        r"(\d{1,2}:\d{2})\s*([AaPp][Mm])?\s*-\s*(\d{1,2}:\d{2})\s*([AaPp][Mm])?", label
    )
    if not m:
        return None

    def to24(t, ampm):
        h, mm = [int(x) for x in t.split(":")]
        if ampm:
            a = ampm.strip().lower()
            if a == "pm" and h < 12:
                h += 12
            if a == "am" and h == 12:
                h = 0
        return h, mm

    sh, sm = to24(m.group(1), m.group(2))
    eh, em = to24(m.group(3), m.group(4))
    return sh, sm, eh, em


def _next_date_for_weekday(weekday_index: int, start=None):
    from datetime import date, timedelta

    if start is None:
        start = date.today()
    days_ahead = (weekday_index - start.weekday()) % 7
    return start + timedelta(days=days_ahead)


# mapping and elective helpers
_MAPPING_URL = "https://raw.githubusercontent.com/polarhive/attend/refs/heads/main/frontend/web/mapping.json"


def _load_subject_mapping_local():
    try:
        import requests

        resp = requests.get(_MAPPING_URL, timeout=2)
        if resp.ok:
            data = resp.json()
            return data.get("SUBJECT_MAPPING") or {}
    except Exception:
        pass
    return {}


def _get_elective_group_local(code: str):
    import re

    if not code:
        return None
    m = re.search(r"UE\d+CS\d+(AA|AB|BA|BB)\d+", code)
    if not m:
        return None
    groups = {"AA": "E1", "AB": "E2", "BA": "E3", "BB": "E4"}
    return groups.get(m.group(1))


def _summary_label_local(c: dict, mapping: dict):
    code = c.get("code") or (c.get("subject") or "").split("-")[0]
    elective = _get_elective_group_local(code)
    if elective:
        return elective
    if code and code in mapping:
        return mapping[code]
    subj = c.get("subject") or ""
    if subj and "-" in subj:
        parts = subj.split("-", 1)
        if len(parts) > 1 and parts[1].strip():
            return parts[1].strip()
    return c.get("name") or str(code or "")


def timetable_to_ics_local(timetable: dict):
    from datetime import datetime

    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//timetolive//Timetable//EN"]
    meta = timetable.get("meta") or {}
    room = meta.get("Room") or meta.get("Batch") or ""
    for day in timetable.get("schedule") or []:
        dn = day.get("day")
        if dn not in _DAY_NAME_TO_INDEX:
            continue
        idx = _DAY_NAME_TO_INDEX[dn]
        fd = _next_date_for_weekday(idx)
        for slot in day.get("slots") or []:
            if (slot.get("slot") or {}).get("status") == 1:
                continue
            tl = (slot.get("slot") or {}).get("label") or ""
            tvals = _parse_time_range(tl)
            if not tvals:
                continue
            sh, sm, eh, em = tvals
            seen = set()
            for c in slot.get("cells") or []:
                code = c.get("code") or (c.get("subject") or c.get("name") or "")
                if code in seen:
                    continue
                seen.add(code)

                # Escape helper for ICS text
                def _escape_ics_text(s: str) -> str:
                    return (
                        str(s)
                        .replace("\\", "\\\\")
                        .replace("\n", "\\n")
                        .replace(";", "\\;")
                        .replace(",", "\\,")
                    )

                mapping = _load_subject_mapping_local()
                summary = _escape_ics_text(_summary_label_local(c, mapping))

                faculties = c.get("faculties") or []
                description = ""
                if faculties:
                    description = _escape_ics_text("Faculties: " + ", ".join(faculties))

                from time import time

                uid = f"{code}-{dn}-{(slot.get('slot') or {}).get('orderedBy', 0)}-{int(time())}@timetolive"
                dtstart = datetime(fd.year, fd.month, fd.day, sh, sm, 0)
                dtend = datetime(fd.year, fd.month, fd.day, eh, em, 0)
                lines.append("BEGIN:VEVENT")
                lines.append(f"UID:{uid}")
                lines.append(f"SUMMARY:{summary}")
                if description:
                    lines.append(f"DESCRIPTION:{description}")
                if room:
                    lines.append(f"LOCATION:{_escape_ics_text(room)}")
                lines.append(f"DTSTART:{dtstart.strftime('%Y%m%dT%H%M%S')}")
                lines.append(f"DTEND:{dtend.strftime('%Y%m%dT%H%M%S')}")
                byday = _DAY_TO_BYDAY.get(dn)
                if byday:
                    lines.append(f"RRULE:FREQ=WEEKLY;BYDAY={byday}")
                lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines)


if __name__ == "__main__":
    p = Path(__file__).parent.parent / "static" / "timetables" / "example_sem6A.json"
    data = json.loads(p.read_text())
    ics = timetable_to_ics_local(data)
    print("\n".join(ics.splitlines()[:60]))
