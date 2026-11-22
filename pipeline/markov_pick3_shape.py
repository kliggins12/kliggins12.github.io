#!/usr/bin/env python3
import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REGION = {
    "1": "corner", "3": "corner", "7": "corner", "9": "corner",
    "2": "edge", "4": "edge", "6": "edge", "8": "edge",
    "5": "center",
    "0": "zero",
}
SESSION_ORDER = {"morning": 0, "day": 1, "evening": 2, "night": 3}

def load_rows(path):
    data = json.loads(Path(path).read_text())
    rows = data["rows"]
    rows.sort(key=lambda r: (r["year"], r["month"], r["day"], r.get("session_order", SESSION_ORDER.get(r.get("session"), 99))))
    return rows

def triple_of(row):
    return "|".join(REGION[str(d)] for d in row["numbers"])

def state_key(seq):
    return "||".join(seq)

def main():
    ap = argparse.ArgumentParser(description="Markov chain over Pick 3 dialpad region triples.")
    ap.add_argument("--input", default="data/normalized/pick3_morning.json")
    ap.add_argument("--order", type=int, default=1)
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--output", default=None)
    args = ap.parse_args()

    rows = load_rows(args.input)
    triples = [triple_of(r) for r in rows]
    counts = defaultdict(Counter)
    shape_counts = Counter(triples)
    for i in range(args.order, len(triples)):
        state = state_key(triples[i - args.order:i])
        counts[state][triples[i]] += 1

    last_state = state_key(triples[-args.order:])
    counter = counts.get(last_state, Counter())
    total = sum(counter.values())
    preds = [{"shape": s, "count": c, "probability": round(c / total, 6) if total else 0.0} for s, c in counter.most_common(args.top)]

    slug = Path(args.input).stem
    out_path = Path(args.output) if args.output else ROOT / "data" / "markov" / f"{slug}_shape_o{args.order}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "input": str(Path(args.input)),
        "order": args.order,
        "rows": len(rows),
        "unique_shapes": len(shape_counts),
        "shape_counts": dict(shape_counts.most_common()),
        "last_state": last_state,
        "last_numbers": rows[-1]["numbers"],
        "last_date": rows[-1]["date"],
        "predictions": preds,
        "transitions": {state: dict(c) for state, c in counts.items()},
    }
    out_path.write_text(json.dumps(payload, indent=2) + "\n")

    print(f"Rows: {len(rows)}")
    print(f"Unique region triples: {len(shape_counts)}")
    print(f"Last draw: {rows[-1]['date']} {rows[-1]['numbers']} -> {triples[-1]}")
    print(f"Last state (order {args.order}): {last_state}  (observations={total})")
    print("Top next shapes:")
    for item in preds:
        print(f"  {item['shape']}: {item['count']} ({item['probability']:.2%})")
    print(f"Wrote {out_path}")

if __name__ == "__main__":
    main()
