#!/usr/bin/env python3
"""Matchday goals model: Poisson scorelines with a Dixon-Coles low-score correction.

Turns each side's expected goals into probabilities for every common market, so every
pick's win % is calculated the same way.

Usage
  python3 model.py --matches matches.json      # many matches -> JSON on stdout
  python3 model.py 1.65 0.95                    # one match from expected goals (home, away)
  python3 model.py --fair 1.38 5.25 6.50        # odds of ONE market's outcomes -> fair %, margin removed

matches.json maps a match name to either
  {"lambdas": [home_goals, away_goals]}          # expected goals you already estimated
or
  {"league": {"home": 1.55, "away": 1.25},       # league average goals per game scored by home / away sides
   "home": {"for": 1.9, "against": 1.0, "n": 7}, # home side: xG for / against per game AT HOME, n = games
   "away": {"for": 1.2, "against": 1.5, "n": 7}} # away side: xG for / against per game AWAY
with optional keys:
  "adjHome" / "adjAway": multipliers for team news (0.9 = attack 10% weaker), applied last
  "rho": Dixon-Coles correction (default -0.1; 0 = plain Poisson)

Asian handicap lines are given from each side's own point of view ("home" -1 = home team
-1, "away" +0.5 = away team +0.5). Each line returns the chances of a full win, half win,
push (stake back), half loss and full loss, plus the fair decimal odds (break-even price).
All probabilities are percentages.
"""
import argparse
import json
import math
import sys

RHO = -0.1
MAXG = 10
SHRINK_GAMES = 4  # league-average "games" blended into each side's rates
TOTAL_LINES = (0.5, 1.5, 2.5, 3.5, 4.5)
TEAM_LINES = (0.5, 1.5, 2.5)
AH_LINES = (2.0, 1.5, 1.25, 1.0, 0.75, 0.5, 0.25, 0.0, -0.25, -0.5, -0.75, -1.0, -1.25, -1.5, -1.75, -2.0, -2.5)


def poisson(k, lam):
    return math.exp(-lam) * lam ** k / math.factorial(k)


def score_matrix(lh, la, rho=RHO):
    m = [[poisson(i, lh) * poisson(j, la) for j in range(MAXG + 1)] for i in range(MAXG + 1)]
    tau = {(0, 0): 1 - lh * la * rho, (0, 1): 1 + lh * rho, (1, 0): 1 + la * rho, (1, 1): 1 - rho}
    for (i, j), t in tau.items():
        m[i][j] *= max(t, 0.0)
    total = sum(map(sum, m))
    return [[x / total for x in row] for row in m]


def shrink(rate, n, prior):
    n = max(0.0, float(n or 0))
    return (float(rate) * n + prior * SHRINK_GAMES) / (n + SHRINK_GAMES)


def lambdas_from_stats(league, home, away):
    lh_avg, la_avg = float(league["home"]), float(league["away"])
    att_h = shrink(home["for"], home.get("n"), lh_avg) / lh_avg
    def_h = shrink(home["against"], home.get("n"), la_avg) / la_avg  # conceded at home = scored by away sides
    att_a = shrink(away["for"], away.get("n"), la_avg) / la_avg
    def_a = shrink(away["against"], away.get("n"), lh_avg) / lh_avg  # conceded away = scored by home sides
    return lh_avg * att_h * def_a, la_avg * att_a * def_h


def _result(margin, line_quarters):
    s = margin * 4 + line_quarters
    return "W" if s > 0 else ("P" if s == 0 else "L")


_COMBINE = {
    ("W", "W"): "win",
    ("P", "W"): "halfWin",
    ("W", "P"): "halfWin",
    ("P", "P"): "push",
    ("L", "P"): "halfLoss",
    ("P", "L"): "halfLoss",
    ("L", "L"): "loss",
}


def asian(m, line, side):
    q = round(line * 4)
    res = {"win": 0.0, "halfWin": 0.0, "push": 0.0, "halfLoss": 0.0, "loss": 0.0}
    for i in range(MAXG + 1):
        for j in range(MAXG + 1):
            d = i - j if side == "home" else j - i
            if q % 2 == 0:  # whole or half line: one bet
                key = {"W": "win", "P": "push", "L": "loss"}[_result(d, q)]
            else:  # quarter line: half the stake on each neighbouring line
                key = _COMBINE[(_result(d, q - 1), _result(d, q + 1))]
            res[key] += m[i][j]
    gain = res["win"] + res["halfWin"] / 2
    lose = res["loss"] + res["halfLoss"] / 2
    out = {k: pct(v) for k, v in res.items()}
    out["fairOdds"] = round(1 + lose / gain, 3) if gain > 0 else None
    return out


