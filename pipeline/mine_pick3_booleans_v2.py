#!/usr/bin/env python3
import argparse
import json
import math
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

from markov_pick3_shape import load_rows, REGION
from build_pick3_space import path_shape
from markov_pick3 import keypad_pos, move_dir
from score_pick3_sequential import cross_features, same_draw_features
from mine_pick3_booleans import digit_dist

ROOT = Path(__file__).resolve().parent
ALPHA = 1.0
ORDER = ["morning", "day", "evening", "night"]
SESSION_INDEX = {"morning": 0, "day": 1, "evening": 2, "night": 3}
GAME_ORDER = {"allornothing": 0, "daily4": 1, "pick3": 2}

def row_date(r):
    return date(r["year"], r["month"], r["day"])

def next_draw_info(rows):
    last = rows[-1]
    d0 = row_date(last)
    sessions = {r.get("session") for r in rows}
    last_s = last.get("session")

    def skip_sunday(d):
        while d.weekday() == 6:
            d += timedelta(days=1)
        return d

    if len(sessions) <= 1:
        return last_s, skip_sunday(d0 + timedelta(days=1))
    if last_s in ORDER:
        ns = ORDER[(ORDER.index(last_s) + 1) % len(ORDER)]
        nd = d0 + timedelta(days=1) if ORDER.index(ns) <= ORDER.index(last_s) else d0
        return ns, skip_sunday(nd)
    return last_s, skip_sunday(d0 + timedelta(days=1))

def parity(d):
    return "odd" if d % 2 else "even"

def high(d):
    return "high" if d >= 5 else "low"

