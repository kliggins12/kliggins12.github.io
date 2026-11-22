#!/usr/bin/env python3
import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

from markov_pick3_shape import load_rows
from build_pick3_space import REGION, keypad_pos, move_dir, path_shape
from mine_pick3_booleans import digit_dist
from mine_pick3_booleans_v2 import row_date, next_draw_info, ROOT, ALPHA, parity, high, key_rc, dist_keys, OPP

DEFAULT_TARGETS = [
    "daily4_morning",
    "daily4_day",
    "daily4_evening",
    "daily4_night",
    "daily4_all_synced",
]


def reg_seq(nums):
    return "|".join(REGION[str(d)] for d in nums)


def bucket_sum4(total):
    if total <= 9:
        return "0-9"
    if total <= 18:
        return "10-18"
    if total <= 27:
        return "19-27"
    return "28-36"


def cross4(rows, j, pos, next_session):
    prev = rows[j - 1]
    prev2 = rows[j - 2] if j >= 2 else None
    digs = prev["numbers"]
    regs = reg_seq(digs).split("|")
    f = {
        "same_pos_region": regs[pos],
        "same_pos_digit": str(digs[pos]),
        "prev_third_digit": str(digs[2]),
        "prev_third_region": regs[2],
        "prev_fourth_digit": str(digs[3]),
        "prev_fourth_region": regs[3],
        "prev_tail_path": move_dir(keypad_pos(digs[2]), keypad_pos(digs[3])),
        "prev_last_two_regions": f"{regs[2]}|{regs[3]}",
        "draw_quad": "|".join(regs),
        "path": path_shape(digs),
        "prev_session": prev.get("session") or "none",
        "next_session": next_session or "none",
        "session_pair": f"{prev.get('session') or 'none'}>{next_session or 'none'}",
        "distinct_count": str(len(set(digs))),
        "max_repeat": str(max(Counter(digs).values())),
        "adjacent_equal_count": str(sum(1 for a, b in zip(digs, digs[1:]) if a == b)),
        "sum_bucket": bucket_sum4(sum(digs)),
        "odd_count": str(sum(d % 2 for d in digs)),
        "high_count": str(sum(d >= 5 for d in digs)),
        "other_regions": "|".join(regs[k] for k in range(4) if k != pos),
    }
    if prev2 is not None:
        pd2 = prev2["numbers"]
        f["same_pos_region_o2"] = f"{REGION[str(pd2[pos])]}|{regs[pos]}"
        f["same_pos_digit_o2"] = f"{pd2[pos]}|{digs[pos]}"
        f["prev_third_region_o2"] = f"{REGION[str(pd2[2])]}|{regs[2]}"
        f["prev_third_digit_o2"] = f"{pd2[2]}|{digs[2]}"
        f["prev_fourth_region_o2"] = f"{REGION[str(pd2[3])]}|{regs[3]}"
        f["prev_fourth_digit_o2"] = f"{pd2[3]}|{digs[3]}"
        f["prev_pair_o2"] = f"{pd2[pos]}|{digs[pos]}"
    return f


def same_draw4(pos, earlier):
    if pos == 0 or not earlier:
        return {}
    regs = reg_seq(earlier).split("|")
    return {
        "same_draw_prev_region": regs[-1],
        "same_draw_prev_digit": str(earlier[-1]),
        "same_draw_earlier_regions": "|".join(regs),
        "same_draw_earlier_digits": "|".join(str(d) for d in earlier),
    }


