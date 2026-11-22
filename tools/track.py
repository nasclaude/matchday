#!/usr/bin/env python3
"""Matchday results log: records every pick, settles it from the final score, and measures how
well the win percentages matched reality (calibration, Brier scores) and how the slips did.

The data is one JSON object per pick in a JSON Lines file (keep it in a PRIVATE repository).

Commands (all take --data PATH, default ./picks.jsonl)
  add SLIPS_JSON          add the day's picks from the same slips.json the app uses
  open [--all]            matches with unsettled picks whose kickoff was 2h15m+ ago (JSON)
  settle SCORES_JSON      settle picks from final scores, e.g.
                            {"scores": {"2026-11-22|Man City v Fulham": "2-1",
                                        "2026-11-22|Como v Cagliari": "postponed"},
                             "manual": {"2026-11-22|A|3": "win"}}
                          Scores are after 90 minutes plus stoppage time (no extra time or penalties).
  report [--days N]       Markdown track record
  stats [--days N]        the same numbers as JSON

Runs: slips.json may set "run" (default "daily"). Picks from another run, such as "custom-1430"
for slips built from the user's own screenshots, get ids "<date>~<run>|<slip>|<leg>", are only
replaced by a later add of that same run, and appear as "(your matches)" in the slip results.

Pick fields read from slips.json legs and singles (see tools/SCHEMA.md):
  match, home, away, matchDate (default: the slips' date), kickoff, competition, market, bet,
  odds, bookmaker, winPct, modelPct, marketPct, and for automatic settlement:
  marketCode + side (+ line):
    1x2        side home|draw|away
    dc         side 1X|X2|12
    dnb        side home|away
    total      side over|under, line (e.g. 2.5, 3, 2.25)
    home_goals side over|under, line      away_goals  side over|under, line
    btts       side yes|no
    win_to_nil side home|away
    ah         side home|away, line from that side's point of view (e.g. -1, -0.75, +0.5)
    other      settled by hand through "manual"
"""
import argparse
import json
import math
import re
import sys
from datetime import date as Date
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from zoneinfo import ZoneInfo

    TZ = ZoneInfo("Europe/Berlin")
except Exception:  # no time-zone database available: assume CET
    TZ = timezone(timedelta(hours=1))

CODES = {
    "1x2": {"home", "draw", "away"},
    "dc": {"1X", "X2", "12"},
    "dnb": {"home", "away"},
    "total": {"over", "under"},
    "home_goals": {"over", "under"},
    "away_goals": {"over", "under"},
    "btts": {"yes", "no"},
    "win_to_nil": {"home", "away"},
    "ah": {"home", "away"},
}
NEEDS_LINE = {"total", "home_goals", "away_goals", "ah"}
RESULTS = ("win", "half_win", "push", "half_loss", "loss", "void")
SLIP_ORDER = {"A": 0, "B": 1, "C": 2, "E": 3, "D": 4}
BANDS = ((40, 50), (50, 60), (60, 70), (70, 80), (80, 90), (90, 101))


# ------------------------------------------------------------------ settlement
def _wpl(margin, quarters):
    s = margin * 4 + quarters
    return "W" if s > 0 else ("P" if s == 0 else "L")


_COMBINE = {
    ("W", "W"): "win",
    ("P", "W"): "half_win",
    ("W", "P"): "half_win",
    ("P", "P"): "push",
    ("L", "P"): "half_loss",
    ("P", "L"): "half_loss",
    ("L", "L"): "loss",
}


def line_result(margin, line):
    """A bet that wins when margin + line > 0, with whole, half and quarter lines."""
    q = round(float(line) * 4)
    if q % 2 == 0:
        return {"W": "win", "P": "push", "L": "loss"}[_wpl(margin, q)]
    return _COMBINE[(_wpl(margin, q - 1), _wpl(margin, q + 1))]


