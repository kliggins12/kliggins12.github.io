#!/usr/bin/env python3
import argparse
import csv
import json
from pathlib import Path

from build_pick3_space import REGION, path_shape

ROOT = Path(__file__).resolve().parent

def entry(number):
    digits = [int(c) for c in f"{number:04d}"]
    return {
        "number": f"{number:04d}",
        "digits": digits,
        "regions": [REGION[str(d)] for d in digits],
        "path": path_shape(digits),
    }

def main():
    ap = argparse.ArgumentParser(description="Build the Daily 4 0000-9999 sample-space database.")
    ap.add_argument("--output", default="data/daily4_space.json")
    ap.add_argument("--csv", default="data/daily4_space.csv")
    args = ap.parse_args()

    entries = [entry(i) for i in range(10000)]
    json_path = ROOT / args.output
    csv_path = ROOT / args.csv
    json_path.parent.mkdir(parents=True, exist_ok=True)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(entries, indent=2) + "\n")
    with csv_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["number", "d1", "d2", "d3", "d4", "r1", "r2", "r3", "r4", "path"])
        writer.writeheader()
        for e in entries:
            writer.writerow({
                "number": e["number"],
                "d1": e["digits"][0], "d2": e["digits"][1], "d3": e["digits"][2], "d4": e["digits"][3],
                "r1": e["regions"][0], "r2": e["regions"][1], "r3": e["regions"][2], "r4": e["regions"][3],
                "path": e["path"],
            })
    print(f"Wrote {len(entries)} entries")
    print(f"JSON: {json_path}")
    print(f"CSV:  {csv_path}")

if __name__ == "__main__":
    main()
