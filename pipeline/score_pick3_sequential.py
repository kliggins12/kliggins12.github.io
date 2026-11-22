#!/usr/bin/env python3
import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

from markov_pick3_shape import load_rows, REGION
from build_pick3_space import path_shape
from markov_pick3 import keypad_pos, move_dir

ROOT = Path(__file__).resolve().parent
ORDER = ["morning", "day", "evening", "night"]
ALPHA = 1.0

PRESS_FEATURES = {
    0: ["prev_third_digit_o2", "same_pos_digit_o2", "path", "draw_triple", "prev_third_region_o2", "prev_last_two_regions"],
    1: ["same_pos_digit_o2", "prev_third_digit_o2", "same_draw_prev_digit", "same_draw_prev_region", "path", "draw_triple", "prev_last_two_regions"],
    2: ["same_draw_earlier_digits", "same_draw_earlier_regions", "same_pos_digit_o2", "prev_third_digit_o2", "path", "draw_triple", "same_draw_prev_digit"],
}

def bucket_sum(total):
    if total <= 9: return "0-9"
    if total <= 14: return "10-14"
    if total <= 19: return "15-19"
    if total <= 24: return "20-24"
    return "25-27"

def eq_pattern(d):
    a, b, c = d
    if a == b == c: return "AAA"
    if a == b: return "AAB"
    if a == c: return "ABA"
    if b == c: return "ABB"
    return "ABC"

def cross_features(rows, j, pos, next_session):
    prev = rows[j - 1]
    prev2 = rows[j - 2] if j >= 2 else None
    digs = prev["numbers"]
    regs = [REGION[str(d)] for d in digs]
    f = {
        "same_pos_region": regs[pos],
        "same_pos_digit": str(digs[pos]),
        "prev_third_digit": str(digs[2]),
        "prev_third_region": regs[2],
        "prev_tail_path": move_dir(keypad_pos(digs[1]), keypad_pos(digs[2])),
        "prev_last_two_regions": f"{regs[1]}|{regs[2]}",
        "draw_triple": "|".join(regs),
        "path": path_shape(digs),
        "prev_session": prev.get("session") or "none",
        "next_session": next_session or "none",
        "session_pair": f"{prev.get('session') or 'none'}>{next_session or 'none'}",
        "eq_pattern": eq_pattern(digs),
        "sum_bucket": bucket_sum(sum(digs)),
        "odd_count": str(sum(d % 2 for d in digs)),
        "high_count": str(sum(d >= 5 for d in digs)),
        "other_regions": "|".join(regs[k] for k in range(3) if k != pos),
    }
    if prev2 is not None:
        f["same_pos_region_o2"] = f"{REGION[str(prev2['numbers'][pos])]}|{regs[pos]}"
        f["same_pos_digit_o2"] = f"{prev2['numbers'][pos]}|{digs[pos]}"
        f["prev_third_region_o2"] = f"{REGION[str(prev2['numbers'][2])]}|{regs[2]}"
        f["prev_third_digit_o2"] = f"{prev2['numbers'][2]}|{digs[2]}"
    return f

def same_draw_features(pos, earlier):
    if pos == 0 or not earlier:
        return {}
    regs = [REGION[str(d)] for d in earlier]
    return {
        "same_draw_prev_region": regs[-1],
        "same_draw_prev_digit": str(earlier[-1]),
        "same_draw_earlier_regions": "|".join(regs),
        "same_draw_earlier_digits": "|".join(str(d) for d in earlier),
    }

def upcoming_session(rows):
    sessions = {r.get("session") for r in rows}
    last = rows[-1].get("session")
    if len(sessions) <= 1:
        return last
    if last in ORDER:
        return ORDER[(ORDER.index(last) + 1) % len(ORDER)]
    return last

def press_dist(feats, pos, counts, priors):
    prior_total = sum(priors[pos].values()) or 1
    prior = {d: (priors[pos].get(str(d), 0) + ALPHA) / (prior_total + ALPHA * 10) for d in range(10)}
    logp = {d: math.log(prior[d]) for d in range(10)}
    for feat in PRESS_FEATURES[pos]:
        state = feats.get(feat)
        if state is None:
            continue
        table = counts[pos].get(feat, {}).get(state)
        if not table:
            continue
        total = sum(table.values())
        for d in range(10):
            cond = (table.get(str(d), 0) + ALPHA) / (total + ALPHA * 10)
            logp[d] += math.log(cond / max(prior[d], 1e-9))
    peak = max(logp.values())
    exp = {d: math.exp(logp[d] - peak) for d in range(10)}
    norm = sum(exp.values())
    return {d: exp[d] / norm for d in range(10)}

def main():
    ap = argparse.ArgumentParser(description="Sequential first->second->third Pick 3 scorer.")
    ap.add_argument("--input", default="data/normalized/pick3_all_synced.json")
    ap.add_argument("--space", default="data/pick3_space.json")
    ap.add_argument("--top", type=int, default=20)
    ap.add_argument("--output", default=None)
    args = ap.parse_args()

    rows = load_rows(args.input)
    space = json.loads((ROOT / args.space).read_text())
    counts = {p: defaultdict(lambda: defaultdict(Counter)) for p in range(3)}
    priors = {p: Counter() for p in range(3)}

    for j in range(1, len(rows)):
        next_session = rows[j].get("session")
        for pos in range(3):
            feats = cross_features(rows, j, pos, next_session)
            feats.update(same_draw_features(pos, rows[j]["numbers"][:pos]))
            outcome = str(rows[j]["numbers"][pos])
            priors[pos][outcome] += 1
            for feat, state in feats.items():
                counts[pos][feat][state][outcome] += 1

    upcoming = upcoming_session(rows)
    base = cross_features(rows, len(rows), 0, upcoming)
    dist0 = press_dist(base, 0, counts, priors)

    dist1 = {}
    for a in range(10):
        feats = dict(base)
        feats.update(cross_features(rows, len(rows), 1, upcoming))
        feats.update(same_draw_features(1, [a]))
        dist1[a] = press_dist(feats, 1, counts, priors)

    dist2 = {}
    for a in range(10):
        for b in range(10):
            feats = dict(base)
            feats.update(cross_features(rows, len(rows), 2, upcoming))
            feats.update(same_draw_features(2, [a, b]))
            dist2[(a, b)] = press_dist(feats, 2, counts, priors)

    scored = []
    for entry in space:
        a, b, c = entry["digits"]
        score = dist0[a] * dist1[a][b] * dist2[(a, b)][c]
        scored.append({
            "number": entry["number"],
            "digits": entry["digits"],
            "regions": entry["regions"],
            "path": entry["path"],
            "score": round(score, 10),
            "press_probs": {"first": round(dist0[a], 6), "second": round(dist1[a][b], 6), "third": round(dist2[(a, b)][c], 6)},
        })
    scored.sort(key=lambda x: (-x["score"], x["number"]))
    top = scored[: args.top]

    slug = Path(args.input).stem
    out_path = Path(args.output) if args.output else ROOT / "data" / "markov" / f"{slug}_sequential.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"input": str(Path(args.input)), "upcoming_session": upcoming, "top": top}, indent=2) + "\n")

    print(f"Rows: {len(rows)}  upcoming_session: {upcoming}")
    print("Top sequential candidates:")
    for item in top:
        print(f"  {item['number']}  score={item['score']:.8f}  path={item['path']}  probs={item['press_probs']}")
    print(f"Wrote {out_path}")

if __name__ == "__main__":
    main()
