# Crypto Sim — Telegram Mini App (MVP)

Crypto market simulator with a shared AMM-driven market, playable as a plain
web app today (Telegram auth comes later).

## Run it

```
npm install
npm run dev:server   # backend on http://localhost:8787
npm run dev:client   # frontend on http://localhost:5173 (in a second terminal)
```

Open http://localhost:5173. No PostgreSQL install needed — the backend uses
`@electric-sql/pglite` (real Postgres compiled to WASM), persisted to
`server/.pgdata`. Delete that folder to reset all player/game state.

## Stubs (search the code for `STUB:`)

- **Telegram auth** — everything runs as one local profile, `@local_player`.
  See `client/src/lib/telegram.ts`.
- **Shop payments** — `/api/shop/purchase` instantly credits USDD instead of
  charging real Telegram Stars. See `processStarPayment()` in
  `server/src/api/routes.ts`.
- **Leaderboard** — filled with 20-40 generated NPC bots whose net worth
  drifts randomly every minute. See `server/src/npc/bots.ts`.

## Debug tools

`SHOW_DEBUG_PHASE` in `client/src/config.ts` shows manual macro-phase
override buttons on the Market screen (Бычий/Распределение/Медвежий/Зима/
Восстановление) for testing each market regime without waiting hours for a
natural transition. Turn it off before shipping.
