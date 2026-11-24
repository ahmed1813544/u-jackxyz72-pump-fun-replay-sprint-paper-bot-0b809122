// Ignition sniper: buy launches that ignite in their first seconds, exit fast.
//
// Entry (while a coin is at most maxAge slots old):
//   - at least minBuyers distinct non-creator buyers since creation
//   - net SOL inflow since creation at least minNetSol
//   - the creator's own buy at most maxDevBuySol, and the creator has not sold
//   - price at most maxRunup times the create price (never chase a vertical spike)
//   - real SOL reserve at least minRqSol, so the 1% size cap allows a real buy
// Candidates are ranked by net inflow, strongest first, and only as many as
// the free position slots allow.
//
// Size: one buy per coin, min(stakeSol, 97% of the 1% reserve cap). No adds:
// on these thin curves every add chases the price up and the blended stop then
// eats the whole position, so losers stay at their initial small size.
//
// Exits (whole position, checked every batch):
//   - take profit / stop loss on liquidation value vs cost
//   - trailing stop once the position is up trailArm
//   - time limit maxHold slots, staleness (no trade for staleSlots)
//   - the creator sells while we hold
// Buys go out at buySlipBps: a buy whose fill would land more than that worse
// than the decision price is refused for free, which keeps us out of spikes
// that jump inside the 2-slot latency. Sells go out wide open.
//
// Guardrail pacer: if our own fills or coins lag the pace (targetFills /
// targetCoins prorated over paceSecs of block time), open tiny probe round
// trips (buy probeSol, sell as soon as it lands) on liquid curves.
//
// Deterministic by construction: no clock, no randomness, no environment,
// iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Oldest age (slots since CreateEvent) at which a first buy may be decided. */
  maxAge: number;
  /** Distinct non-creator buyers since creation required. */
  minBuyers: number;
  /** Net SOL inflow (buys minus sells) since creation required. */
  minNetSol: number;
  /** Creator's own buys since creation, at most this many SOL. */
  maxDevBuySol: number;
  /** Price now over create price, at most. */
  maxRunup: number;
  /** Real SOL reserve at entry, at least. */
  minRqSol: number;
  /** SOL to put into one position (the 1% reserve cap binds first on young curves). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Take profit on liquidation value vs cost (fraction). */
  takeProfit: number;
  /** Stop loss on liquidation value vs cost (fraction). */
  stopLoss: number;
  /** Trailing stop from the position's best value (fraction). */
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit at once when the creator sells while we hold. */
  exitOnDevSell: boolean;
  /** Most new entries decided in one batch. */
  maxEntriesPerBatch: number;
  /** Guardrail pacing targets (fills / coins over paceSecs of block time). */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  maxAge: 10,
  minBuyers: 8,
  minNetSol: 1.0,
  maxDevBuySol: 2.5,
  maxRunup: 1.6,
  minRqSol: 1.0,
  stakeSol: 0.05,
  minBuySol: 0.01,
  buySlipBps: 1000,
  takeProfit: 1.0,
  stopLoss: 0.25,
  trail: 0.2,
  trailArm: 0.3,
  maxHold: 1500,
  staleSlots: 300,
  exitOnDevSell: true,
  maxEntriesPerBatch: 3,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14_400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Tape {
  created: number;
  creator: string;
  createPrice: number;
  /** Trades since creation; dropped once the coin is decided. */
  trades: { slot: number; buy: boolean; sol: number; user: string }[] | null;
  decided: boolean;
  /** The creator sold at any point (tracked while held). */
  devSold: boolean;
  /** Slot of the last trade seen on this coin. */
  lastTrade: number;
}