def key_rc(d):
    if d == 0:
        return (3, 1)
    return ((d - 1) // 3, (d - 1) % 3)

def dist_keys(a, b):
    ra, ca = key_rc(a)
    rb, cb = key_rc(b)
    return abs(ra - rb) + abs(ca - cb)

OPP = {"N": "S", "S": "N", "E": "W", "W": "E", "NE": "SW", "SW": "NE", "NW": "SE", "SE": "NW"}

def event_presses(e):
    nums = e.get("numbers", [])
    if e.get("game") == "allornothing":
        presses = []
        for n in nums:
            s = str(int(n))
            if len(s) == 1:
                presses.append(int(s))
            else:
                presses.extend(int(ch) for ch in s)
        return presses
    return [int(d) for d in nums]

def rich_features(rows, j, pos, next_session, next_date, xprev=None, earlier=None):
    feats = cross_features(rows, j, pos, next_session)
    prev = rows[j - 1]
    pd = prev["numbers"]
    pr = [REGION[str(d)] for d in pd]
    for k in range(3):
        feats[f"p{k}_digit"] = str(pd[k])
        feats[f"p{k}_region"] = pr[k]
        feats[f"p{k}_parity"] = parity(pd[k])
        feats[f"p{k}_high"] = high(pd[k])
    feats["prev_pair_01"] = f"{pd[0]}|{pd[1]}"
    feats["prev_pair_12"] = f"{pd[1]}|{pd[2]}"
    feats["prev_pair_02"] = f"{pd[0]}|{pd[2]}"
    feats["prev_path_seg1"] = move_dir(keypad_pos(pd[0]), keypad_pos(pd[1]))
    feats["prev_path_seg2"] = move_dir(keypad_pos(pd[1]), keypad_pos(pd[2]))
    feats["prev_dow"] = str(row_date(prev).weekday())
    feats["next_dow"] = str(next_date.weekday())
    feats["date_gap"] = str((next_date - row_date(prev)).days)
    feats["prev_sum_exact"] = str(sum(pd))
    feats["prev_sum_mod3"] = str(sum(pd) % 3)
    feats["prev_sum_parity"] = parity(sum(pd))
    feats["prev_has_pair"] = "yes" if len(set(pd)) < 3 else "no"
    if j >= 2:
        feats["prevprev_session"] = rows[j - 2].get("session") or "none"
    if earlier is None:
        earlier = rows[j]["numbers"][:pos] if j < len(rows) else []
    feats.update(same_draw_features(pos, earlier))
    for k, d in enumerate(earlier):
        feats[f"earlier{k}_digit"] = str(d)
        feats[f"earlier{k}_region"] = REGION[str(d)]
        feats[f"earlier{k}_parity"] = parity(d)
        feats[f"earlier{k}_high"] = high(d)
    if earlier:
        feats["earlier_parity_seq"] = "".join("o" if d % 2 else "e" for d in earlier)
        feats["earlier_high_seq"] = "".join("h" if d >= 5 else "l" for d in earlier)
    rd, nd = row_date(prev), next_date
    feats["prev_month"] = str(rd.month)
    feats["next_month"] = str(nd.month)
    feats["prev_day_parity"] = parity(rd.day)
    feats["next_day_parity"] = parity(nd.day)
    feats["prev_week"] = str(rd.isocalendar().week)
    feats["next_week"] = str(nd.isocalendar().week)
    if j >= 3:
        p3 = rows[j - 3]["numbers"][pos]
        p2 = rows[j - 2]["numbers"][pos]
        r3 = REGION[str(p3)]
        r2 = REGION[str(p2)]
        r1 = REGION[str(pd[pos])]
        feats["same_pos_digit_o3"] = f"{p3}|{p2}|{pd[pos]}"
        feats["same_pos_region_o3"] = f"{r3}|{r2}|{r1}"
        t3 = rows[j - 3]["numbers"][2]
        t2 = rows[j - 2]["numbers"][2]
        rt3 = REGION[str(t3)]
        rt2 = REGION[str(t2)]
        rt1 = REGION[str(pd[2])]
        feats["prev_third_digit_o3"] = f"{t3}|{t2}|{pd[2]}"
        feats["prev_third_region_o3"] = f"{rt3}|{rt2}|{rt1}"
        feats["prev_pair_o2"] = f"{p2}|{pd[pos]}"
        feats["prev_path_o2"] = f"{path_shape(rows[j - 2]['numbers'])}>{path_shape(pd)}"
        prev2_regs = "|".join(REGION[str(d)] for d in rows[j - 2]["numbers"])
        feats["prev_draw_triple_o2"] = f"{prev2_regs}>{'|'.join(pr)}"
    for k, d in enumerate(earlier):
        for m in range(3):
            feats[f"e{k}_eq_p{m}"] = "yes" if d == pd[m] else "no"
            feats[f"e{k}_reg_eq_p{m}"] = "yes" if REGION[str(d)] == pr[m] else "no"
    for k in range(3):
        feats[f"p{k}_row"] = str(key_rc(pd[k])[0])
        feats[f"p{k}_col"] = str(key_rc(pd[k])[1])
        feats[f"p{k}_mod3"] = str(pd[k] % 3)
        feats[f"p{k}_mod4"] = str(pd[k] % 4)
    s1 = move_dir(keypad_pos(pd[0]), keypad_pos(pd[1]))
    s2 = move_dir(keypad_pos(pd[1]), keypad_pos(pd[2]))
    feats["prev_path_straight"] = "yes" if s1 == s2 else "no"
    feats["prev_path_reversal"] = "yes" if s2 == OPP.get(s1) else "no"
    feats["prev_seg1_len"] = str(dist_keys(pd[0], pd[1]))
    feats["prev_seg2_len"] = str(dist_keys(pd[1], pd[2]))
    feats["prev_path_len"] = str(dist_keys(pd[0], pd[1]) + dist_keys(pd[1], pd[2]))
    feats["prev_min_digit"] = str(min(pd))
    feats["prev_max_digit"] = str(max(pd))
    feats["prev_range"] = str(max(pd) - min(pd))
    feats["prev_sum_mod4"] = str(sum(pd) % 4)
    feats["prev_sum_mod5"] = str(sum(pd) % 5)
    feats["prev_odd_count"] = str(sum(d % 2 for d in pd))
    feats["prev_high_count"] = str(sum(d >= 5 for d in pd))
    feats["prev_contains_zero"] = "yes" if 0 in pd else "no"
    feats["prev_contains_five"] = "yes" if 5 in pd else "no"
    feats["prev_region_changes"] = str(sum(1 for a, b in zip(pr, pr[1:]) if a != b))
    feats["prev_all_same_region"] = "yes" if len(set(pr)) == 1 else "no"
    feats["next_is_weekend"] = "yes" if nd.weekday() >= 5 else "no"
    feats["prev_is_weekend"] = "yes" if rd.weekday() >= 5 else "no"
    gap = (nd - rd).days
    feats["gap_bucket"] = "1" if gap == 1 else "2" if gap == 2 else "3plus"
    feats["prev_season"] = str((rd.month - 1) // 3)
    feats["next_season"] = str((nd.month - 1) // 3)
    if len(earlier) >= 2:
        e0, e1 = earlier[0], earlier[1]
        feats["earlier_path"] = move_dir(keypad_pos(e0), keypad_pos(e1))
        feats["e0_eq_e1"] = "yes" if e0 == e1 else "no"
        feats["earlier_region_seq"] = f"{REGION[str(e0)]}|{REGION[str(e1)]}"
        feats["earlier_min"] = str(min(earlier))
        feats["earlier_max"] = str(max(earlier))
        feats["earlier_range"] = str(max(earlier) - min(earlier))
    if j >= 4:
        q4 = rows[j - 4]["numbers"][pos]
        a3 = rows[j - 3]["numbers"][pos]
        a2 = rows[j - 2]["numbers"][pos]
        feats["same_pos_digit_o4"] = f"{q4}|{a3}|{a2}|{pd[pos]}"
        feats["same_pos_region_o4"] = f"{REGION[str(q4)]}|{REGION[str(a3)]}|{REGION[str(a2)]}|{r1}"
        t4 = rows[j - 4]["numbers"][2]
        feats["prev_third_digit_o4"] = f"{t4}|{t3}|{t2}|{pd[2]}"
        feats["prev_third_region_o4"] = f"{REGION[str(t4)]}|{rt3}|{rt2}|{rt1}"
    for lag in range(1, 6):
        if j - 1 - lag >= 0:
            old = rows[j - 1 - lag]["numbers"]
            old_regs = [REGION[str(d)] for d in old]
            feats[f"prev_num_eq_lag{lag}"] = "yes" if old == pd else "no"
            feats[f"same_pos_eq_lag{lag}"] = "yes" if old[pos] == pd[pos] else "no"
            feats[f"prev_path_eq_lag{lag}"] = "yes" if path_shape(old) == path_shape(pd) else "no"
            feats[f"prev_region_triple_eq_lag{lag}"] = "yes" if old_regs == pr else "no"
    feats["prev_sorted_asc"] = "yes" if pd == sorted(pd) else "no"
    feats["prev_sorted_desc"] = "yes" if pd == sorted(pd, reverse=True) else "no"
    feats["prev_adjacent_equal_count"] = str(sum(1 for a, b in zip(pd, pd[1:]) if a == b))
    feats["prev_unique_count"] = str(len(set(pd)))
    feats["prev_median_digit"] = str(sorted(pd)[1])
    prev_counts = Counter(pd)
    mode_n = max(prev_counts.values())
    feats["prev_mode_digit"] = str(min(d for d, c in prev_counts.items() if c == mode_n))
    feats["prev_corner_count"] = str(sum(1 for r in pr if r == "corner"))
    feats["prev_edge_count"] = str(sum(1 for r in pr if r == "edge"))
    feats["prev_center_count"] = str(sum(1 for r in pr if r == "center"))
    feats["prev_zero_count"] = str(sum(1 for r in pr if r == "zero"))
    feats["prev_path_has_C"] = "yes" if "C" in (s1, s2) else "no"
    feats["prev_path_diagonal_count"] = str(sum(1 for s in (s1, s2) if len(s) == 2))
    feats["prev_path_orthogonal_count"] = str(sum(1 for s in (s1, s2) if len(s) == 1 and s != "C"))
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
    sp_gap = _gap(lambda r: r["numbers"][pos] == pd[pos])
    pn_gap = _gap(lambda r: r["numbers"] == pd)
    pp_gap = _gap(lambda r: path_shape(r["numbers"]) == pshape)
    pt_gap = _gap(lambda r: r["numbers"][2] == pd[2])
    feats["same_pos_streak"] = str(sp_streak)
    feats["same_pos_streak_bucket"] = _gb(sp_streak)
    feats["prev_num_streak"] = str(pn_streak)
    feats["prev_num_streak_bucket"] = _gb(pn_streak)
    feats["prev_path_streak"] = str(pp_streak)
    feats["prev_path_streak_bucket"] = _gb(pp_streak)
    feats["prev_third_streak"] = str(pt_streak)
    feats["prev_third_streak_bucket"] = _gb(pt_streak)
    feats["same_pos_digit_gap"] = str(min(sp_gap, 99))
    feats["same_pos_digit_gap_bucket"] = _gb(sp_gap)
    feats["prev_num_gap_bucket"] = _gb(pn_gap)
    feats["prev_path_gap_bucket"] = _gb(pp_gap)
    feats["prev_third_digit_gap_bucket"] = _gb(pt_gap)
    feats["next_is_saturday"] = "yes" if nd.weekday() == 5 else "no"
    feats["prev_is_saturday"] = "yes" if rd.weekday() == 5 else "no"
    feats["next_is_friday"] = "yes" if nd.weekday() == 4 else "no"
    feats["prev_is_friday"] = "yes" if rd.weekday() == 4 else "no"
    feats["next_is_monday"] = "yes" if nd.weekday() == 0 else "no"
    feats["prev_is_monday"] = "yes" if rd.weekday() == 0 else "no"
    feats["draws_on_weekday"] = "yes" if nd.weekday() <= 5 else "no"
    feats["prev_draws_on_weekday"] = "yes" if rd.weekday() <= 5 else "no"
    feats["long_gap"] = "yes" if gap > 1 else "no"
    ns, ps = next_session or "", prev.get("session") or ""
    if ns in ORDER:
        feats["next_session_index"] = str(ORDER.index(ns))
        feats["next_is_first_session"] = "yes" if ORDER.index(ns) == 0 else "no"
        feats["next_is_last_session"] = "yes" if ORDER.index(ns) == 3 else "no"
    if ps in ORDER:
        feats["prev_session_index"] = str(ORDER.index(ps))
    if ns in ORDER and ps in ORDER:
        feats["session_index_delta"] = str((ORDER.index(ns) - ORDER.index(ps)) % 4)
    for k, xe in enumerate(xprev or []):
        xp = event_presses(xe)
        p = f"x{k}"
        feats[f"{p}_game"] = str(xe.get("game", ""))
        feats[f"{p}_session"] = str(xe.get("session", ""))
        try:
            feats[f"{p}_date_gap"] = str((nd - date.fromisoformat(str(xe.get("date", nd)))).days)
        except Exception:
            feats[f"{p}_date_gap"] = "na"
        feats[f"{p}_npress"] = str(len(xp))
        if xp:
            feats[f"{p}_sum_mod10"] = str(sum(xp) % 10)
            feats[f"{p}_sum_parity"] = parity(sum(xp))
            feats[f"{p}_high_count"] = str(sum(1 for d in xp if d >= 5))
            feats[f"{p}_first"] = str(xp[0])
            feats[f"{p}_last"] = str(xp[-1])
            feats[f"{p}_first_region"] = REGION[str(xp[0])]
            feats[f"{p}_last_region"] = REGION[str(xp[-1])]
            if pos < len(xp):
                d = xp[pos]
                feats[f"{p}_same_digit"] = str(d)
                feats[f"{p}_same_region"] = REGION[str(d)]
                feats[f"{p}_same_parity"] = parity(d)
                feats[f"{p}_same_high"] = high(d)
            if pos > 0 and pos - 1 < len(xp):
                d = xp[pos - 1]
                feats[f"{p}_prev_digit"] = str(d)
                feats[f"{p}_prev_region"] = REGION[str(d)]
                feats[f"{p}_prev_parity"] = parity(d)
                feats[f"{p}_prev_high"] = high(d)
            feats[f"{p}_same_session"] = "yes" if xe.get("session") == next_session else "no"
            feats[f"{p}_same_date"] = "yes" if str(xe.get("date")) == str(nd) else "no"
            feats[f"{p}_session_index"] = str(SESSION_INDEX.get(str(xe.get("session")), 9))
            feats[f"{p}_game_order"] = str(GAME_ORDER.get(str(xe.get("game")), 9))
            try:
                xw = date.fromisoformat(str(xe.get("date", nd))).weekday()
                feats[f"{p}_weekday"] = str(xw)
                feats[f"{p}_weekend"] = "yes" if xw >= 5 else "no"
            except Exception:
                feats[f"{p}_weekday"] = "na"
                feats[f"{p}_weekend"] = "na"
            if xp:
                feats[f"{p}_contains_zero"] = "yes" if 0 in xp else "no"
                feats[f"{p}_press_parity_seq"] = "".join("o" if d % 2 else "e" for d in xp[:3])
                feats[f"{p}_press_high_seq"] = "".join("h" if d >= 5 else "l" for d in xp[:3])
                if len(xp) >= 2:
                    moves = []
                    for a, b in zip(xp[:3], xp[1:4]):
                        moves.append(move_dir(keypad_pos(a), keypad_pos(b)))
                    feats[f"{p}_path3"] = ">".join(moves)
                if pos < len(xp):
                    feats[f"{p}_same_eq_prevpos"] = "yes" if xp[pos] == pd[pos] else "no"
                    feats[f"{p}_first_eq_prevpos"] = "yes" if xp[0] == pd[pos] else "no"
                    feats[f"{p}_last_eq_prevpos"] = "yes" if xp[-1] == pd[pos] else "no"
                    feats[f"{p}_sum_eq_prevpos"] = "yes" if sum(xp) % 10 == sum(pd) % 10 else "no"
    rc = {r: pr.count(r) for r in ("corner", "edge", "center", "zero")}
    feats["prev_corner_count"] = str(rc["corner"])
    feats["prev_edge_count"] = str(rc["edge"])
    feats["prev_center_count"] = str(rc["center"])
    feats["prev_zero_count"] = str(rc["zero"])
    feats["prev_has_zero"] = "yes" if rc["zero"] else "no"
    feats["prev_has_center"] = "yes" if rc["center"] else "no"
    feats["prev_all_same_region"] = "yes" if len(set(pr)) == 1 else "no"
    feats["prev_region_unique"] = str(len(set(pr)))
    feats["prev_alt_sum_mod10"] = str((pd[0] - pd[1] + pd[2]) % 10)
    feats["prev_digital_sum_mod9"] = str(sum(int(ch) for ch in str(sum(pd))) % 9)
    feats["prev_product_mod10"] = str((pd[0] * pd[1] * pd[2]) % 10)
    feats["next_day_bucket"] = str((nd.day - 1) // 7)
    feats["prev_day_bucket"] = str((rd.day - 1) // 7)
    feats["next_month_odd"] = "yes" if nd.month % 2 else "no"
    feats["prev_month_odd"] = "yes" if rd.month % 2 else "no"
    feats["next_is_month_end"] = "yes" if nd.day >= 28 else "no"
    feats["prev_is_month_end"] = "yes" if rd.day >= 28 else "no"
    feats["next_week_odd"] = "yes" if nd.isocalendar().week % 2 else "no"
    feats["prev_week_odd"] = "yes" if rd.isocalendar().week % 2 else "no"
    feats["next_quarter"] = str((nd.month - 1) // 3)
    feats["prev_quarter"] = str((rd.month - 1) // 3)
    feats["next_dow_odd"] = "yes" if nd.weekday() % 2 else "no"
    feats["prev_dow_odd"] = "yes" if rd.weekday() % 2 else "no"
    if j >= 5:
        p5 = rows[j - 5]["numbers"][pos]
        r5 = REGION[str(p5)]
        feats["same_pos_digit_o5"] = f"{p5}|{rows[j - 4]['numbers'][pos]}|{rows[j - 3]['numbers'][pos]}|{rows[j - 2]['numbers'][pos]}|{pd[pos]}"
        feats["same_pos_region_o5"] = f"{r5}|{REGION[str(rows[j - 4]['numbers'][pos])]}|{REGION[str(rows[j - 3]['numbers'][pos])]}|{REGION[str(rows[j - 2]['numbers'][pos])]}|{REGION[str(pd[pos])]}"
    return feats

def main():
    ap = argparse.ArgumentParser(description="Expanded boolean miner for Pick 3 playables.")
    ap.add_argument("--input", default="data/normalized/pick3_all_synced.json")
    ap.add_argument("--space", default="data/pick3_space.json")
    ap.add_argument("--min-support", type=int, default=30)
    ap.add_argument("--top-booleans", type=int, default=10)
    ap.add_argument("--beam", type=int, default=5)
    ap.add_argument("--branch", type=int, default=5)
    ap.add_argument("--plays", type=int, default=30)
    ap.add_argument("--min-press-prob", type=float, default=0.0)
    ap.add_argument("--min-score", type=float, default=0.0)
    ap.add_argument("--output", default=None)
    args = ap.parse_args()

    rows = load_rows(args.input)
    space = json.loads((ROOT / args.space).read_text())
    space_by_digits = {tuple(e["digits"]): e for e in space}
    counts = {p: {"_prior": Counter()} for p in range(3)}
    feature_states = {p: defaultdict(set) for p in range(3)}

    for j in range(1, len(rows)):
        next_session = rows[j].get("session")
        next_date = row_date(rows[j])
        for pos in range(3):
            feats = rich_features(rows, j, pos, next_session, next_date)
            outcome = str(rows[j]["numbers"][pos])
            counts[pos]["_prior"][outcome] += 1
            for feat, state in feats.items():
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
                dist = {d: (table.get(str(d), 0) + ALPHA) / (support + ALPHA * 10) for d in range(10)}
                top_digit = max(dist, key=dist.get)
                items.append({"condition": f"{feat} == {state}", "support": support, "top_digit": top_digit, "max_prob": round(dist[top_digit], 6), "lift": round(dist[top_digit] / max(base_max, 1e-9), 4)})
        items.sort(key=lambda x: (-x["max_prob"], -x["support"], x["condition"]))
        boolean_report[pos] = {"count": len(items), "top": items[: args.top_booleans]}

    upcoming_session, upcoming_date = next_draw_info(rows)
    def context(pos, earlier):
        return rich_features(rows, len(rows), pos, upcoming_session, upcoming_date)

    d0 = digit_dist(counts[0], context(0, []))
    first_digits = sorted(range(10), key=lambda d: -d0[d])[: args.beam]
    partials = []
    for a in first_digits:
        d1 = digit_dist(counts[1], context(1, [a]))
        if args.min_press_prob and max(d1.values()) < args.min_press_prob:
            pass
        for b in sorted(range(10), key=lambda d: -d1[d])[: args.branch]:
            if args.min_press_prob and d1[b] < args.min_press_prob:
                continue
            d2 = digit_dist(counts[2], context(2, [a, b]))
            for c in sorted(range(10), key=lambda d: -d2[d])[: args.branch]:
                if args.min_press_prob and (d0[a] < args.min_press_prob or d2[c] < args.min_press_prob):
                    continue
                digits = (a, b, c)
                entry = space_by_digits.get(digits, {"number": f"{a}{b}{c}", "digits": list(digits), "regions": [], "path": ""})
                score = d0[a] * d1[b] * d2[c]
                if score < args.min_score:
                    continue
                partials.append({"number": entry.get("number", f"{a}{b}{c}"), "digits": list(digits), "regions": entry.get("regions", []), "path": entry.get("path", ""), "score": round(score, 10), "press_probs": {"first": round(d0[a], 6), "second": round(d1[b], 6), "third": round(d2[c], 6)}})
    partials.sort(key=lambda x: (-x["score"], x["number"]))
    playables = partials[: args.plays]

    slug = Path(args.input).stem
    out_path = Path(args.output) if args.output else ROOT / "data" / "conditions" / f"{slug}_booleans_v2.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"input": str(Path(args.input)), "upcoming_session": upcoming_session, "upcoming_date": str(upcoming_date), "boolean_counts": {str(p): boolean_report[p]["count"] for p in range(3)}, "booleans": {str(p): boolean_report[p]["top"] for p in range(3)}, "playables": playables}, indent=2) + "\n")

    print(f"Rows: {len(rows)}  upcoming: {upcoming_session} {upcoming_date}")
    for pos, name in enumerate(["first", "second", "third"]):
        print(f"\n{name.title()} press booleans: {boolean_report[pos]['count']} rules")
        for item in boolean_report[pos]["top"]:
            print(f"  {item['condition']}: support={item['support']} -> {item['top_digit']} ({item['max_prob']:.2%}, lift {item['lift']})")
    print("\nPlayable list:")
    for item in playables:
        print(f"  {item['number']}  score={item['score']:.8f}  path={item['path']}  probs={item['press_probs']}")
    print(f"Wrote {out_path}")

if __name__ == "__main__":
    main()
