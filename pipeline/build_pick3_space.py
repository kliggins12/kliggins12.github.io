#!/usr/bin/env python3
import argparse
import csv
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REGION = {
    "1": "corner", "3": "corner", "7": "corner", "9": "corner",
    "2": "edge", "4": "edge", "6": "edge", "8": "edge",
    "5": "center",
    "0": "zero",
}
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

def path_shape(digits):
    pts = [keypad_pos(d) for d in digits]
    return ">".join(move_dir(pts[i], pts[i + 1]) for i in range(len(pts) - 1))

def entry(number):
    digits = [int(c) for c in f"{number:03d}"]
    return {
        "number": f"{number:03d}",
        "digits": digits,
        "regions": [REGION[str(d)] for d in digits],
        "path": path_shape(digits),
    }

def main():
    ap = argparse.ArgumentParser(description="Build the Pick 3 000-999 sample-space database.")
    ap.add_argument("--output", default="data/pick3_space.json")
    ap.add_argument("--csv", default="data/pick3_space.csv")
    args = ap.parse_args()

    entries = [entry(i) for i in range(1000)]
    json_path = ROOT / args.output
    csv_path = ROOT / args.csv
    json_path.parent.mkdir(parents=True, exist_ok=True)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(entries, indent=2) + "\n")
    with csv_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["number", "d1", "d2", "d3", "r1", "r2", "r3", "path"])
        writer.writeheader()
        for e in entries:
            writer.writerow({
                "number": e["number"],
                "d1": e["digits"][0], "d2": e["digits"][1], "d3": e["digits"][2],
                "r1": e["regions"][0], "r2": e["regions"][1], "r3": e["regions"][2],
                "path": e["path"],
            })
    print(f"Wrote {len(entries)} entries")
    print(f"JSON: {json_path}")
    print(f"CSV:  {csv_path}")

if __name__ == "__main__":
    main()
