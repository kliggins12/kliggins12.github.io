#!/usr/bin/env python3
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NORM = ROOT / "data" / "normalized"
SESSIONS = ["pick3_morning", "pick3_day", "pick3_evening", "pick3_night"]
SESSION_ORDER = {"morning": 0, "day": 1, "evening": 2, "night": 3}

def write_payload(path, slug, rows, extra=None):
    source = {"slug": slug, "game": "Pick 3", "session": "all", "combined_from": SESSIONS}
    if extra:
        source.update(extra)
    path.write_text(json.dumps({"source": source, "rows": rows}, indent=2) + "\n")

def main():
    rows = []
    for slug in SESSIONS:
        path = NORM / f"{slug}.json"
        if not path.exists():
            raise SystemExit(f"Missing {path}; run fetch_texas.py for Pick 3 sessions first.")
        data = json.loads(path.read_text())
        for row in data["rows"]:
            row = dict(row)
            row["source"] = "pick3_all"
            row["session_order"] = SESSION_ORDER.get(row.get("session"), 99)
            rows.append(row)
    rows.sort(key=lambda r: (r["year"], r["month"], r["day"], r["session_order"]))

    by_date = {}
    for row in rows:
        by_date.setdefault(row["date"], set()).add(row.get("session"))
    synced_dates = {date for date, sessions in by_date.items() if sessions == {"morning", "day", "evening", "night"}}
    synced_rows = [row for row in rows if row["date"] in synced_dates]

    out_all = NORM / "pick3_all.json"
    out_synced = NORM / "pick3_all_synced.json"
    write_payload(out_all, "pick3_all", rows)
    write_payload(out_synced, "pick3_all_synced", synced_rows, {"synced_dates": len(synced_dates), "requires_sessions": ["morning", "day", "evening", "night"]})
    print(f"Wrote {out_all} with {len(rows)} rows")
    print(f"Wrote {out_synced} with {len(synced_rows)} rows across {len(synced_dates)} synced dates")

if __name__ == "__main__":
    main()
