#!/usr/bin/env python3
import argparse
import bisect
import json
from collections import Counter, defaultdict
from pathlib import Path

from markov_pick3_shape import load_rows
from mine_pick3_booleans import digit_dist
from mine_pick3_booleans_v2 import rich_features, next_draw_info, row_date, ROOT, ALPHA

DEFAULT_TARGETS = [
    "pick3_morning",
    "pick3_day",
    "pick3_evening",
    "pick3_night",
    "pick3_all_synced",
]
SESSION_ORDER = {"morning": 0, "day": 1, "evening": 2, "night": 3}
GAME_ORDER = {"allornothing": 0, "daily4": 1, "pick3": 2}


def load_seq():
    p = ROOT / "data" / "normalized" / "draw_sequence.json"
    if not p.exists():
        return None
    events = json.loads(p.read_text())["events"]
    order_keys = [(e["date"], e["session_order"], e["game_order"]) for e in events]
    idx = {(e["date"], e["session"], e["game"]): i for i, e in enumerate(events)}
    return events, order_keys, idx


def xprev_for(seq, date_s, session, game="pick3", upcoming=False):
    if not seq:
        return None
    events, order_keys, idx = seq
    if upcoming:
        key = (date_s, SESSION_ORDER.get(session, 99), GAME_ORDER.get(game, 2))
        i = bisect.bisect_left(order_keys, key)
    else:
        i = idx.get((date_s, session, game))
        if i is None:
            return None
    return events[max(0, i - 3):i]


def add_stream(counts, feature_states, rows, seq=None):
    for j in range(1, len(rows)):
        next_session = rows[j].get("session")
        next_date = row_date(rows[j])
        xp = xprev_for(seq, str(next_date), next_session, "pick3", upcoming=False) if seq else None
        for pos in range(3):
            feats = rich_features(rows, j, pos, next_session, next_date, xp)
            outcome = str(rows[j]["numbers"][pos])
            counts[pos]["_prior"][outcome] += 1
            for feat, state in feats.items():
                counts[pos].setdefault(feat, defaultdict(Counter))
                counts[pos][feat][state][outcome] += 1
                feature_states[pos][feat].add(state)


def mine_report(counts, feature_states, min_support, top_n):
    report = {}
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
                if support < min_support:
                    continue
                dist = {d: (table.get(str(d), 0) + ALPHA) / (support + ALPHA * 10) for d in range(10)}
                top_digit = max(dist, key=dist.get)
                items.append({
                    "condition": f"{feat} == {state}",
                    "support": support,
                    "top_digit": top_digit,
                    "max_prob": round(dist[top_digit], 6),
                    "lift": round(dist[top_digit] / max(base_max, 1e-9), 4),
                })
        items.sort(key=lambda x: (-x["max_prob"], -x["support"], x["condition"]))
        report[pos] = {"count": len(items), "top": items[:top_n]}
    return report


def score_target(rows, counts, space_by_digits, beam, branch, plays, min_press_prob, min_score, seq=None):
    upcoming_session, upcoming_date = next_draw_info(rows)
    xp = xprev_for(seq, str(upcoming_date), upcoming_session, "pick3", upcoming=True) if seq else None

    def context(pos, earlier):
        return rich_features(rows, len(rows), pos, upcoming_session, upcoming_date, xp, earlier)

    d0 = digit_dist(counts[0], context(0, []))
    first_digits = sorted(range(10), key=lambda d: -d0[d])[:beam]
    partials = []
    for a in first_digits:
        d1 = digit_dist(counts[1], context(1, [a]))
        for b in sorted(range(10), key=lambda d: -d1[d])[:branch]:
            if min_press_prob and d1[b] < min_press_prob:
                continue
            d2 = digit_dist(counts[2], context(2, [a, b]))
            for c in sorted(range(10), key=lambda d: -d2[d])[:branch]:
                if min_press_prob and (d0[a] < min_press_prob or d2[c] < min_press_prob):
                    continue
                digits = (a, b, c)
                entry = space_by_digits.get(digits, {"number": f"{a}{b}{c}", "digits": list(digits), "regions": [], "path": ""})
                score = d0[a] * d1[b] * d2[c]
                if score < min_score:
                    continue
                partials.append({
                    "number": entry.get("number", f"{a}{b}{c}"),
                    "digits": list(digits),
                    "regions": entry.get("regions", []),
                    "path": entry.get("path", ""),
                    "score": round(score, 10),
                    "press_probs": {"first": round(d0[a], 6), "second": round(d1[b], 6), "third": round(d2[c], 6)},
                })
    partials.sort(key=lambda x: (-x["score"], x["number"]))
    return upcoming_session, upcoming_date, partials[:plays]


