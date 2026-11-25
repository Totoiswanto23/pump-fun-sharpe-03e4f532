// pump-fun-sharpe-03e4f532 — entry point for the Pump.fun Sharpe Sprint.
//
// One strategy program, run on Node 22 by the agent-fun/replay/v2 harness.
// The bot itself lives in strategy.ts (a SharpeSniper built from the tuned
// DEFAULT_PARAMS); the wire protocol and the harness handshake live in the
// SDK shim under vendor/, copied from the kit unchanged.
//
// What this bot is trying to do, in one line: buy a fresh pump.fun launch
// once, only when it looks un-rugged, and get out within a few slots —
// because this bounty ranks hourly Sharpe over a 6-hour window, not raw
// PnL, so a flat equity curve with small steady wins beats one moonshot.
// Dev window (24h local sim): net about -0.07 SOL, hourly Sharpe about
// -0.15, max drawdown ~1.5%, ~120 round trips / ~20 wins, guardrail met.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

// Build the sniper with its tuned defaults and hand it to the harness loop.
// runBot drives the whole session: hello, batches of chain events, and the
// final done message — the strategy only answers each batch with orders.
const bot = createStrategy(DEFAULT_PARAMS);

await runBot(bot);
