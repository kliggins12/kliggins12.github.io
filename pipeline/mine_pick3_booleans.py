#!/usr/bin/env python3
import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

from markov_pick3_shape import load_rows
from score_pick3_sequential import cross_features, same_draw_features, upcoming_session

ROOT = Path(__file__).resolve().parent
ALPHA = 1.0

def entropy(counter):
    total = sum(counter.values())
    if total == 0:
        return 0.0
    return -sum((n / total) * math.log(n / total) for n in counter.values())

def digit_dist(counts_pos, feats, alpha=ALPHA):
    priors = counts_pos["_prior"]
    prior_total = sum(priors.values()) or 1
    prior = {d: (priors.get(str(d), 0) + alpha) / (prior_total + alpha * 10) for d in range(10)}
    logp = {d: math.log(prior[d]) for d in range(10)}
    for feat, state in feats.items():
        table = counts_pos.get(feat, {}).get(state)
        if not table:
            continue
        total = sum(table.values())
        for d in range(10):
            cond = (table.get(str(d), 0) + alpha) / (total + alpha * 10)
            logp[d] += math.log(cond / max(prior[d], 1e-9))
    peak = max(logp.values())
    exp = {d: math.exp(logp[d] - peak) for d in range(10)}
    norm = sum(exp.values())
    return {d: exp[d] / norm for d in range(10)}

def main():
    ap = argparse.ArgumentParser(description="Mine boolean conditions and build a small Pick 3 playable list.")
    ap.add_argument("--input", default="data/normalized/pick3_all_synced.json")
    ap.add_argument("--space", default="data/pick3_space.json")
    ap.add_argument("--min-support", type=int, default=30)
    ap.add_argument("--top-booleans", type=int, default=15)
    ap.add_argument("--beam", type=int, default=3)
    ap.add_argument("--branch", type=int, default=3)
    ap.add_argument("--plays", type=int, default=10)
    ap.add_argument("--output", default=None)
    args = ap.parse_args()

    rows = load_rows(args.input)
    space = json.loads((ROOT / args.space).read_text())
    space_by_digits = {tuple(e["digits"]): e for e in space}
    counts = {p: {"_prior": Counter()} for p in range(3)}
    feature_states = {p: defaultdict(set) for p in range(3)}

    for j in range(1, len(rows)):
        for pos in range(3):
            feats = cross_features(rows, j, pos, rows[j].get("session"))
            feats.update(same_draw_features(pos, rows[j]["numbers"][:pos]))
            outcome = str(rows[j]["numbers"][pos])
            counts[pos]["_prior"][outcome] += 1
            for feat, state in feats.items():
                if feat == "_prior":
                    continue
                counts[pos].setdefault(feat, defaultdict(Counter))
                counts[pos][feat][state][outcome] += 1
                feature_states[pos][feat].add(state)

    boolean_report = {}
    for pos in range(3):
        prior = counts[pos]["_prior"]
        prior_total = sum(prior.values()) or 1
        base = {d: (prior.get(str(d), 0) + ALPHA) / (prior_total + ALPHA * 10) for d in range(10)}
        base_max = max(base.values())
        items = []
        for feat, states in feature_states[pos].items():
            for state in states:
                table = counts[pos].get(feat, {}).get(state, Counter())
                support = sum(table.values())
                if support < args.min_support:
                    continue
                total = support
                dist = {d: (table.get(str(d), 0) + ALPHA) / (total + ALPHA * 10) for d in range(10)}
                top_digit = max(dist, key=dist.get)
                max_prob = dist[top_digit]
                ent = entropy(Counter({d: table.get(str(d), 0) for d in range(10) if table.get(str(d), 0)}))
                items.append({
                    "condition": f"{feat} == {state}",
                    "support": support,
                    "top_digit": top_digit,
                    "max_prob": round(max_prob, 6),
                    "lift_vs_baseline": round(max_prob / max(base_max, 1e-9), 4),
                    "entropy": round(ent, 4),
                })
        items.sort(key=lambda x: (-x["max_prob"], -x["support"], x["condition"]))
        boolean_report[pos] = {"baseline": {str(d): round(base[d], 6) for d in range(10)}, "count": len(items), "top": items[: args.top_booleans]}

    upcoming = upcoming_session(rows)
    def context(pos, earlier):
        j = len(rows)
        feats = cross_features(rows, j, pos, upcoming)
        feats.update(same_draw_features(pos, earlier))
        return feats

    f0 = context(0, [])
    d0 = digit_dist(counts[0], f0)
    first_digits = sorted(range(10), key=lambda d: -d0[d])[: args.beam]

    partials = []
    for a in first_digits:
        f1 = context(1, [a])
        d1 = digit_dist(counts[1], f1)
        second_digits = sorted(range(10), key=lambda d: -d1[d])[: args.branch]
        for b in second_digits:
            f2 = context(2, [a, b])
            d2 = digit_dist(counts[2], f2)
            third_digits = sorted(range(10), key=lambda d: -d2[d])[: args.branch]
            for c in third_digits:
                digits = (a, b, c)
                entry = space_by_digits.get(digits, {"number": f"{a}{b}{c}", "digits": list(digits), "regions": [], "path": ""})
                partials.append({
                    "number": entry.get("number", f"{a}{b}{c}"),
                    "digits": list(digits),
                    "regions": entry.get("regions", []),
                    "path": entry.get("path", ""),
                    "score": round(d0[a] * d1[b] * d2[c], 10),
                    "press_probs": {"first": round(d0[a], 6), "second": round(d1[b], 6), "third": round(d2[c], 6)},
                })
    partials.sort(key=lambda x: (-x["score"], x["number"]))
    playables = partials[: args.plays]

    slug = Path(args.input).stem
    out_path = Path(args.output) if args.output else ROOT / "data" / "conditions" / f"{slug}_booleans.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({
        "input": str(Path(args.input)),
        "upcoming_session": upcoming,
        "boolean_counts": {str(p): boolean_report[p]["count"] for p in range(3)},
        "booleans": {str(p): boolean_report[p]["top"] for p in range(3)},
        "playables": playables,
    }, indent=2) + "\n")

    print(f"Rows: {len(rows)}  upcoming_session: {upcoming}")
    for pos, name in enumerate(["first", "second", "third"]):
        print(f"\n{name.title()} press booleans: {boolean_report[pos]['count']} rules")
        for item in boolean_report[pos]["top"][: args.top_booleans]:
            print(f"  {item['condition']}: support={item['support']} -> {item['top_digit']} ({item['max_prob']:.2%}, lift {item['lift_vs_baseline']})")
    print("\nPlayable list:")
    for item in playables:
        print(f"  {item['number']}  score={item['score']:.8f}  path={item['path']}  probs={item['press_probs']}")
    print(f"Wrote {out_path}")

if __name__ == "__main__":
    main()
