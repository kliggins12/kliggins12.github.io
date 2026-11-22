#!/usr/bin/env python3
"""Refresh Texas Lottery data, regenerate Ahead candidates, and update index.html."""
import argparse
import hashlib
import html
import json
import re
import subprocess
from pathlib import Path

PIPE = Path(__file__).resolve().parent
SITE = PIPE.parent
NORM = PIPE / "data" / "normalized"
COND = PIPE / "data" / "conditions"
ANSWERS = COND / "upcoming_answers.txt"
STATE = SITE / "ahead_publish_state.json"
INDEX = SITE / "index.html"

TARGETS = (
    [f"pick3_{s}" for s in ("morning", "day", "evening", "night", "all_synced")]
    + [f"daily4_{s}" for s in ("morning", "day", "evening", "night", "all_synced")]
    + [f"allornothing_{s}" for s in ("morning", "day", "evening", "night", "all_synced")]
    + ["cashfive", "lottotexas", "texastwostep", "powerball", "megamillions"]
)

FETCH = [["python3", "fetch_texas.py", "--force"]]
COMBINE = [
    ["python3", "combine_pick3.py"],
    ["python3", "combine_daily4.py"],
    ["python3", "combine_allornothing.py"],
]
SPACE = [
    ["python3", "build_pick3_space.py"],
    ["python3", "build_daily4_space.py"],
    ["python3", "build_draw_sequence.py"],
]
MINERS = [
    ["python3", "mine_pick3_booleans_universal.py"],
    ["python3", "mine_daily4_booleans_universal.py"],
    ["python3", "mine_allornothing_booleans.py"],
    ["python3", "mine_big_games_universal.py"],
]
BUILD = [["python3", "build_upcoming_answers.py"]]


def run(cmd):
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=PIPE, check=True)


def rows_for(slug):
    path = NORM / f"{slug}.json"
    if not path.exists():
        return []
    data = json.loads(path.read_text())
    return data.get("rows", data) if isinstance(data, dict) else data


def latest_dates():
    out = {}
    for slug in TARGETS:
        dates = [str(r.get("date", "")) for r in rows_for(slug) if r.get("date")]
        out[slug] = max(dates) if dates else None
    return out


def load_state():
    if STATE.exists():
        return json.loads(STATE.read_text())
    return {}


def save_state(state):
    STATE.write_text(json.dumps(state, indent=1) + "\n")


def refresh_data():
    for cmd in FETCH + COMBINE:
        run(cmd)


def build_answers():
    COND.mkdir(parents=True, exist_ok=True)
    for cmd in SPACE + MINERS + BUILD:
        run(cmd)


def update_index(asset_text):
    page = INDEX.read_text()
    escaped = html.escape(asset_text)
    pattern = re.compile(r'(<div class="panel"><pre>).*?(</pre></div>)', re.S)
    if not pattern.search(page):
        raise RuntimeError('index.html missing <div class="panel"><pre> marker')
    new_page = pattern.sub(lambda m: m.group(1) + escaped + m.group(2), page, count=1)
    INDEX.write_text(new_page)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="Rebuild and publish even if latest dates are unchanged")
    ap.add_argument("--check-only", action="store_true", help="Only report whether latest dates changed vs last publish")
    args = ap.parse_args()

    if args.check_only:
        state = load_state()
        latest = latest_dates()
        changed = {k: (state.get("latest_dates", {}).get(k), v) for k, v in latest.items() if state.get("latest_dates", {}).get(k) != v}
        print(json.dumps({"changed_targets": changed, "state_latest": state.get("latest_dates", {})}, indent=1))
        return

    refresh_data()
    latest = latest_dates()
    state = load_state()
    prev = state.get("latest_dates", {})
    changed = {k: v for k, v in latest.items() if prev.get(k) != v}
    if not args.force and not changed:
        print("no new draws since last publish; skipping miners/build/publish")
        return
    if changed:
        print("changed targets:", json.dumps(changed, indent=1))

    build_answers()
    asset_text = ANSWERS.read_text()
    update_index(asset_text)
    save_state({"latest_dates": latest, "asset_sha256": hashlib.sha256(asset_text.encode("utf-8")).hexdigest()})
    print("updated index.html")


if __name__ == "__main__":
    main()
