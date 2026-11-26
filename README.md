# 🦃 Turkey Bowl 2026

A one-day fantasy football league for the three Thanksgiving games: Bears at Lions, Eagles at Cowboys and Chiefs at Bills. Three teams, a salary-cap draft, every player on one team only, winner takes all.

**Play here: https://lukalaker.github.io/Turkey-bowl/**

## How to play

1. **Join.** Open the site, type a team name and tap **Join on GitHub**. GitHub opens with your team filled in; tap **Submit new issue**. You need a free [GitHub account](https://github.com/signup). Family without one can ask the commissioner to add them.
2. **Draft.** When all three seats are taken, the draft order is drawn at random and a snake draft starts (1-2-3, then 3-2-1). On your turn, tap **Draft** next to a player, then **Submit** on GitHub. The league bot checks the pick, replies on your issue and updates the site, usually within a minute. GitHub also emails you when you're on the clock.
3. **Watch.** Points update live on the site during the games. The highest total after the night game wins.

### Roster and budget

- **$100** for 9 spots: QB, RB, RB, WR, WR, TE, Flex (RB/WR/TE), K, D/ST.
- Once a player is drafted, nobody else can have him.
- You must always keep enough money to fill your remaining spots with the cheapest players still available. The site shows the most you can spend on each pick.
- Players lock when their game kicks off. A team that can't afford anyone for its open spots has its turn skipped.

### Scoring (full PPR)

| | |
|---|---|
| Passing | 1 pt per 25 yds, 4 per TD, -2 per INT |
| Rushing / receiving | 1 pt per 10 yds, 6 per TD, 1 per reception |
| Fumble lost | -2 |
| Kick or punt return TD | 6 |
| Kicker | 3 per FG, 1 per XP |
| D/ST | 1 per sack, 2 per INT or fumble recovery, 6 per TD, plus points allowed: 0 → 10, 1-6 → 7, 7-13 → 4, 14-20 → 1, 21-27 → 0, 28-34 → -1, 35+ → -4 |

Stats come from ESPN. Two-point conversions aren't counted.

## Commissioner guide

The repo owner is the commissioner. Run the league by opening an issue with one of these titles:

| Issue title | What it does |
|---|---|
| `ADD: Grandma's Gravy Boat` | Adds a team the commissioner drafts for (for family without GitHub) |
| `ADD: Team name @username` | Saves a seat for a specific GitHub user |
| `KICK: Team name` | Removes a team before the draft starts |
| `PICK: Player name` | Picks for whichever team is on the clock |
| `UNDO` | Takes back the last pick |
| `RESET` | Clears all picks and draws a new draft order |
| `RESET ALL` | Removes every team and pick (use after testing) |

Anyone can open a `JOIN:` issue while seats are open. If a stranger grabs a seat, `KICK` them.

### How it works

- `index.html` and `assets/` are the website, hosted on GitHub Pages.
- `data/players.json` is the player pool with salaries (built from ESPN rosters and Sleeper projections by `npm run players`).
- `data/league.json` holds teams and picks. Only the league bot changes it.
- `.github/workflows/turkey-bowl.yml` runs `scripts/run.mjs` whenever an issue is opened. It applies the command with the rules in `assets/engine.js`, commits, redeploys the site and replies on the issue. During the games it also saves box scores to `data/scores.json` every 5 minutes as a backup; the site normally scores live straight from ESPN.
- `npm test` runs the draft-rule and scoring tests.
