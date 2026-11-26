# 🦃 Turkey Bowl 2026

A one-day fantasy football league for the three Thanksgiving games: Bears at Lions, Eagles at Cowboys and Chiefs at Bills. Three teams, a salary-cap draft, every player on one team only, winner takes all.

**Play here: https://lukalaker.github.io/Turkey-bowl/**

## How to play

1. **Join.** Open the site on the phone you'll draft with, type your name and a team name, and tap **Take my seat**. No accounts needed; the phone remembers your team.
2. **Draft.** When all three seats are taken, the commissioner taps **Start the draft** and a random order spins onto everyone's screen. It's a snake draft (1-2-3, then 3-2-1) with no timer: as soon as one team picks, the next is up. On your turn, tap **Draft** next to a player and confirm. It shows up on every phone within a second or two, and the next person's phone buzzes.
3. **Watch.** Points update live on the site during the games. The highest total after the night game wins.

### Roster and budget

- **$100** for 9 spots: QB, RB, RB, WR, WR, TE, Flex (RB/WR/TE), K, D/ST.
- Once a player is drafted, nobody else can have him.
- You must always keep enough money to fill your remaining spots with the cheapest players still available. The site shows the most you can spend on each pick.
- Players lock when their game kicks off.
- Bargain bin: if other teams take the cheap players you were saving for and you can't afford anyone, you can take the cheapest player left at an open spot for whatever money you have, so no roster ends up short.
- Prices come from this week's projections: about $0.55 per projected point plus a premium for stars (squared term), $2 minimum; kickers and D/ST are $0.50 per point.

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

The first person to set a PIN on the **How to play** tab becomes the commissioner; that PIN unlocks the commissioner tools on any phone. From there you can:

- **Start the draft** (spins the random order) once all seats are taken
- **Add a team** for someone without a phone; you draft for them
- **Remove a team** before the draft
- **Pick for whoever is on the clock**
- **Undo the last pick**, **Restart the draft** (keeps the teams), or **Clear everything**

### How it works

- `index.html` and `assets/` are the website, hosted on GitHub Pages.
- Picks are live: every action (join, start, pick, undo) is saved as an event in a free Firebase Realtime Database (`data/config.json` holds its address). Every phone streams the events and replays them through the same draft rules in `assets/engine.js` (`assets/live.js`), so everyone sees the same league instantly, and if two phones grab the same player at once, the first to reach the database gets him.
- The commissioner PIN and each phone's team are checked by the site, which keeps family members from picking for each other by accident. It isn't bank-grade security: someone who dug into the database could still mess with it.
- `data/players.json` is the player pool with salaries (built from ESPN rosters and Sleeper projections by `npm run players`).
- `.github/workflows/turkey-bowl.yml` redeploys the site on every push and, during the games, saves ESPN box scores to `data/scores.json` every 5 minutes as a backup; the site normally scores live straight from ESPN.
- `npm test` runs the draft-rule, live-replay and scoring tests.