def settle_pick(code, side, line, hg, ag):
    d, t = hg - ag, hg + ag
    if code == "1x2":
        ok = {"home": d > 0, "draw": d == 0, "away": d < 0}[side]
    elif code == "dc":
        ok = {"1X": d >= 0, "X2": d <= 0, "12": d != 0}[side]
    elif code == "btts":
        ok = (hg > 0 and ag > 0) == (side == "yes")
    elif code == "win_to_nil":
        ok = (hg > 0 and ag == 0) if side == "home" else (ag > 0 and hg == 0)
    elif code == "dnb":
        return line_result(d if side == "home" else -d, 0)
    elif code == "ah":
        return line_result(d if side == "home" else -d, line)
    elif code in ("total", "home_goals", "away_goals"):
        goals = {"total": t, "home_goals": hg, "away_goals": ag}[code]
        return line_result(goals, -float(line)) if side == "over" else line_result(-goals, float(line))
    else:
        raise ValueError(f"unknown marketCode {code}")
    return "win" if ok else "loss"


def factor(result, odds):
    return {"win": odds, "half_win": (odds + 1) / 2, "push": 1.0, "void": 1.0, "half_loss": 0.5, "loss": 0.0}[result]


# ------------------------------------------------------------------ storage
def load(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def save(path, recs):
    recs.sort(key=lambda r: (r["date"], run_of(r) != "daily", run_of(r), SLIP_ORDER.get(r["slip"], 9), r["slip"], r["leg"]))
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in recs), encoding="utf-8")
    tmp.replace(path)


def clean_run(v):
    run = re.sub(r"[^a-z0-9-]", "", str(v or "daily").lower())[:24]
    return run or "daily"


def run_of(r):
    return r.get("run") or "daily"


def opt_float(v):
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None


def match_key(r):
    return f"{r['matchDate']}|{r['match']}"


def kickoff_dt(r):
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", str(r.get("kickoff") or "").strip())
    if not m:
        return None
    y, mo, d = (int(x) for x in r["matchDate"].split("-"))
    return datetime(y, mo, d, int(m.group(1)), int(m.group(2)), tzinfo=TZ)


# ------------------------------------------------------------------ commands
def make_record(pid, day, run, slip, leg, i, n, warnings):
    match = str(leg.get("match") or "").strip()
    home, away = leg.get("home"), leg.get("away")
    if (not home or not away) and re.search(r"\s+vs?\.?\s+", match):
        home, away = re.split(r"\s+vs?\.?\s+", match, maxsplit=1)
    code = str(leg.get("marketCode") or "other").strip()
    side = leg.get("side")
    line = opt_float(leg.get("line"))
    if code != "other":
        if code not in CODES or side not in CODES[code] or (code in NEEDS_LINE and line is None):
            warnings.append(f"{pid}: marketCode/side/line not usable ({code}/{side}/{leg.get('line')}); it will need manual settling")
            code = "other"
    if code == "dnb":
        line = 0.0
    try:
        odds, win = float(leg["odds"]), float(leg["winPct"])
    except (KeyError, TypeError, ValueError):
        raise SystemExit(f"track: {pid}: odds and winPct are required")
    return {
        "id": pid,
        "date": day,
        "run": run,
        "slip": str(slip.get("id")),
        "slipName": slip.get("name"),
        "stake": float(slip.get("stake") or 5),
        "system": bool(slip.get("system")),
        "leg": i,
        "legs": n,
        "match": match,
        "home": home,
        "away": away,
        "matchDate": leg.get("matchDate") or day,
        "kickoff": leg.get("kickoff"),
        "competition": leg.get("competition"),
        "market": leg.get("market"),
        "marketCode": code,
        "side": side if code != "other" else leg.get("side"),
        "line": line,
        "bet": leg.get("bet"),
        "odds": odds,
        "bookmaker": leg.get("bookmaker"),
        "winPct": win,
        "modelPct": opt_float(leg.get("modelPct")),
        "marketPct": opt_float(leg.get("marketPct")),
        "result": None,
        "score": None,
        "settledAt": None,
    }


