import json
import math
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NORM = ROOT / "data" / "normalized"
COND = ROOT / "data" / "conditions"
ALPHA = 1.0

GAMES = {
    "cashfive": {"file": "cashfive", "main": 35, "bonus": None, "bonus_field": None, "days": {0, 1, 2, 3, 4, 5}},
    "lottotexas": {"file": "lottotexas", "main": 54, "bonus": None, "bonus_field": None, "days": {0, 2, 5}},
    "texastwostep": {"file": "texastwostep", "main": 35, "bonus": 35, "bonus_field": "bonus_ball", "days": {0, 3}},
    "powerball": {"file": "powerball", "main": 69, "bonus": 26, "bonus_field": "powerball", "days": {0, 2, 5}},
    "megamillions": {"file": "megamillions", "main": 70, "bonus": 25, "bonus_field": "mega_ball", "days": {1, 4}},
}
ALL_KEYS = ["pick3", "daily4", "aon", "cashfive", "lottotexas", "texastwostep", "powerball", "megamillions"]
PRESENCE_FILES = {
    "pick3": ["pick3_morning", "pick3_day", "pick3_evening", "pick3_night"],
    "daily4": ["daily4_morning", "daily4_day", "daily4_evening", "daily4_night"],
    "aon": ["allornothing_morning", "allornothing_day", "allornothing_evening", "allornothing_night"],
    "cashfive": ["cashfive"],
    "lottotexas": ["lottotexas"],
    "texastwostep": ["texastwostep"],
    "powerball": ["powerball"],
    "megamillions": ["megamillions"],
}
SCHEDULE_DAYS = {
    "pick3": {0, 1, 2, 3, 4, 5},
    "daily4": {0, 1, 2, 3, 4, 5},
    "aon": {0, 1, 2, 3, 4, 5},
    "cashfive": {0, 1, 2, 3, 4, 5},
    "lottotexas": {0, 2, 5},
    "texastwostep": {0, 3},
    "powerball": {0, 2, 5},
    "megamillions": {1, 4},
}


def row_date(r):
    return date(int(r["year"]), int(r["month"]), int(r["day"]))


def load_rows(name):
    data = json.loads((NORM / f"{name}.json").read_text())
    return data.get("rows", data) if isinstance(data, dict) else data


def specs_for(game, cfg):
    specs = []
    n = len(load_rows(cfg["file"])["rows"][-1]["numbers"]) if False else None
    return specs


def build_specs(cfg):
    # main length inferred from first valid row later; use known lengths
    lengths = {"cashfive": 5, "lottotexas": 6, "texastwostep": 4, "powerball": 5, "megamillions": 5}
    return lengths


def make_specs(game):
    cfg = GAMES[game]
    lengths = {"cashfive": 5, "lottotexas": 6, "texastwostep": 4, "powerball": 5, "megamillions": 5}
    specs = []
    for i in range(lengths[game]):
        specs.append({"kind": "main", "idx": i, "pool": list(range(1, cfg["main"] + 1)), "field": "numbers"})
    if cfg["bonus"]:
        specs.append({"kind": "bonus", "idx": None, "pool": list(range(1, cfg["bonus"] + 1)), "field": cfg["bonus_field"]})
    for s in specs:
        s["outcomes"] = s["pool"]
    return specs


def valid_rows(game):
    cfg = GAMES[game]
    rows = load_rows(cfg["file"])
    out = []
    for r in rows:
        nums = r.get("numbers", [])
        if not nums or any(n < 1 or n > cfg["main"] for n in nums):
            continue
        if cfg["bonus"]:
            b = r.get(cfg["bonus_field"])
            if b is None or b < 1 or b > cfg["bonus"]:
                continue
        out.append(r)
    return out


def next_scheduled(last, days):
    d = last + timedelta(days=1)
    for _ in range(20):
        if d.weekday() in days:
            return d
        d += timedelta(days=1)
    return d


