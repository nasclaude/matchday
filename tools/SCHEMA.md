# slips.json format

The daily research agent writes the day's slips to a file **outside** this repository
(for example `/tmp/matchday/slips.json`) and the full Markdown report to
`/tmp/matchday/report.md`, then runs from the repository root:

```bash
node tools/publish.mjs --slips /tmp/matchday/slips.json --report /tmp/matchday/report.md
```

`publish.mjs` checks the file, recalculates every total, return and chance from the legs
(any numbers you supply for those are overwritten), encrypts the result for every device key
in `keys/`, and writes `data/latest.json` and `data/archive/<date>.json`. Commit only the
`data/` folder. Never commit `slips.json`, `report.md` or any other plaintext.

Run `node tools/publish.mjs --slips /tmp/matchday/slips.json --dry-run` first to validate
without writing anything.

## Top level

| Field | Type | Required | Notes |
|---|---|---|---|
| `date` | `"YYYY-MM-DD"` | yes | The matchday the slips are for (Europe/Berlin date). |
| `title` | string | no | For example `"Saturday slips"`. |
| `summary` | string | no | One line, for example `"14 matches analysed · odds from BetExplorer"`. |
| `generatedAt` | ISO 8601 time | no | Defaults to now. |
| `slips` | Slip[] | yes | In display order: A, B, C, E, D. |
| `singles` | Pick[] (plus `label`, `stake`) | no | Safest single, best value single. |
| `warnings` | string[] | no | "Before you bet" checks (line-ups, odds moving, single-source news). |
| `avoid` | `{ "match", "reason" }[]` | no | Matches to avoid. |
| `disclaimer` | string | no | Closing reminder. |
| `reportMarkdown` | string | no | Filled in automatically from `--report`. |

## Slip

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | `"A"`, `"B"`, `"C"`, `"E"`, `"D"`. |
| `name` | string | yes | `"Slip A"`, `"Two-match double"`, `"Big odds"`. |
| `subtitle` | string | no | For example `"Target ≈ €30"`. |
| `kind` | string | no | `"double"` for Slip E, `"big"` for Slip D (colours the badge). |
| `stake` | number | yes | Euros: 5, or 10 for Slip D. |
| `legs` | Pick[] | yes | Empty array if the slip wasn't built today, with `reason` set. |
| `reason` | string | when `legs` is empty | Why it wasn't built. |
| `system` | `true` or `{ "note": string }` | no | Slip D only: adds the "(N-1) from N" system numbers. |
| `notes` | string[] | no | Overlap with other slips, caveats. |

## Pick (a leg or a single)

| Field | Type | Required | Notes |
|---|---|---|---|
| `match` | string | yes | `"Man City v Fulham"`. |
| `kickoff` | string | yes | `"13:30"` (CET). |
| `competition` | string | no | `"Premier League"`. |
| `market` | string | no | `"Match result"`, `"Asian handicap"`, `"Over/under"`, ... |
| `bet` | string | yes | The exact selection as it should be placed, for example `"Man City -1 (Asian handicap)"`. |
| `odds` | number | yes | Best decimal price found. |
| `winPct` | number | yes | Your estimated chance of a full win, 0–100. |
| `bookmaker` | string | yes | Where that price is. |
| `note` | string | no | For example `"Stake refunded if City win by exactly 1"`. |

Singles also take `label` (`"Safest single"`, `"Best value single"`) and `stake`.

Calculated by `publish.mjs`: `totalOdds`, `return`, `profit`, `winChance`, `bookieChance`,
`bookiePct` (per pick), the `system` numbers and `history`.

## Example

```json
{
  "date": "2026-11-21",
  "title": "Saturday slips",
  "summary": "14 matches analysed · odds from BetExplorer",
  "slips": [
    {
      "id": "A",
      "name": "Slip A",
      "subtitle": "Target ≈ €30",
      "stake": 5,
      "legs": [
        { "match": "Team A v Team B", "kickoff": "13:30", "competition": "Premier League", "market": "Match result", "bet": "Team A to win", "odds": 1.38, "winPct": 76, "bookmaker": "bet365" },
        { "match": "Team C v Team D", "kickoff": "15:30", "competition": "Bundesliga", "market": "Over/under", "bet": "Over 1.5 goals", "odds": 1.25, "winPct": 83, "bookmaker": "Stake" }
      ],
      "notes": ["Shares leg 1 with Slip D"]
    },
    {
      "id": "E",
      "name": "Two-match double",
      "kind": "double",
      "subtitle": "2 picks at higher odds",
      "stake": 5,
      "legs": [],
      "reason": "No pair at 1.70–2.60 reached 50% today."
    },
    {
      "id": "D",
      "name": "Big odds",
      "kind": "big",
      "subtitle": "Target ≈ €200",
      "stake": 10,
      "system": { "note": "Some bookmakers need a minimum stake per system line." },
      "legs": []
    }
  ],
  "singles": [
    { "label": "Safest single", "match": "Team E v Team F", "kickoff": "18:30", "bet": "Team E to win", "odds": 1.15, "winPct": 85, "bookmaker": "BetMGM", "stake": 5 }
  ],
  "warnings": ["Line-ups are confirmed about an hour before kickoff, so check them before you bet."],
  "avoid": [{ "match": "Team G v Team H", "reason": "Too close to call." }],
  "disclaimer": "These are estimates, not guarantees. Only bet what you can afford to lose."
}
```