def main():
    ap = argparse.ArgumentParser(description="Mine universal Pick 3 booleans across separate and combined streams.")
    ap.add_argument("--targets", default=",".join(DEFAULT_TARGETS), help="Comma-separated normalized slugs.")
    ap.add_argument("--space", default="data/pick3_space.json")
    ap.add_argument("--min-support", type=int, default=30)
    ap.add_argument("--top-booleans", type=int, default=10)
    ap.add_argument("--beam", type=int, default=5)
    ap.add_argument("--branch", type=int, default=5)
    ap.add_argument("--plays", type=int, default=10)
    ap.add_argument("--min-press-prob", type=float, default=0.0)
    ap.add_argument("--min-score", type=float, default=0.0)
    ap.add_argument("--output", default="data/conditions/pick3_booleans_universal.json")
    args = ap.parse_args()

    targets = [t.strip() for t in args.targets.split(",") if t.strip()]
    space = json.loads((ROOT / args.space).read_text())
    space_by_digits = {tuple(e["digits"]): e for e in space}
    counts = {p: {"_prior": Counter()} for p in range(3)}
    feature_states = {p: defaultdict(set) for p in range(3)}
    target_rows = {}
    sources = []
    seq = load_seq()
    if seq:
        print(f"draw_sequence events={len(seq[0])}")

    for slug in targets:
        path = ROOT / "data" / "normalized" / f"{slug}.json"
        if not path.exists():
            print(f"skip missing {path}")
            continue
        rows = load_rows(str(path))
        sess_hint = slug.rsplit("_", 1)[-1]
        for r in rows:
            if "session" not in r and sess_hint in SESSION_ORDER:
                r["session"] = sess_hint
        target_rows[slug] = rows
        add_stream(counts, feature_states, rows, seq)
        sources.append({
            "slug": slug,
            "rows": len(rows),
            "first_date": str(row_date(rows[0])),
            "last_date": str(row_date(rows[-1])),
        })
        print(f"loaded {slug}: {len(rows)} rows")

    report = mine_report(counts, feature_states, args.min_support, args.top_booleans)
    playables_by_target = {}
    for slug, rows in target_rows.items():
        upcoming_session, upcoming_date, playables = score_target(
            rows, counts, space_by_digits, args.beam, args.branch, args.plays,
            args.min_press_prob, args.min_score, seq,
        )
        playables_by_target[slug] = {
            "upcoming_session": upcoming_session,
            "upcoming_date": str(upcoming_date),
            "playables": playables,
        }
        top = playables[0]["number"] if playables else "-"
        print(f"{slug}: upcoming={upcoming_session} {upcoming_date} top={top}")

    out = ROOT / args.output
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "targets": targets,
        "sources": sources,
        "boolean_counts": {str(p): report[p]["count"] for p in range(3)},
        "booleans": {str(p): report[p]["top"] for p in range(3)},
        "playables_by_target": playables_by_target,
    }, indent=2) + "\n")

    print("\nUniversal boolean counts:")
    for pos, name in enumerate(["first", "second", "third"]):
        print(f"  {name}: {report[pos]['count']} rules")
        for item in report[pos]["top"][:5]:
            print(f"    {item['condition']}: support={item['support']} -> {item['top_digit']} ({item['max_prob']:.2%}, lift {item['lift']})")
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
