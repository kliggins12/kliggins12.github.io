#!/usr/bin/env python3
import argparse
import csv
import json
import shutil
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://www.texaslottery.com/export/sites/lottery/Games"
ROOT = Path(__file__).resolve().parent
RAW_DIR = ROOT / "data" / "raw"
NORM_DIR = ROOT / "data" / "normalized"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"

SESSIONS = ["morning", "day", "evening", "night"]
SESSION_ORDER = {name: i for i, name in enumerate(SESSIONS)}

def csv_url(game_dir, filename):
    return f"{BASE}/{game_dir}/Winning_Numbers/{filename}"

SOURCES = []
for game_name, slug_prefix, game_dir, main_count in [
    ("Pick 3", "pick3", "Pick_3", 3),
    ("Daily 4", "daily4", "Daily_4", 4),
    ("All or Nothing", "allornothing", "All_or_Nothing", 12),
]:
    trailing = ["sum_it_up", "fireball"] if main_count in (3, 4) else []
    for session in SESSIONS:
        SOURCES.append({
            "slug": f"{slug_prefix}_{session}",
            "game": game_name,
            "session": session,
            "url": csv_url(game_dir, f"{slug_prefix}{session}.csv"),
            "main_count": main_count,
            "trailing": trailing,
        })

SOURCES += [
    {"slug": "cashfive", "game": "Cash Five", "session": None, "url": csv_url("Cash_Five", "cashfive.csv"), "main_count": 5, "trailing": []},
    {"slug": "lottotexas", "game": "Lotto Texas", "session": None, "url": csv_url("Lotto_Texas", "lottotexas.csv"), "main_count": 6, "trailing": ["bonus_ball"]},
    {"slug": "texastwostep", "game": "Texas Two Step", "session": None, "url": csv_url("Texas_Two_Step", "texastwostep.csv"), "main_count": 4, "trailing": ["bonus_ball"]},
    {"slug": "megamillions", "game": "Mega Millions", "session": None, "url": csv_url("Mega_Millions", "megamillions.csv"), "main_count": 5, "trailing": ["mega_ball", "megaplier"]},
    {"slug": "powerball", "game": "Powerball", "session": None, "url": csv_url("Powerball", "powerball.csv"), "main_count": 5, "trailing": ["powerball", "power_play"]},
]

def to_int(value):
    value = (value or "").strip()
    return int(value) if value else None

def to_scalar(value):
    value = (value or "").strip()
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return value

def download(source, force=False):
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    filename = source["url"].rsplit("/", 1)[-1]
    target = RAW_DIR / filename
    tmp = target.with_name(target.name + ".tmp")
    if target.exists() and not force:
        return target, False
    req = urllib.request.Request(source["url"], headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp, tmp.open("wb") as out:
        shutil.copyfileobj(resp, out)
    tmp.replace(target)
    return target, True

def parse_row(source, row):
    if not row or not row[0].strip():
        return None
    game, month, day, year = (row[i].strip() for i in range(4))
    month_i, day_i, year_i = int(month), int(day), int(year)
    values = row[4:]
    numbers = [to_int(v) for v in values[:source["main_count"]]]
    if any(n is None for n in numbers):
        raise ValueError(f"bad numbers in row: {row}")
    record = {
        "source": source["slug"],
        "game": game or source["game"],
        "session": source["session"],
        "month": month_i,
        "day": day_i,
        "year": year_i,
        "date": f"{year_i:04d}-{month_i:02d}-{day_i:02d}",
        "numbers": numbers,
    }
    rest = values[source["main_count"]:]
    for name, value in zip(source["trailing"], rest):
        record[name] = to_scalar(value)
    extras = [to_scalar(v) for v in rest[len(source["trailing"]):] if (v or "").strip()]
    if extras:
        record["extras"] = extras
    return record

def normalize(source, raw_path):
    rows, errors = [], []
    with raw_path.open(newline="", encoding="utf-8-sig") as f:
        for line_no, row in enumerate(csv.reader(f), 1):
            try:
                record = parse_row(source, row)
            except Exception as exc:
                errors.append({"line": line_no, "error": str(exc), "row": row})
                continue
            if record:
                rows.append(record)
    rows.sort(key=lambda r: (r["year"], r["month"], r["day"], SESSION_ORDER.get(r.get("session"), 99)))
    return rows, errors

def main():
    parser = argparse.ArgumentParser(description="Fetch and normalize Texas Lottery CSV draws.")
    parser.add_argument("--only", help="Comma-separated source slugs to fetch")
    parser.add_argument("--force", action="store_true", help="Re-download even if raw CSV exists")
    parser.add_argument("--raw-only", action="store_true", help="Download CSVs without writing normalized JSON")
    args = parser.parse_args()

    wanted = set(args.only.split(",")) if args.only else None
    sources = [s for s in SOURCES if wanted is None or s["slug"] in wanted]
    if wanted:
        missing = wanted - {s["slug"] for s in sources}
        if missing:
            print(f"Unknown slugs: {', '.join(sorted(missing))}", file=sys.stderr)
            return 2

    NORM_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {"generated_at": datetime.now(timezone.utc).isoformat(), "sources": []}
    total_rows = total_errors = 0
    for source in sources:
        raw_path, downloaded = download(source, force=args.force)
        item = {"slug": source["slug"], "game": source["game"], "session": source["session"], "url": source["url"], "raw": str(raw_path.relative_to(ROOT)), "downloaded": downloaded}
        if not args.raw_only:
            rows, errors = normalize(source, raw_path)
            norm_path = NORM_DIR / f"{source['slug']}.json"
            norm_path.write_text(json.dumps({"source": item, "rows": rows}, indent=2) + "\n", encoding="utf-8")
            item.update({"normalized": str(norm_path.relative_to(ROOT)), "rows": len(rows), "errors": len(errors)})
            total_rows += len(rows)
            total_errors += len(errors)
            if errors:
                err_path = NORM_DIR / f"{source['slug']}.errors.json"
                err_path.write_text(json.dumps(errors, indent=2) + "\n", encoding="utf-8")
                item["errors_file"] = str(err_path.relative_to(ROOT))
        manifest["sources"].append(item)
        print(f"{source['slug']}: {'downloaded' if downloaded else 'cached'} -> {raw_path.name}")

    (NORM_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    if not args.raw_only:
        print(f"Normalized {total_rows} rows with {total_errors} parse errors.")
    print(f"Manifest: {NORM_DIR / 'manifest.json'}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