def cmd_add(a):
    data = json.loads(Path(a.slips).read_text(encoding="utf-8"))
    day = str(data.get("date") or "")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        raise SystemExit('track: slips.json needs "date": "YYYY-MM-DD"')
    run = clean_run(data.get("run"))
    prefix = day if run == "daily" else f"{day}~{run}"
    entries = []
    for s in data.get("slips") or []:
        legs = s.get("legs") or []
        for i, leg in enumerate(legs, 1):
            entries.append((f"{prefix}|{s.get('id')}|{i}", s, leg, i, len(legs)))
    for k, x in enumerate(data.get("singles") or [], 1):
        sid = f"S{k}"
        entries.append((f"{prefix}|{sid}|1", {"id": sid, "name": x.get("label") or "Single", "stake": x.get("stake") or 5}, x, 1, 1))

    recs = load(a.data)
    by_id = {r["id"]: r for r in recs}
    warnings, added, replaced, kept = [], 0, 0, 0
    new_ids = set()
    for pid, slip, leg, i, n in entries:
        new_ids.add(pid)
        old = by_id.get(pid)
        if old and old.get("result"):
            kept += 1
            continue
        by_id[pid] = make_record(pid, day, run, slip, leg, i, n, warnings)
        if old:
            replaced += 1
        else:
            added += 1
    # A later run of the same kind for the same day replaces that run's earlier, still-open picks.
    dropped = [pid for pid, r in by_id.items() if r["date"] == day and run_of(r) == run and pid not in new_ids and not r.get("result")]
    for pid in dropped:
        del by_id[pid]
    save(a.data, list(by_id.values()))
    for w in warnings:
        print(f"track: warning: {w}")
    print(f"track: {added} picks added, {replaced} replaced, {len(dropped)} dropped, {kept} already settled (kept) for {prefix}")


def cmd_open(a):
    now = datetime.now(TZ)
    out = {}
    for r in load(a.data):
        if r.get("result"):
            continue
        ko = kickoff_dt(r)
        if not a.all and ko is not None and now < ko + timedelta(hours=2, minutes=15):
            continue
        key = match_key(r)
        item = out.setdefault(key, {"key": key, "date": r["matchDate"], "match": r["match"], "kickoff": r.get("kickoff"), "competition": r.get("competition"), "picks": 0, "manualIds": []})
        item["picks"] += 1
        if r.get("marketCode") == "other":
            item["manualIds"].append(r["id"])
    print(json.dumps(sorted(out.values(), key=lambda x: (x["date"], x["kickoff"] or "")), indent=1, ensure_ascii=False))


def cmd_settle(a):
    spec = json.loads(Path(a.scores).read_text(encoding="utf-8"))
    if not isinstance(spec, dict):
        raise SystemExit("track: scores file must be a JSON object")
    scores = spec.get("scores", spec if "manual" not in spec else {})
    manual = spec.get("manual", {})
    recs = load(a.data)
    now = datetime.now(TZ).isoformat(timespec="minutes")
    used, done, needs_manual = set(), 0, []
    for r in recs:
        if r.get("result"):
            continue
        key = match_key(r)
        if r["id"] in manual:
            res = str(manual[r["id"]]).strip().lower()
            if res not in RESULTS:
                raise SystemExit(f"track: {r['id']}: result must be one of {', '.join(RESULTS)}")
            r.update(result=res, settledAt=now)
            if key in scores:
                r["score"] = str(scores[key])
                used.add(key)
            used.add(r["id"])
            done += 1
            continue
        if key not in scores:
            continue
        used.add(key)
        v = str(scores[key]).strip().lower()
        if v in ("postponed", "abandoned", "cancelled", "canceled", "void"):
            r.update(result="void", score=v, settledAt=now)
            done += 1
            continue
        m = re.fullmatch(r"(\d+)\s*[-:]\s*(\d+)", v)
        if not m:
            raise SystemExit(f"track: {key}: score must look like 2-1 (or 'postponed'), got {scores[key]!r}")
        hg, ag = int(m.group(1)), int(m.group(2))
        if r.get("marketCode") == "other":
            r["score"] = f"{hg}-{ag}"
            needs_manual.append(r["id"])
            continue
        r.update(result=settle_pick(r["marketCode"], r["side"], r.get("line"), hg, ag), score=f"{hg}-{ag}", settledAt=now)
        done += 1
    save(a.data, recs)
    unknown = [k for k in list(scores) + list(manual) if k not in used]
    print(f"track: settled {done} picks")
    for k in unknown:
        print(f"track: warning: nothing open matched {k!r}")
    for pid in needs_manual:
        print(f"track: needs manual result: {pid}")


