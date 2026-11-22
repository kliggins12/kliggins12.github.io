#!/usr/bin/env python3
import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIRS = {"E": 0, "SE": 45, "S": 90, "SW": 135, "W": 180, "NW": 225, "N": 270, "NE": 315}

def keypad_pos(digit):
    d = str(digit)
    if d == "0":
        return (1, 3)
    n = int(d)
    return ((n - 1) % 3, (n - 1) // 3)

def move_dir(a, b):
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    if dx == 0 and dy == 0:
        return "C"
    ang = math.degrees(math.atan2(dy, dx)) % 360
    return min(DIRS, key=lambda name: abs((ang - DIRS[name] + 180) % 360 - 180))

def shape_of(numbers):
    pts = [keypad_pos(n) for n in numbers]
    return ">".join(move_dir(pts[i], pts[i + 1]) for i in range(len(pts) - 1))

def load_rows(path):
    data = json.loads(Path(path).read_text())
    rows = data["rows"]
    rows.sort(key=lambda r: (r["year"], r["month"], r["day"]))
    return rows

def build(rows, order):
    shapes = [shape_of(r["numbers"]) for r in rows]
    shape_counts = Counter(shapes)
    transitions = defaultdict(Counter)
    for i in range(order, len(shapes)):
        state = "|".join(shapes[i - order:i])
        transitions[state][shapes[i]] += 1
    return shapes, shape_counts, transitions

def predict(transitions, state, top):
    counter = transitions.get(state, Counter())
    total = sum(counter.values())
    out = []
    for shape, count in counter.most_common(top):
        out.append({"shape": shape, "count": count, "probability": round(count / total, 6) if total else 0.0})
    return {"state": state, "total": total, "predictions": out}

def main():
    ap = argparse.ArgumentParser(description="Markov chain over Pick 3 dialpad movement shapes.")
    ap.add_argument("--input", default="data/normalized/pick3_morning.json")
    ap.add_argument("--order", type=int, default=1)
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--output", default=None)
    args = ap.parse_args()

    rows = load_rows(args.input)
    if not rows:
        raise SystemExit("No rows found.")
    shapes, shape_counts, transitions = build(rows, args.order)
    last_state = "|".join(shapes[-args.order:])
    pred = predict(transitions, last_state, args.top)

    slug = Path(args.input).stem
    out_path = Path(args.output) if args.output else ROOT / "data" / "markov" / f"{slug}_markov_o{args.order}.json"
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
        "predictions": pred["predictions"],
        "transitions": {state: dict(counter) for state, counter in transitions.items()},
    }
    out_path.write_text(json.dumps(payload, indent=2) + "\n")

    print(f"Rows: {len(rows)}")
    print(f"Unique shapes: {len(shape_counts)}")
    print(f"Last draw: {rows[-1]['date']} {rows[-1]['numbers']} -> {shapes[-1]}")
    print(f"Last state (order {args.order}): {last_state}")
    print("Top shape counts:")
    for shape, count in shape_counts.most_common(10):
        print(f"  {shape}: {count}")
    print(f"Top next-shape predictions (state={last_state}, total={pred['total']}):")
    for item in pred["predictions"]:
        print(f"  {item['shape']}: {item['count']} ({item['probability']:.2%})")
    print(f"Wrote {out_path}")

if __name__ == "__main__":
    main()