interface Held {
  opened: number;
  peakValue: number;
  exiting: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  /** Mints created but not yet decided (small: coins age out within maxAge slots). */
  const undecided = new Set<Pubkey>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeOf = (mint: Pubkey): Tape | undefined => tapes.get(mint);

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      const devSoldNow = new Set<Pubkey>();

      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          tapes.set(e.mint, {
            created: e.slot,
            creator: e.user,
            createPrice: price,
            trades: [],
            decided: false,
            devSold: false,
            lastTrade: e.slot,
          });
          undecided.add(e.mint);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          if (t !== undefined) {
            t.lastTrade = e.slot;
            if (e.user === t.creator) {
              if (!e.is_buy) {
                t.devSold = true;
                devSoldNow.add(e.mint);
              }
            }
            if (t.trades !== null) {
              t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
            }
          }
          traded.add(e.mint);
        }
      }

      // Decide coins that aged out of the entry window and drop their tapes
      // outright (they can never be entered, and nothing else needs them).
      for (const mint of undecided) {
        const t = tapes.get(mint);
        if (t === undefined) {
          undecided.delete(mint);
          continue;
        }
        if (now - t.created > p.maxAge && !held.has(mint)) {
          undecided.delete(mint);
          tapes.delete(mint);
        }
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      const liquidationValue = (mint: Pubkey, tokens: bigint): number => {
        const mk = marks.get(mint);
        const curve = state.curves.get(mint);
        if (mk === undefined && curve === undefined) return 0;
        const vq = Number(mk ? mk.virtual_quote_reserves : curve!.virtual_quote_reserves);
        const vt = Number(mk ? mk.virtual_token_reserves : curve!.virtual_token_reserves);
        const n = Number(tokens);
        return ((n * vq) / (vt + n) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // 1. Exits on held positions.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            tapes.delete(mint);
          }
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        const t = tapeOf(mint);
        const value = liquidationValue(mint, pos.token_amount);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        let exit = h.exiting;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && t !== undefined && now - t.lastTrade > p.staleSlots) exit = true;
        if (!exit && p.exitOnDevSell && devSoldNow.has(mint)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // 2. Probe sells: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // 3. Entries: rank undecided young coins that traded this batch by net inflow.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      // Orders already queued this reply (the adds above) are not in state.pending yet.
      for (const o of orders) {
        free -= tx;
        if (o.side === 'buy') free -= Number(o.quote_lamports) / LAMPORTS;
      }
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      const candidates: { mint: Pubkey; net: number; price: number; rq: number }[] = [];
      for (const mint of traded) {
        const t = tapeOf(mint);
        if (t === undefined || t.decided || t.trades === null) continue;
        if (now - t.created > p.maxAge) continue;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const rq = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rq < p.minRqSol) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        if (price > p.maxRunup * t.createPrice) continue;
        let net = 0;
        let devBuy = 0;
        let devSold = false;
        const buyers = new Set<string>();
        let buys = 0;
        for (const tr of t.trades) {
          if (tr.buy) {
            net += tr.sol;
            buys++;
            if (tr.user === t.creator) devBuy += tr.sol;
            else buyers.add(tr.user);
          } else {
            net -= tr.sol;
            if (tr.user === t.creator) devSold = true;
          }
        }
        if (buyers.size < p.minBuyers) continue;
        if (net < p.minNetSol) continue;
        if (devBuy > p.maxDevBuySol || devSold) continue;
        candidates.push({ mint, net, price, rq });
      }
      candidates.sort((a, b) => b.net - a.net || (a.mint < b.mint ? -1 : 1));
      let entries = 0;
      for (const c of candidates) {
        if (orders.length >= cap || entries >= p.maxEntriesPerBatch || slotsLeft <= 0) break;
        const capSol = Math.floor(Number(state.maxBuyLamports(c.mint)) * 0.97) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({
          side: 'buy',
          mint: c.mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: p.buySlipBps,
        });
        const t = tapeOf(c.mint)!;
        t.decided = true;
        t.trades = null;
        undecided.delete(c.mint);
        held.set(c.mint, { opened: now, peakValue: 0, exiting: false });
        free -= amount + tx;
        slotsLeft--;
        entries++;
      }

      // 4. Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)),
              max_slippage_bps: p.buySlipBps,
            });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