def rich4(rows, j, pos, next_session, next_date):
    feats = cross4(rows, j, pos, next_session)
    prev = rows[j - 1]
    pd = prev["numbers"]
    pr = reg_seq(pd).split("|")
    for k in range(4):
        feats[f"p{k}_digit"] = str(pd[k])
        feats[f"p{k}_region"] = pr[k]
        feats[f"p{k}_parity"] = parity(pd[k])
        feats[f"p{k}_high"] = high(pd[k])
        feats[f"p{k}_row"] = str(key_rc(pd[k])[0])
        feats[f"p{k}_col"] = str(key_rc(pd[k])[1])
        feats[f"p{k}_mod3"] = str(pd[k] % 3)
        feats[f"p{k}_mod4"] = str(pd[k] % 4)
    for name, a, b in [("01", 0, 1), ("12", 1, 2), ("23", 2, 3), ("03", 0, 3)]:
        feats[f"prev_pair_{name}"] = f"{pd[a]}|{pd[b]}"
        feats[f"prev_reg_pair_{name}"] = f"{pr[a]}|{pr[b]}"
    pts = [keypad_pos(d) for d in pd]
    segs = [move_dir(pts[i], pts[i + 1]) for i in range(3)]
    for i, s in enumerate(segs, 1):
        feats[f"prev_path_seg{i}"] = s
    feats["prev_path_straight"] = "yes" if segs[0] == segs[1] == segs[2] else "no"
    feats["prev_path_reversals"] = str(sum(1 for a, b in zip(segs, segs[1:]) if b == OPP.get(a)))
    for i in range(3):
        feats[f"prev_seg{i + 1}_len"] = str(dist_keys(pd[i], pd[i + 1]))
    feats["prev_path_len"] = str(sum(dist_keys(pd[i], pd[i + 1]) for i in range(3)))
    feats["prev_path_has_C"] = "yes" if "C" in segs else "no"
    feats["prev_path_diagonal_count"] = str(sum(1 for s in segs if len(s) == 2))
    feats["prev_path_orthogonal_count"] = str(sum(1 for s in segs if len(s) == 1 and s != "C"))
    total = sum(pd)
    feats["prev_sum_exact"] = str(total)
    feats["prev_sum_mod2"] = str(total % 2)
    feats["prev_sum_mod3"] = str(total % 3)
    feats["prev_sum_mod4"] = str(total % 4)
    feats["prev_sum_mod5"] = str(total % 5)
    feats["prev_min_digit"] = str(min(pd))
    feats["prev_max_digit"] = str(max(pd))
    feats["prev_range"] = str(max(pd) - min(pd))
    feats["prev_median_digit"] = str(sorted(pd)[1])
    prev_counts = Counter(pd)
    mode_n = max(prev_counts.values())
    feats["prev_mode_digit"] = str(min(d for d, c in prev_counts.items() if c == mode_n))
    feats["prev_unique_count"] = str(len(set(pd)))
    feats["prev_adjacent_equal_count"] = str(sum(1 for a, b in zip(pd, pd[1:]) if a == b))
    feats["prev_sorted_asc"] = "yes" if pd == sorted(pd) else "no"
    feats["prev_sorted_desc"] = "yes" if pd == sorted(pd, reverse=True) else "no"
    feats["prev_odd_count"] = str(sum(d % 2 for d in pd))
    feats["prev_high_count"] = str(sum(d >= 5 for d in pd))
    feats["prev_contains_zero"] = "yes" if 0 in pd else "no"
    feats["prev_contains_five"] = "yes" if 5 in pd else "no"
    feats["prev_region_changes"] = str(sum(1 for a, b in zip(pr, pr[1:]) if a != b))
    feats["prev_all_same_region"] = "yes" if len(set(pr)) == 1 else "no"
    feats["prev_corner_count"] = str(sum(1 for r in pr if r == "corner"))
    feats["prev_edge_count"] = str(sum(1 for r in pr if r == "edge"))
    feats["prev_center_count"] = str(sum(1 for r in pr if r == "center"))
    feats["prev_zero_count"] = str(sum(1 for r in pr if r == "zero"))
    rd, nd = row_date(prev), next_date
    feats["prev_dow"] = str(rd.weekday())
    feats["next_dow"] = str(nd.weekday())
    feats["date_gap"] = str((nd - rd).days)
    feats["prev_month"] = str(rd.month)
    feats["next_month"] = str(nd.month)
    feats["prev_day_parity"] = parity(rd.day)
    feats["next_day_parity"] = parity(nd.day)
    feats["prev_week"] = str(rd.isocalendar().week)
    feats["next_week"] = str(nd.isocalendar().week)
    feats["next_is_weekend"] = "yes" if nd.weekday() >= 5 else "no"
    feats["prev_is_weekend"] = "yes" if rd.weekday() >= 5 else "no"
    gap = (nd - rd).days
    feats["gap_bucket"] = "1" if gap == 1 else "2" if gap == 2 else "3plus"
    feats["prev_season"] = str((rd.month - 1) // 3)
    feats["next_season"] = str((nd.month - 1) // 3)
    if j >= 3:
        p3 = rows[j - 3]["numbers"][pos]
        p2 = rows[j - 2]["numbers"][pos]
        feats["same_pos_digit_o3"] = f"{p3}|{p2}|{pd[pos]}"
        feats["same_pos_region_o3"] = f"{REGION[str(p3)]}|{REGION[str(p2)]}|{pr[pos]}"
        t3 = rows[j - 3]["numbers"][3]
        t2 = rows[j - 2]["numbers"][3]
        feats["prev_fourth_digit_o3"] = f"{t3}|{t2}|{pd[3]}"
        feats["prev_fourth_region_o3"] = f"{REGION[str(t3)]}|{REGION[str(t2)]}|{pr[3]}"
        u3 = rows[j - 3]["numbers"][2]
        u2 = rows[j - 2]["numbers"][2]
        feats["prev_third_digit_o3"] = f"{u3}|{u2}|{pd[2]}"
        feats["prev_third_region_o3"] = f"{REGION[str(u3)]}|{REGION[str(u2)]}|{pr[2]}"
        feats["prev_path_o2"] = f"{path_shape(rows[j - 2]['numbers'])}>{path_shape(pd)}"
        feats["prev_draw_quad_o2"] = f"{reg_seq(rows[j - 2]['numbers'])}>{'|'.join(pr)}"
    if j >= 4:
        q4 = rows[j - 4]["numbers"][pos]
        a3 = rows[j - 3]["numbers"][pos]
        a2 = rows[j - 2]["numbers"][pos]
        feats["same_pos_digit_o4"] = f"{q4}|{a3}|{a2}|{pd[pos]}"
        feats["same_pos_region_o4"] = f"{REGION[str(q4)]}|{REGION[str(a3)]}|{REGION[str(a2)]}|{pr[pos]}"
        v4 = rows[j - 4]["numbers"][3]
        feats["prev_fourth_digit_o4"] = f"{v4}|{t3}|{t2}|{pd[3]}"
        feats["prev_fourth_region_o4"] = f"{REGION[str(v4)]}|{REGION[str(t3)]}|{REGION[str(t2)]}|{pr[3]}"
    for lag in range(1, 6):
        if j - 1 - lag >= 0:
            old = rows[j - 1 - lag]["numbers"]
            feats[f"prev_num_eq_lag{lag}"] = "yes" if old == pd else "no"
            feats[f"same_pos_eq_lag{lag}"] = "yes" if old[pos] == pd[pos] else "no"
            feats[f"prev_path_eq_lag{lag}"] = "yes" if path_shape(old) == path_shape(pd) else "no"
            feats[f"prev_region_quad_eq_lag{lag}"] = "yes" if reg_seq(old) == "|".join(pr) else "no"
    earlier = rows[j]["numbers"][:pos] if j < len(rows) else []
    feats.update(same_draw4(pos, earlier))
    for k, d in enumerate(earlier):
        feats[f"earlier{k}_digit"] = str(d)
        feats[f"earlier{k}_region"] = REGION[str(d)]
        feats[f"earlier{k}_parity"] = parity(d)
        feats[f"earlier{k}_high"] = high(d)
        for m in range(4):
            feats[f"e{k}_eq_p{m}"] = "yes" if d == pd[m] else "no"
            feats[f"e{k}_reg_eq_p{m}"] = "yes" if REGION[str(d)] == pr[m] else "no"
    if earlier:
        feats["earlier_parity_seq"] = "".join("o" if d % 2 else "e" for d in earlier)
        feats["earlier_high_seq"] = "".join("h" if d >= 5 else "l" for d in earlier)
    if len(earlier) >= 2:
        feats["earlier_path"] = path_shape(earlier)
        feats["e0_eq_e1"] = "yes" if earlier[0] == earlier[1] else "no"
        feats["earlier_region_seq"] = reg_seq(earlier)
        feats["earlier_min"] = str(min(earlier))
        feats["earlier_max"] = str(max(earlier))
        feats["earlier_range"] = str(max(earlier) - min(earlier))
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
    pshape = path_shape(pd)
    sp_streak = _streak(lambda r: r["numbers"][pos] == pd[pos])
    pn_streak = _streak(lambda r: r["numbers"] == pd)
    pp_streak = _streak(lambda r: path_shape(r["numbers"]) == pshape)
    pt_streak = _streak(lambda r: r["numbers"][2] == pd[2])
    pf_streak = _streak(lambda r: r["numbers"][3] == pd[3])
    sp_gap = _gap(lambda r: r["numbers"][pos] == pd[pos])
    pn_gap = _gap(lambda r: r["numbers"] == pd)
    pp_gap = _gap(lambda r: path_shape(r["numbers"]) == pshape)
    pt_gap = _gap(lambda r: r["numbers"][2] == pd[2])
    pf_gap = _gap(lambda r: r["numbers"][3] == pd[3])
    feats["same_pos_streak"] = str(sp_streak)
    feats["same_pos_streak_bucket"] = _gb(sp_streak)
    feats["prev_num_streak"] = str(pn_streak)
    feats["prev_num_streak_bucket"] = _gb(pn_streak)
    feats["prev_path_streak"] = str(pp_streak)
    feats["prev_path_streak_bucket"] = _gb(pp_streak)
    feats["prev_third_streak"] = str(pt_streak)
    feats["prev_third_streak_bucket"] = _gb(pt_streak)
    feats["prev_fourth_streak"] = str(pf_streak)
    feats["prev_fourth_streak_bucket"] = _gb(pf_streak)
    feats["same_pos_digit_gap"] = str(min(sp_gap, 99))
    feats["same_pos_digit_gap_bucket"] = _gb(sp_gap)
    feats["prev_num_gap_bucket"] = _gb(pn_gap)
    feats["prev_path_gap_bucket"] = _gb(pp_gap)
    feats["prev_third_digit_gap_bucket"] = _gb(pt_gap)
    feats["prev_fourth_digit_gap_bucket"] = _gb(pf_gap)
    feats["next_is_saturday"] = "yes" if nd.weekday() == 5 else "no"
    feats["prev_is_saturday"] = "yes" if rd.weekday() == 5 else "no"
    feats["next_is_friday"] = "yes" if nd.weekday() == 4 else "no"
    feats["prev_is_friday"] = "yes" if rd.weekday() == 4 else "no"
    feats["next_is_monday"] = "yes" if nd.weekday() == 0 else "no"
    feats["prev_is_monday"] = "yes" if rd.weekday() == 0 else "no"
    feats["draws_on_weekday"] = "yes" if nd.weekday() <= 5 else "no"
    feats["prev_draws_on_weekday"] = "yes" if rd.weekday() <= 5 else "no"
    feats["long_gap"] = "yes" if gap > 1 else "no"
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


def add_stream(counts, feature_states, rows):
    for j in range(1, len(rows)):
        next_session = rows[j].get("session")
        next_date = row_date(rows[j])
        for pos in range(4):
            feats = rich4(rows, j, pos, next_session, next_date)
            outcome = str(rows[j]["numbers"][pos])
            counts[pos]["_prior"][outcome] += 1
            for feat, state in feats.items():
                counts[pos].setdefault(feat, defaultdict(Counter))
                counts[pos][feat][state][outcome] += 1
                feature_states[pos][feat].add(state)


def mine_report(counts, feature_states, min_support, top_n):
    report = {}
    for pos in range(4):
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
                items.append({"condition": f"{feat} == {state}", "support": support, "top_digit": top_digit, "max_prob": round(dist[top_digit], 6), "lift": round(dist[top_digit] / max(base_max, 1e-9), 4)})
        items.sort(key=lambda x: (-x["max_prob"], -x["support"], x["condition"]))
        report[pos] = {"count": len(items), "top": items[:top_n]}
    return report


def score_target(rows, counts, space_by_digits, beam, branch, plays, min_press_prob, min_score):
    upcoming_session, upcoming_date = next_draw_info(rows)

    def context(pos, earlier):
        return rich4(rows, len(rows), pos, upcoming_session, upcoming_date)

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
                d3 = digit_dist(counts[3], context(3, [a, b, c]))
                for d in sorted(range(10), key=lambda x: -d3[x])[:branch]:
                    if min_press_prob and (d0[a] < min_press_prob or d3[d] < min_press_prob):
                        continue
                    digits = (a, b, c, d)
                    entry = space_by_digits.get(digits, {"number": f"{a}{b}{c}{d}", "digits": list(digits), "regions": [], "path": ""})
                    score = d0[a] * d1[b] * d2[c] * d3[d]
                    if score < min_score:
                        continue
                    partials.append({"number": entry.get("number", f"{a}{b}{c}{d}"), "digits": list(digits), "regions": entry.get("regions", []), "path": entry.get("path", ""), "score": round(score, 10), "press_probs": {"first": round(d0[a], 6), "second": round(d1[b], 6), "third": round(d2[c], 6), "fourth": round(d3[d], 6)}})
    partials.sort(key=lambda x: (-x["score"], x["number"]))
    return upcoming_session, upcoming_date, partials[:plays]


def main():
    ap = argparse.ArgumentParser(description="Mine universal Daily 4 booleans across separate and combined streams.")
    ap.add_argument("--targets", default=",".join(DEFAULT_TARGETS))
    ap.add_argument("--space", default="data/daily4_space.json")
    ap.add_argument("--min-support", type=int, default=30)
    ap.add_argument("--top-booleans", type=int, default=10)
    ap.add_argument("--beam", type=int, default=4)
    ap.add_argument("--branch", type=int, default=4)
    ap.add_argument("--plays", type=int, default=10)
    ap.add_argument("--min-press-prob", type=float, default=0.0)
    ap.add_argument("--min-score", type=float, default=0.0)
    ap.add_argument("--output", default="data/conditions/daily4_booleans_universal.json")
    args = ap.parse_args()

    targets = [t.strip() for t in args.targets.split(",") if t.strip()]
    space = json.loads((ROOT / args.space).read_text())
    space_by_digits = {tuple(e["digits"]): e for e in space}
    counts = {p: {"_prior": Counter()} for p in range(4)}
    feature_states = {p: defaultdict(set) for p in range(4)}
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
        upcoming_session, upcoming_date, playables = score_target(rows, counts, space_by_digits, args.beam, args.branch, args.plays, args.min_press_prob, args.min_score)
        playables_by_target[slug] = {"upcoming_session": upcoming_session, "upcoming_date": str(upcoming_date), "playables": playables}
        top = playables[0]["number"] if playables else "-"
        print(f"{slug}: upcoming={upcoming_session} {upcoming_date} top={top}")

    out = ROOT / args.output
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"targets": targets, "sources": sources, "boolean_counts": {str(p): report[p]["count"] for p in range(4)}, "booleans": {str(p): report[p]["top"] for p in range(4)}, "playables_by_target": playables_by_target}, indent=2) + "\n")

    print("\nUniversal Daily 4 boolean counts:")
    for pos, name in enumerate(["first", "second", "third", "fourth"]):
        print(f"  {name}: {report[pos]['count']} rules")
        for item in report[pos]["top"][:5]:
            print(f"    {item['condition']}: support={item['support']} -> {item['top_digit']} ({item['max_prob']:.2%}, lift {item['lift']})")
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
