#!/usr/bin/env python3
import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

from markov_pick3_shape import load_rows
from build_pick3_space import REGION, keypad_pos, move_dir
from mine_pick3_booleans_v2 import row_date, next_draw_info, ROOT, ALPHA

DEFAULT_TARGETS = [
    "allornothing_morning",
    "allornothing_day",
    "allornothing_evening",
    "allornothing_night",
    "allornothing_all_synced",
]
OUTCOMES = list(range(1, 25))


def num_regs(n):
    return "|".join(REGION[ch] for ch in str(n))


def num_path(n):
    s = str(n)
    if len(s) == 1:
        return "C"
    return move_dir(keypad_pos(s[0]), keypad_pos(s[1]))


def press_len(nums):
    return sum(len(str(n)) for n in nums)


def two_digit_count(nums):
    return sum(1 for n in nums if n >= 10)


def aon_features(rows, j, pos, next_session, next_date, earlier):
    prev = rows[j - 1]
    pd = prev["numbers"]
    rd = row_date(prev)
    nd = next_date
    feats = {
        "prev_last_num": str(pd[-1]),
        "prev_last_num_regions": num_regs(pd[-1]),
        "prev_last_num_path": num_path(pd[-1]),
        "prev_prev_num": str(pd[-2]),
        "prev_prev_num_regions": num_regs(pd[-2]),
        "prev_first_num": str(pd[0]),
        "prev_first_num_regions": num_regs(pd[0]),
        "same_pos_num": str(pd[pos]),
        "same_pos_num_regions": num_regs(pd[pos]),
        "same_pos_num_path": num_path(pd[pos]),
        "prev_two_digit_count": str(two_digit_count(pd)),
        "prev_press_len": str(press_len(pd)),
        "prev_press_len_mod": str(press_len(pd) % 10),
        "prev_sum": str(sum(pd)),
        "prev_min": str(min(pd)),
        "prev_max": str(max(pd)),
        "prev_range": str(max(pd) - min(pd)),
        "prev_odd_count": str(sum(n % 2 for n in pd)),
        "prev_high_count": str(sum(n >= 13 for n in pd)),
        "prev_contains_1": "yes" if 1 in pd else "no",
        "prev_contains_10": "yes" if 10 in pd else "no",
        "prev_contains_24": "yes" if 24 in pd else "no",
        "prev_sorted": "yes" if pd == sorted(pd) else "no",
        "prev_adjacent_eq": str(sum(1 for a, b in zip(pd, pd[1:]) if a == b)),
        "prev_session": prev.get("session") or "none",
        "next_session": next_session or "none",
        "session_pair": f"{prev.get('session') or 'none'}>{next_session or 'none'}",
        "prev_dow": str(rd.weekday()),
        "next_dow": str(nd.weekday()),
        "date_gap": str((nd - rd).days),
        "prev_month": str(rd.month),
        "next_month": str(nd.month),
        "gap_bucket": "1" if (nd - rd).days == 1 else "2" if (nd - rd).days == 2 else "3plus",
        "prev_season": str((rd.month - 1) // 3),
        "next_season": str((nd.month - 1) // 3),
        "next_is_weekend": "yes" if nd.weekday() >= 5 else "no",
        "prev_is_weekend": "yes" if rd.weekday() >= 5 else "no",
    }
    if j >= 2:
        p2 = rows[j - 2]["numbers"]
        feats["same_pos_num_o2"] = f"{p2[pos]}|{pd[pos]}"
        feats["prev_last_num_o2"] = f"{p2[-1]}|{pd[-1]}"
        feats["prev_press_len_o2"] = f"{press_len(p2)}|{press_len(pd)}"
        feats["prev_two_digit_count_o2"] = f"{two_digit_count(p2)}|{two_digit_count(pd)}"
    if j >= 3:
        p3 = rows[j - 3]["numbers"]
        feats["same_pos_num_o3"] = f"{p3[pos]}|{rows[j - 2]['numbers'][pos]}|{pd[pos]}"
        feats["prev_last_num_o3"] = f"{p3[-1]}|{rows[j - 2]['numbers'][-1]}|{pd[-1]}"
    if j >= 4:
        p4 = rows[j - 4]["numbers"]
        feats["same_pos_num_o4"] = f"{p4[pos]}|{rows[j - 3]['numbers'][pos]}|{rows[j - 2]['numbers'][pos]}|{pd[pos]}"
        feats["prev_last_num_o4"] = f"{p4[-1]}|{rows[j - 3]['numbers'][-1]}|{rows[j - 2]['numbers'][-1]}|{pd[-1]}"
    for lag in range(1, 4):
        if j - 1 - lag >= 0:
            old = rows[j - 1 - lag]["numbers"]
            feats[f"prev_num_list_eq_lag{lag}"] = "yes" if old == pd else "no"
            feats[f"same_pos_eq_lag{lag}"] = "yes" if old[pos] == pd[pos] else "no"
    if earlier:
        last_e = earlier[-1]
        feats["same_draw_prev_num"] = str(last_e)
        feats["same_draw_prev_num_regions"] = num_regs(last_e)
        feats["same_draw_prev_num_path"] = num_path(last_e)
        feats["same_draw_earlier_nums"] = "|".join(str(d) for d in earlier)
        feats["same_draw_earlier_two_digit_count"] = str(two_digit_count(earlier))
        feats["same_draw_earlier_sum"] = str(sum(earlier))
        feats["same_draw_earlier_min"] = str(min(earlier))
        feats["same_draw_earlier_max"] = str(max(earlier))
        for k, d in enumerate(earlier[-3:]):
            feats[f"e{k}_num"] = str(d)
            feats[f"e{k}_regions"] = num_regs(d)
            feats[f"e{k}_path"] = num_path(d)
            feats[f"e{k}_eq_same_pos_prev"] = "yes" if d == pd[pos] else "no"
            feats[f"e{k}_eq_prev_last"] = "yes" if d == pd[-1] else "no"
    def _streak(pred, cap=20):
        c, k = 0, j - 1
        while k >= 0 and c < cap and pred(rows[k]):
            c += 1
            k -= 1
        return c
    def _gap(pred, limit=60):
        for k in range(j - 2, max(-1, j - 1 - limit), -1):
            if pred(rows[k]):
                return (j - 1) - k
        return limit
    def _gb(g):
        return "1" if g <= 2 else "2-5" if g <= 5 else "6-20" if g <= 20 else "21+"
    sp_streak = _streak(lambda r: r["numbers"][pos] == pd[pos])
    pl_streak = _streak(lambda r: r["numbers"][-1] == pd[-1])
    pn_streak = _streak(lambda r: r["numbers"] == pd)
    sp_gap = _gap(lambda r: r["numbers"][pos] == pd[pos])
    pl_gap = _gap(lambda r: r["numbers"][-1] == pd[-1])
    feats["same_pos_num_streak"] = str(sp_streak)
    feats["same_pos_num_streak_bucket"] = _gb(sp_streak)
    feats["prev_last_num_streak"] = str(pl_streak)
    feats["prev_last_num_streak_bucket"] = _gb(pl_streak)
    feats["prev_num_list_streak"] = str(pn_streak)
    feats["prev_num_list_streak_bucket"] = _gb(pn_streak)
    feats["same_pos_num_gap"] = str(min(sp_gap, 99))
    feats["same_pos_num_gap_bucket"] = _gb(sp_gap)
    feats["prev_last_num_gap_bucket"] = _gb(pl_gap)
    gd = (nd - rd).days
    feats["next_is_saturday"] = "yes" if nd.weekday() == 5 else "no"
    feats["prev_is_saturday"] = "yes" if rd.weekday() == 5 else "no"
    feats["next_is_friday"] = "yes" if nd.weekday() == 4 else "no"
    feats["prev_is_friday"] = "yes" if rd.weekday() == 4 else "no"
    feats["next_is_monday"] = "yes" if nd.weekday() == 0 else "no"
    feats["prev_is_monday"] = "yes" if rd.weekday() == 0 else "no"
    feats["draws_on_weekday"] = "yes" if nd.weekday() <= 5 else "no"
    feats["prev_draws_on_weekday"] = "yes" if rd.weekday() <= 5 else "no"
    feats["long_gap"] = "yes" if gd > 1 else "no"
    so = {"morning": 0, "day": 1, "evening": 2, "night": 3}
    ns, ps = next_session or "", prev.get("session") or ""
    if ns in so:
        feats["next_session_index"] = str(so[ns])
        feats["next_is_first_session"] = "yes" if so[ns] == 0 else "no"
        feats["next_is_last_session"] = "yes" if so[ns] == 3 else "no"
    if ps in so:
        feats["prev_session_index"] = str(so[ps])
    if ns in so and ps in so:
        feats["session_index_delta"] = str((so[ns] - so[ps]) % 4)
    return feats


def outcome_dist(counts_pos, feats, outcomes, alpha=ALPHA):
    priors = counts_pos["_prior"]
    prior_total = sum(priors.values()) or 1
    prior = {o: (priors.get(str(o), 0) + alpha) / (prior_total + alpha * len(outcomes)) for o in outcomes}
    logp = {o: math.log(prior[o]) for o in outcomes}
    for feat, state in feats.items():
        table = counts_pos.get(feat, {}).get(state)
        if not table:
            continue
        total = sum(table.values())
        for o in outcomes:
            cond = (table.get(str(o), 0) + alpha) / (total + alpha * len(outcomes))
            logp[o] += math.log(cond / max(prior[o], 1e-9))
    peak = max(logp.values())
    exp = {o: math.exp(logp[o] - peak) for o in outcomes}
    norm = sum(exp.values())
    return {o: exp[o] / norm for o in outcomes}


def add_stream(counts, feature_states, rows):
    for j in range(1, len(rows)):
        next_session = rows[j].get("session")
        next_date = row_date(rows[j])
        for pos in range(12):
            earlier = rows[j]["numbers"][:pos]
            feats = aon_features(rows, j, pos, next_session, next_date, earlier)
            outcome = str(rows[j]["numbers"][pos])
            counts[pos]["_prior"][outcome] += 1
            for feat, state in feats.items():
                counts[pos].setdefault(feat, defaultdict(Counter))
                counts[pos][feat][state][outcome] += 1
                feature_states[pos][feat].add(state)


def mine_report(counts, feature_states, min_support, top_n):
    report = {}
    for pos in range(12):
        prior = counts[pos]["_prior"]
        prior_total = sum(prior.values()) or 1
        base = {o: (prior.get(str(o), 0) + ALPHA) / (prior_total + ALPHA * len(OUTCOMES)) for o in OUTCOMES}
        base_max = max(base.values())
        items = []
        for feat, states in feature_states[pos].items():
            for state in states:
                table = counts[pos].get(feat, {}).get(state, Counter())
                support = sum(table.values())
                if support < min_support:
                    continue
                dist = {o: (table.get(str(o), 0) + ALPHA) / (support + ALPHA * len(OUTCOMES)) for o in OUTCOMES}
                top_num = max(dist, key=dist.get)
                items.append({"condition": f"{feat} == {state}", "support": support, "top_number": top_num, "max_prob": round(dist[top_num], 6), "lift": round(dist[top_num] / max(base_max, 1e-9), 4)})
        items.sort(key=lambda x: (-x["max_prob"], -x["support"], x["condition"]))
        report[pos] = {"count": len(items), "top": items[:top_n]}
    return report


def score_target(rows, counts, beam, branch, plays, min_press_prob, min_score):
    upcoming_session, upcoming_date = next_draw_info(rows)

    def ctx(pos, earlier):
        return aon_features(rows, len(rows), pos, upcoming_session, upcoming_date, earlier)

    partials = [{"seq": [], "score": 1.0, "probs": []}]
    for pos in range(12):
        new = []
        for p in partials:
            dist = outcome_dist(counts[pos], ctx(pos, p["seq"]), OUTCOMES)
            for o in sorted(OUTCOMES, key=lambda x: -dist[x])[:branch]:
                if min_press_prob and dist[o] < min_press_prob:
                    continue
                score = p["score"] * dist[o]
                if score < min_score:
                    continue
                new.append({"seq": p["seq"] + [o], "score": score, "probs": p["probs"] + [round(dist[o], 6)]})
        new.sort(key=lambda x: -x["score"])
        partials = new[:beam]
    return upcoming_session, upcoming_date, [{"numbers": p["seq"], "score": round(p["score"], 10), "press_probs": p["probs"]} for p in partials[:plays]]


def main():
    ap = argparse.ArgumentParser(description="Mine universal All or Nothing booleans across separate and combined streams.")
    ap.add_argument("--targets", default=",".join(DEFAULT_TARGETS))
    ap.add_argument("--min-support", type=int, default=30)
    ap.add_argument("--top-booleans", type=int, default=10)
    ap.add_argument("--beam", type=int, default=60)
    ap.add_argument("--branch", type=int, default=6)
    ap.add_argument("--plays", type=int, default=10)
    ap.add_argument("--min-press-prob", type=float, default=0.0)
    ap.add_argument("--min-score", type=float, default=0.0)
    ap.add_argument("--output", default="data/conditions/allornothing_booleans_universal.json")
    args = ap.parse_args()

    targets = [t.strip() for t in args.targets.split(",") if t.strip()]
    counts = {p: {"_prior": Counter()} for p in range(12)}
    feature_states = {p: defaultdict(set) for p in range(12)}
    target_rows = {}
    sources = []

    for slug in targets:
        path = ROOT / "data" / "normalized" / f"{slug}.json"
        if not path.exists():
            print(f"skip missing {path}")
            continue
        rows = load_rows(str(path))
        target_rows[slug] = rows
        add_stream(counts, feature_states, rows)
        sources.append({"slug": slug, "rows": len(rows), "first_date": str(row_date(rows[0])), "last_date": str(row_date(rows[-1]))})
        print(f"loaded {slug}: {len(rows)} rows")

    report = mine_report(counts, feature_states, args.min_support, args.top_booleans)
    playables_by_target = {}
    for slug, rows in target_rows.items():
        upcoming_session, upcoming_date, playables = score_target(rows, counts, args.beam, args.branch, args.plays, args.min_press_prob, args.min_score)
        playables_by_target[slug] = {"upcoming_session": upcoming_session, "upcoming_date": str(upcoming_date), "playables": playables}
        top = "-".join(map(str, playables[0]["numbers"])) if playables else "-"
        print(f"{slug}: upcoming={upcoming_session} {upcoming_date} top={top}")

    out = ROOT / args.output
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"targets": targets, "sources": sources, "boolean_counts": {str(p): report[p]["count"] for p in range(12)}, "booleans": {str(p): report[p]["top"] for p in range(12)}, "playables_by_target": playables_by_target}, indent=2) + "\n")

    print("\nUniversal All or Nothing boolean counts (12 positions):")
    for pos in range(12):
        print(f"  pos{pos + 1}: {report[pos]['count']} rules")
        for item in report[pos]["top"][:3]:
            print(f"    {item['condition']}: support={item['support']} -> {item['top_number']} ({item['max_prob']:.2%}, lift {item['lift']})")
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