# ------------------------------------------------------------------ statistics
def compute(recs, days=None):
    if days:
        cutoff = (datetime.now(TZ).date() - timedelta(days=days)).isoformat()
        recs = [r for r in recs if r["date"] >= cutoff]
    settled = [r for r in recs if r.get("result") and r["result"] != "void"]

    unique = {}
    for r in settled:
        if r.get("marketCode") in (None, "other"):
            k = (r["matchDate"], r["match"], "other", r.get("bet"))
        else:
            k = (r["matchDate"], r["match"], r["marketCode"], r.get("side"), r.get("line"))
        unique.setdefault(k, r)
    picks = list(unique.values())
    hit = lambda r: 1.0 if r["result"] == "win" else 0.0

    bands = []
    for lo, hi in BANDS:
        grp = [r for r in picks if lo <= r["winPct"] < hi]
        if grp:
            bands.append({"band": f"{lo}–{min(hi, 100)}%", "n": len(grp), "predicted": round(sum(r["winPct"] for r in grp) / len(grp), 1), "won": int(sum(hit(r) for r in grp)), "actual": round(100 * sum(hit(r) for r in grp) / len(grp), 1)})

    full = [r for r in picks if r.get("modelPct") is not None and r.get("marketPct") is not None]
    brier = lambda key, grp: round(sum((r[key] / 100 - hit(r)) ** 2 for r in grp) / len(grp), 4) if grp else None
    best = None
    if full:
        scores = []
        for k in range(21):
            w = k / 20
            b = sum(((w * r["modelPct"] + (1 - w) * r["marketPct"]) / 100 - hit(r)) ** 2 for r in full) / len(full)
            scores.append((b, w))
        b, w = min(scores)
        best = {"modelWeight": w, "brier": round(b, 4)}

    slips = {}
    groups = {}
    for r in recs:
        groups.setdefault((r["date"], run_of(r), r["slip"]), []).append(r)
    for (day, run, sid), legs in groups.items():
        if any(not leg.get("result") for leg in legs):
            continue
        stake = legs[0]["stake"]
        fs = [factor(leg["result"], leg["odds"]) for leg in legs]
        ret = stake * math.prod(fs)
        name = ("Singles" if sid.startswith("S") else f"Slip {sid}") + ("" if run == "daily" else " (your matches)")
        row = slips.setdefault(name, {"settled": 0, "won": 0, "staked": 0.0, "returned": 0.0})
        row["settled"] += 1
        row["won"] += 1 if ret > stake + 1e-9 else 0
        row["staked"] += stake
        row["returned"] += ret
        if legs[0].get("system") and len(legs) >= 3:
            n = len(legs)
            sys_ret = sum((stake / n) * math.prod(f for j, f in enumerate(fs) if j != i) for i in range(n))
            srow = slips.setdefault(f"{name} system", {"settled": 0, "won": 0, "staked": 0.0, "returned": 0.0})
            srow["settled"] += 1
            srow["won"] += 1 if sys_ret > stake + 1e-9 else 0
            srow["staked"] += stake
            srow["returned"] += sys_ret
    for row in slips.values():
        row["staked"], row["returned"] = round(row["staked"], 2), round(row["returned"], 2)
        row["profit"] = round(row["returned"] - row["staked"], 2)

    return {
        "since": min((r["date"] for r in recs), default=None),
        "settledPicks": len(picks),
        "won": int(sum(hit(r) for r in picks)),
        "avgPredicted": round(sum(r["winPct"] for r in picks) / len(picks), 1) if picks else None,
        "hitRate": round(100 * sum(hit(r) for r in picks) / len(picks), 1) if picks else None,
        "bands": bands,
        "brier": {"n": len(full), "final": brier("winPct", full), "model": brier("modelPct", full), "market": brier("marketPct", full)},
        "bestBlend": best,
        "slips": slips,
        "openPicks": sum(1 for r in recs if not r.get("result")),
    }