def pct(p):
    return round(100 * p, 1)


def fair_odds(p):
    return round(1 / p, 3) if p > 0 else None


def markets(m):
    rng = range(MAXG + 1)

    def prob(f):
        return sum(m[i][j] for i in rng for j in rng if f(i, j))

    home, draw, away = prob(lambda i, j: i > j), prob(lambda i, j: i == j), prob(lambda i, j: i < j)
    scores = sorted(((m[i][j], f"{i}-{j}") for i in rng for j in rng), reverse=True)[:6]
    return {
        "1X2": {"home": pct(home), "draw": pct(draw), "away": pct(away)},
        "fairOdds1X2": {"home": fair_odds(home), "draw": fair_odds(draw), "away": fair_odds(away)},
        "doubleChance": {"1X": pct(home + draw), "X2": pct(draw + away), "12": pct(home + away)},
        "drawNoBet": {
            "home": {"win": pct(home), "push": pct(draw), "fairOdds": fair_odds(home / (home + away))},
            "away": {"win": pct(away), "push": pct(draw), "fairOdds": fair_odds(away / (home + away))},
        },
        "totals": {f"{x}": {"over": pct(prob(lambda i, j, x=x: i + j > x)), "under": pct(prob(lambda i, j, x=x: i + j < x))} for x in TOTAL_LINES},
        "btts": {"yes": pct(prob(lambda i, j: i > 0 and j > 0)), "no": pct(prob(lambda i, j: i == 0 or j == 0))},
        "homeGoals": {f"over {x}": pct(prob(lambda i, j, x=x: i > x)) for x in TEAM_LINES},
        "awayGoals": {f"over {x}": pct(prob(lambda i, j, x=x: j > x)) for x in TEAM_LINES},
        "winToNil": {"home": pct(prob(lambda i, j: i > 0 and j == 0)), "away": pct(prob(lambda i, j: j > 0 and i == 0))},
        "asianHandicap": {
            "home": {f"{x:+g}" if x else "0": asian(m, x, "home") for x in AH_LINES},
            "away": {f"{x:+g}" if x else "0": asian(m, x, "away") for x in AH_LINES},
        },
        "likelyScores": {s: pct(p) for p, s in scores},
    }


def run_match(spec):
    if "lambdas" in spec:
        lh, la = (float(x) for x in spec["lambdas"])
    else:
        lh, la = lambdas_from_stats(spec["league"], spec["home"], spec["away"])
    lh *= float(spec.get("adjHome", 1.0))
    la *= float(spec.get("adjAway", 1.0))
    if not (0.05 <= lh <= 6 and 0.05 <= la <= 6):
        raise ValueError(f"expected goals out of range: {lh:.2f} / {la:.2f}")
    m = score_matrix(lh, la, float(spec.get("rho", RHO)))
    return {"expectedGoals": {"home": round(lh, 3), "away": round(la, 3)}, **markets(m)}


def fair_market(odds):
    inv = [1 / float(o) for o in odds]
    total = sum(inv)
    return {"fair": [pct(x / total) for x in inv], "margin": pct(total - 1)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("lambdas", nargs="*", type=float, help="home and away expected goals")
    ap.add_argument("--matches", help="JSON file of matches")
    ap.add_argument("--fair", nargs="+", type=float, help="decimal odds of every outcome of one market")
    a = ap.parse_args()
    if a.fair:
        out = fair_market(a.fair)
    elif a.matches:
        with open(a.matches, encoding="utf-8") as f:
            specs = json.load(f)
        out = {}
        for name, spec in specs.items():
            try:
                out[name] = run_match(spec)
            except (KeyError, TypeError, ValueError) as e:
                out[name] = {"error": str(e)}
    elif len(a.lambdas) == 2:
        out = run_match({"lambdas": a.lambdas})
    else:
        ap.print_help()
        return 2
    json.dump(out, sys.stdout, indent=1, ensure_ascii=False)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