def presence_map():
    pres = defaultdict(set)
    for key, slugs in PRESENCE_FILES.items():
        for slug in slugs:
            for r in load_rows(slug):
                pres[str(r.get("date") or f"{r['year']:04d}-{r['month']:02d}-{r['day']:02d}")].add(key)
    return pres


def sched_flags(d):
    return {k for k, days in SCHEDULE_DAYS.items() if d.weekday() in days}


def flags_for(pres, d, upcoming):
    return sched_flags(d) if upcoming else pres.get(str(d), set())


def big_features(rows, j, pos, next_date, earlier, spec, flags):
    prev = rows[j - 1]
    pd = prev.get("numbers", [])
    rd = row_date(prev)
    nd = next_date
    pool = spec["pool"][-1]
    feats = {
        "pos": str(pos),
        "kind": spec["kind"],
        "pool": str(pool),
        "prev_dow": str(rd.weekday()),
        "next_dow": str(nd.weekday()),
        "date_gap": str((nd - rd).days),
        "prev_month": str(rd.month),
        "next_month": str(nd.month),
        "prev_day_parity": str(rd.day % 2),
        "next_day_parity": str(nd.day % 2),
        "prev_sum_mod10": str(sum(pd) % 10),
        "prev_sum_bucket": str(min(9, sum(pd) // max(1, pool))),
        "prev_odd_count": str(sum(n % 2 for n in pd)),
        "prev_high_count": str(sum(n > pool // 2 for n in pd)),
        "prev_min_bucket": str(min(pd) // 10 if pd else 0),
        "prev_max_bucket": str(max(pd) // 10 if pd else 0),
        "prev_sorted": "yes" if pd == sorted(pd) else "no",
        "prev_adjacent_eq": str(sum(1 for a, b in zip(pd, pd[1:]) if a == b)),
        "earlier_count": str(len(earlier)),
    }
    if spec["kind"] == "main":
        idx = spec["idx"]
        if idx < len(pd):
            feats["same_pos_prev"] = str(pd[idx])
            feats["same_pos_prev_bucket"] = str(pd[idx] // 10)
        if j >= 2:
            p2 = rows[j - 2].get("numbers", [])
            if idx < len(p2):
                feats["same_pos_prev2"] = str(p2[idx])
        if idx < len(pd):
            feats["prev_last"] = str(pd[-1])
            feats["prev_first"] = str(pd[0])
    else:
        bf = spec["field"]
        pb = prev.get(bf)
        if pb is not None:
            feats["same_pos_prev"] = str(pb)
            feats["same_pos_prev_bucket"] = str(pb // 10)
        if j >= 2:
            p2b = rows[j - 2].get(bf)
            if p2b is not None:
                feats["same_pos_prev2"] = str(p2b)
    if earlier:
        feats["earlier_sum_mod10"] = str(sum(earlier) % 10)
        feats["earlier_min_bucket"] = str(min(earlier) // 10)
        feats["earlier_max_bucket"] = str(max(earlier) // 10)
        feats["earlier_high_count"] = str(sum(n > pool // 2 for n in earlier))
        feats["earlier_sorted"] = "yes" if earlier == sorted(earlier) else "no"
    for k in ALL_KEYS:
        feats[f"has_{k}"] = "yes" if k in flags else "no"
    return feats


def num_dist(counts_pos, feats, outcomes, alpha=ALPHA):
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
    norm = sum(exp.values()) or 1.0
    return {o: exp[o] / norm for o in outcomes}


def add_stream(counts, rows, specs, pres):
    for j in range(1, len(rows)):
        nd = row_date(rows[j])
        flags = pres.get(str(nd), set())
        for p, spec in enumerate(specs):
            earlier = rows[j]["numbers"][: spec["idx"]] if spec["kind"] == "main" else rows[j]["numbers"]
            feats = big_features(rows, j, p, nd, earlier, spec, flags)
            outcome = rows[j]["numbers"][spec["idx"]] if spec["kind"] == "main" else rows[j][spec["field"]]
            counts[p]["_prior"][str(outcome)] += 1
            for feat, state in feats.items():
                counts[p].setdefault(feat, defaultdict(Counter))
                counts[p][feat][state][str(outcome)] += 1


def mine_report(counts, specs, min_support=20, top_n=8):
    report = {}
    for p, spec in enumerate(specs):
        outcomes = spec["outcomes"]
        prior = counts[p]["_prior"]
        prior_total = sum(prior.values()) or 1
        base = {o: (prior.get(str(o), 0) + ALPHA) / (prior_total + ALPHA * len(outcomes)) for o in outcomes}
        base_max = max(base.values())
        items = []
        for feat, states in counts[p].items():
            if feat == "_prior":
                continue
            for state, table in states.items():
                support = sum(table.values())
                if support < min_support:
                    continue
                dist = {o: (table.get(str(o), 0) + ALPHA) / (support + ALPHA * len(outcomes)) for o in outcomes}
                top = max(dist, key=dist.get)
                items.append({"condition": f"{feat} == {state}", "support": support, "top_number": top, "max_prob": round(dist[top], 6), "lift": round(dist[top] / max(base_max, 1e-9), 4)})
        items.sort(key=lambda x: (-x["max_prob"], -x["support"], x["condition"]))
        report[p] = {"count": len(items), "top": items[:top_n]}
    return report


def score_game(rows, counts, specs, next_date, beam=60, branch=8, plays=10):
    flags = sched_flags(next_date)
    partials = [{"seq": [], "score": 1.0, "probs": []}]
    for p, spec in enumerate(specs):
        new = []
        for part in partials:
            earlier = part["seq"] if spec["kind"] == "main" else part["seq"]
            feats = big_features(rows, len(rows), p, next_date, earlier, spec, flags)
            dist = num_dist(counts[p], feats, spec["outcomes"])
            chosen = set(part["seq"]) if spec["kind"] == "main" else set()
            ranked = sorted(((o, dist[o]) for o in spec["outcomes"] if o not in chosen), key=lambda x: -x[1])[:branch]
            for o, prob in ranked:
                if prob <= 0:
                    continue
                new.append({"seq": part["seq"] + [o], "score": part["score"] * prob, "probs": part["probs"] + [round(prob, 6)]})
        new.sort(key=lambda x: -x["score"])
        partials = new[:beam]
    main_len = sum(1 for s in specs if s["kind"] == "main")
    has_bonus = any(s["kind"] == "bonus" for s in specs)
    out = []
    for p in partials[:plays]:
        item = {"numbers": p["seq"][:main_len], "score": round(p["score"], 12), "pos_probs": p["probs"]}
        if has_bonus:
            item["bonus"] = p["seq"][main_len]
        out.append(item)
    return out


def main():
    pres = presence_map()
    playables = {}
    reports = {}
    for game, cfg in GAMES.items():
        rows = valid_rows(game)
        specs = make_specs(game)
        counts = [{"_prior": Counter()} for _ in specs]
        add_stream(counts, rows, specs, pres)
        reports[game] = mine_report(counts, specs)
        last = row_date(rows[-1])
        nd = next_scheduled(last, cfg["days"])
        plays = score_game(rows, counts, specs, nd)
        playables[game] = {"upcoming_date": str(nd), "schedule_days": sorted(cfg["days"]), "history_rows": len(rows), "playables": plays}
        top = plays[0] if plays else {}
        print(game, "rows", len(rows), "next", nd, "top", top.get("numbers"), "bonus", top.get("bonus"))
    out = {
        "source": "big_games_booleans_universal",
        "boolean_counts": {g: {str(p): reports[g][p]["count"] for p in reports[g]} for g in reports},
        "booleans": {g: {str(p): reports[g][p]["top"] for p in reports[g]} for g in reports},
        "playables_by_target": playables,
    }
    path = COND / "big_games_booleans_universal.json"
    path.write_text(json.dumps(out, indent=1) + "\n")
    print("wrote", path)


if __name__ == "__main__":
    main()
