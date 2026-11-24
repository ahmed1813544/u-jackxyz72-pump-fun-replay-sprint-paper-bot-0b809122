# Pump.fun Replay Sprint — Paper Bot

An ignition-sniper paper-trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on make.fun. It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity.

[![Bounty](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/ahmed1813544/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/ahmed1813544/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

## Strategy

The bot watches every new bonding curve from its `CreateEvent` and buys only
launches that ignite in their first seconds: at least 8 distinct wallets
buying, at least 1 SOL of net inflow, a small creator buy, the creator not
selling, and the price no more than 1.6x the create price. One small buy per
coin (bounded by the 1%-of-reserve size cap) — no pyramiding, so losers stay
small. It exits fast on take profit, a 25% stop, a trailing stop once up 30%,
a time limit, staleness, or a creator sell. Buys go out at 1000 bps slippage,
so a buy whose fill would land more than 10% worse than the decision price is
refused for free. A tiny probe pacer keeps the guardrails covered if
ignitions dry up.

Dev-window grade (kit's `grade-local`, process driver): **+0.0326 SOL net
PnL** over 152 round trips on 78 coins, max drawdown 0.013, guardrails met.

## Files

- `main.ts` — entrypoint (Node 22 runs it directly: `node main.ts`)
- `strategy.ts` — the ignition-sniper strategy
- `vendor/makefun-bot.ts` — the kit-shipped protocol shim, copied as-is

## License

MIT — see [LICENSE](LICENSE).