def slip_sort(name):
    if name.startswith("Slip "):
        return (SLIP_ORDER.get(name[5], 8), "system" in name)
    return (9, False)


def euro(x):
    return f"−€{abs(x):.2f}" if x < 0 else f"€{x:.2f}"


def cmd_report(a):
    s = compute(load(a.data), a.days)
    span = f"last {a.days} days" if a.days else "all time"
    out = [f"### Track record ({span})", ""]
    if not s["settledPicks"]:
        out.append(f"No settled picks yet. {s['openPicks']} picks are waiting for results.")
        print("\n".join(out))
        return
    out.append(f"- **Picks settled:** {s['settledPicks']} different picks. {s['won']} won ({s['hitRate']}%), against an average predicted chance of {s['avgPredicted']}%.")
    if s["settledPicks"] < 100:
        out.append("- **Too early to judge:** fewer than 100 settled picks, so these numbers can still swing a lot.")
    out += ["", "| Predicted win % | Picks | Average predicted | Actually won |", "|---|---|---|---|"]
    out += [f"| {b['band']} | {b['n']} | {b['predicted']}% | {b['won']} ({b['actual']}%) |" for b in s["bands"]]
    br = s["brier"]
    if br["n"]:
        out += ["", f"- **Accuracy** (Brier score, lower is better, {br['n']} picks): final {br['final']} · model alone {br['model']} · bookmakers alone {br['market']}."]
        if s["bestBlend"]:
            w = s["bestBlend"]["modelWeight"]
            out.append(f"- **Best mix so far:** {round(w * 100)}% model and {round((1 - w) * 100)}% bookmakers (Brier {s['bestBlend']['brier']}).")
    if s["slips"]:
        out += ["", "| Slip | Settled | Won | Staked | Returned | Profit |", "|---|---|---|---|---|---|"]
        total = {"settled": 0, "won": 0, "staked": 0.0, "returned": 0.0}
        for name in sorted(s["slips"], key=slip_sort):
            row = s["slips"][name]
            out.append(f"| {name} | {row['settled']} | {row['won']} | {euro(row['staked'])} | {euro(row['returned'])} | {euro(row['profit'])} |")
            if "system" not in name:
                for k in total:
                    total[k] += row[k]
        out.append(f"| **Total** (straight slips and singles) | {total['settled']} | {total['won']} | {euro(total['staked'])} | {euro(total['returned'])} | **{euro(total['returned'] - total['staked'])}** |")
    out += ["", f"{s['openPicks']} picks are waiting for results."]
    print("\n".join(out))


def cmd_stats(a):
    print(json.dumps(compute(load(a.data), a.days), indent=1, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=Path("picks.jsonl"), help="JSON Lines file of picks (default ./picks.jsonl)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("add")
    p.add_argument("slips")
    p = sub.add_parser("open")
    p.add_argument("--all", action="store_true", help="include matches that haven't finished yet")
    p = sub.add_parser("settle")
    p.add_argument("scores")
    for name in ("report", "stats"):
        p = sub.add_parser(name)
        p.add_argument("--days", type=int, default=None)
    a = ap.parse_args()
    {"add": cmd_add, "open": cmd_open, "settle": cmd_settle, "report": cmd_report, "stats": cmd_stats}[a.cmd](a)


if __name__ == "__main__":
    main()
