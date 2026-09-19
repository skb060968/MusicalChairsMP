# Musical Chairs

Real-time party elimination for 2–8 players. When the music stops, drag your avatar
onto a free chair (or tap the chair). Left standing? You're out. Last one seated wins.

**Peer-run.** There is no host authority once the game starts. Every phase change is a
function of the shared `game` node and the server clock, so any connected player may
write it once the deadline has passed; every chair claim is written by the player who
grabbed it. The Firebase rules re-check each write. A sleeping, backgrounded or absent
host changes nothing — they are just a player who does not grab a chair.

Built on the shared platform scaffold (`GameScaffolding/GAME-SCAFFOLD-CHECKLIST.md`).

## Round flow

```
music (10 | 20 | 30 s, random) ─▶ claiming (10 s, or until every chair is taken /
everyone still standing is offline) ─▶ reveal (3.5 s) ─▶ next round … ─▶ finished
```

- Chairs = players still in − 1. The final single chair sits in the centre.
- Nobody claimed at all (a whole table asleep)? Nobody is eliminated; the round replays.
- A player who is offline simply never claims and is out at the deadline.

## Files

| File | Role |
|---|---|
| `src/engine.js` | Pure rules of the game: state shape, reducers (`stopMusic`, `reveal`, `nextRound`), `dueTransition`, standings |
| `src/firebase-sync.js` | Room lifecycle, presence, `advanceGame` (transaction), `claimChair`, server clock |
| `src/main.js` | Screens, lobby, the deadline loop (`scheduleTransition` / `fireTransition`), results |
| `src/ui.js` | Sound + music, the stage (ring, chairs, avatars, drag/tap), roster |

Firebase project `skb-games`, room block `chairs-rooms`. Shared `.env` and
`firebase-rules.json` live one level up; `vite.config.js` points `envDir` there.

Local-only tooling (gitignored, not deployed): `rules-generator.mjs` regenerates the
`chairs-rooms` block into `../firebase-rules.json`; `scripts/rules-mirror.mjs` checks the
engine's outputs against a JS re-implementation of the rules; `scripts/live-probe.mjs`
drives two anonymous clients against the published rules (`node scripts/live-probe.mjs`).

## Develop

```
npm install
npm run dev        # vite --host
npm run build      # dist/ — check dist/sw.js CACHE_NAME matches public/sw.js
```

Bump `CACHE_NAME` in `public/sw.js` on every deploy. Set the production URL in the
`og:` / `twitter:` tags of `index.html` once the Vercel domain exists.

## Deploy

Separate Vercel project (framework Vite, output `dist`) with `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET` and the eight `VITE_FIREBASE_*` / `VITE_LIVEKIT_URL` variables.
Publish `skb-games/firebase-rules.json` after adding or changing the `chairs-rooms` block.
