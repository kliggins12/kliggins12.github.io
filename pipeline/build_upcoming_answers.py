import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
COND = ROOT / "data" / "conditions"
NORM = ROOT / "data" / "normalized"
ASSETS = [
    ROOT / "data" / "conditions" / "upcoming_answers.txt",
]
REPORT = ROOT / "data" / "conditions" / "upcoming_match_report.txt"

SECTIONS = [
    ("PICK 3 - NEXT DRAW", "pick3_booleans_universal.json", "pos3", [
        ("pick3_morning", "Morning", None), ("pick3_day", "Day", None),
        ("pick3_evening", "Evening", None), ("pick3_night", "Night", None),
        ("pick3_all_synced", "Combined synced", None),
    ]),
    ("DAILY 4 - NEXT DRAW", "daily4_booleans_universal.json", "pos4", [
        ("daily4_morning", "Morning", None), ("daily4_day", "Day", None),
        ("daily4_evening", "Evening", None), ("daily4_night", "Night", None),
        ("daily4_all_synced", "Combined synced", None),
    ]),
    ("ALL OR NOTHING - NEXT DRAW", "allornothing_booleans_universal.json", "set", [
        ("allornothing_morning", "Morning", None), ("allornothing_day", "Day", None),
        ("allornothing_evening", "Evening", None), ("allornothing_night", "Night", None),
        ("allornothing_all_synced", "Combined synced", None),
    ]),
    ("BIG GAMES - NEXT DRAW", "big_games_booleans_universal.json", "setmain", [
        ("cashfive", "Cash Five", None), ("lottotexas", "Lotto Texas", None),
        ("texastwostep", "Texas Two Step", "BB"), ("powerball", "Powerball", "PB"),
        ("megamillions", "Mega Millions", "MB"),
    ]),
]
BONUS_FIELD = {"texastwostep": "bonus_ball", "powerball": "powerball", "megamillions": "mega_ball"}


def load_json(path):
    return json.loads(path.read_text())


def rows_for(target):
    data = load_json(NORM / f"{target}.json")
    return data.get("rows", data) if isinstance(data, dict) else data


def cand_parts(playable, mode):
    if "number" in playable:
        return [int(ch) for ch in playable["number"]], None
    return list(playable.get("numbers", [])), playable.get("bonus")


def key_for(mode, nums, bonus):
    if mode in ("pos3", "pos4"):
        return ("pos", tuple(nums))
    if mode == "set":
        return ("set", frozenset(nums))
    return ("set", frozenset(nums), bonus)


def score_for(mode, cand, hist_nums, bonus, hist_bonus):
    if mode in ("pos3", "pos4"):
        return sum(a == b for a, b in zip(cand, hist_nums))
    s = len(set(cand) & set(hist_nums))
    if bonus is not None and hist_bonus is not None and bonus == hist_bonus:
        s += 1
    return s


def fmt_date(d):
    return d[5:] if d else "--"


def mark_target(mode, target, playables, bonus_label):
    rows = rows_for(target)
    bfield = BONUS_FIELD.get(target)
    hist_keys = set()
    for r in rows:
        hist_keys.add(key_for(mode, r.get("numbers", []), r.get(bfield) if bfield else None))
    latest = rows[-1]
    latest_nums = latest.get("numbers", [])
    latest_bonus = latest.get(bfield) if bfield else None
    latest_key = key_for(mode, latest_nums, latest_bonus)
    latest_date = latest.get("date")
    out = []
    notable = []
    for pl in playables:
        cand, bonus = cand_parts(pl, mode)
        ckey = key_for(mode, cand, bonus)
        fresh = ckey not in hist_keys
        best_score = -1
        best_date = None
        for r in rows:
            hb = r.get(bfield) if bfield else None
            s = score_for(mode, cand, r.get("numbers", []), bonus, hb)
            if s > best_score or (s == best_score and (best_date is None or r.get("date", "") >= best_date)):
                best_score = s
                best_date = r.get("date")
        latest_score = score_for(mode, cand, latest_nums, bonus, latest_bonus)
        repeat = ckey == latest_key
        marks = []
        if fresh:
            marks.append("F")
        marks.append(f"B{best_score}@{fmt_date(best_date)}")
        marks.append(f"L{latest_score}@{fmt_date(latest_date)}")
        if repeat:
            marks.append("R")
        label = " ".join(map(str, cand)) if mode != "pos3" and mode != "pos4" else "".join(map(str, cand))
        if "number" in pl and mode in ("pos3", "pos4"):
            label = pl["number"]
        if bonus is not None and bonus_label:
            label += f" {bonus_label}{bonus}"
        out.append(f"{label}  {' '.join(marks)}")
        if repeat or (fresh and best_score > 0):
            notable.append(f"{label}  {' '.join(marks)}")
    return out, notable


def main():
    sections = []
    report = ["NOTABLE UPCOMING MATCHES"]
    for title, fname, mode, targets in SECTIONS:
        data = load_json(COND / fname)["playables_by_target"]
        lines = [f"=== {title} ==="]
        report.append(f"\n=== {title} ===")
        for target, label, bonus_label in targets:
            t = data[target]
            lines.append(f"{label} ({t['upcoming_date']}):")
            marked, notable = mark_target(mode, target, t["playables"], bonus_label)
            lines.extend(marked)
            lines.append("")
            if notable:
                report.append(f"{label} ({t['upcoming_date']}):")
                report.extend(notable)
                report.append("")
        sections.append("\n".join(lines).rstrip())
    text = (
        "UPCOMING CANDIDATE OUTCOMES\n"
        "Precreated for the next draw date. Marks: F=fresh combo, "
        "B=best historical match, L=latest draw match, R=repeat of latest draw. "
        "Dates are MM-DD in 2026.\n\n"
        + "\n\n".join(sections)
        + "\n"
    )
    for p in ASSETS:
        p.write_text(text)
        print("wrote", p)
    REPORT.write_text("\n".join(report).rstrip() + "\n")
    print("wrote", REPORT)


if __name__ == "__main__":
    main()
