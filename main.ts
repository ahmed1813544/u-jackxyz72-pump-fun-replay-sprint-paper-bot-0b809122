// Ignition sniper for the pump.fun replay sprint (agent-fun/replay/v2).
//
// The bot watches every new bonding curve from its CreateEvent and buys only
// launches that ignite in their first seconds: several distinct wallets buying,
// strong net SOL inflow, a small creator buy, and the creator not selling.
// It exits fast (take profit, stop, trailing stop, time limit, creator sell,
// staleness) and never pyramids: one small buy per coin, so losers stay small
// and the 1%-of-reserve size cap is the binding constraint, not conviction.
// Buys are refused for free when the fill would land >10% worse than the
// decision price, which keeps the bot out of spikes that jump in the latency.
// A tiny probe pacer keeps the guardrails (20 coins / 200 fills) covered if
// ignitions dry up. Deterministic: no clock, no randomness, no I/O.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
