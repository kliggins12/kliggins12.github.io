#!/usr/bin/env python3
"""Build the global Texas draw sequence across games and sessions.

Order per session: All or Nothing -> Daily 4 -> Pick 3.
Sessions order: morning -> day -> evening -> night.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "data" / "normalized" / "draw_sequence.json"

SESSION_ORDER = {"morning": 0, "day": 1, "evening": 2, "night": 3}
GAME_ORDER = {"allornothing": 0, "daily4": 1, "pick3": 2}
SOURCES = {
    "pick3": ["pick3_morning", "pick3_day", "pick3_evening", "pick3_night"],
    "daily4": ["daily4_morning", "daily4_day", "daily4_evening", "daily4_night"],
    "allornothing": ["allornothing_morning", "allornothing_day", "allornothing_evening", "allornothing_night"],
}


def main():
    events = []
    for game, slugs in SOURCES.items():
        for slug in slugs:
            path = ROOT / "data" / "normalized" / f"{slug}.json"
            if not path.exists():
                continue
            data = json.loads(path.read_text())
            rows = data.get("rows", data) if isinstance(data, dict) else data
            for row in rows:
                sess = row.get("session") or slug.rsplit("_", 1)[-1]
                events.append({
                    "date": row["date"],
                    "session": sess,
                    "session_order": SESSION_ORDER.get(sess, 99),
                    "game": game,
                    "game_order": GAME_ORDER[game],
                    "numbers": row.get("numbers", []),
                    "slug": slug,
                })
    events.sort(key=lambda e: (e["date"], e["session_order"], e["game_order"]))
    # attach previous/next global event indexes
    for i, e in enumerate(events):
        e["seq_index"] = i
        e["prev_seq_index"] = i - 1 if i else None
        e["next_seq_index"] = i + 1 if i + 1 < len(events) else None
    by_key = {}
    for e in events:
        by_key.setdefault((e["date"], e["session"], e["game"]), e)
    OUT.write_text(json.dumps({"events": events, "by_key": {f"{d}|{s}|{g}": v for (d, s, g), v in by_key.items()}}, indent=1))
    print(f"events={len(events)} dates={len({e['date'] for e in events})}")
    for e in events[-12:]:
        print(e["date"], e["session"], e["game"], e["numbers"])


if __name__ == "__main__":
    main()
