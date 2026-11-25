// Hourly-Sharpe launch sniper for the pump.fun Sharpe Sprint.
//
// What the scoreboard rewards here is not the biggest PnL but the cleanest
// equity curve: ranking is hourly Sharpe over a fresh 6-hour window, and a
// prize needs net PnL above zero after every fee. So the bot is tuned to
// bleed as little as possible while keeping a few runners alive:
//
//   * Snipe only the first slots of a launch, and only when the launch looks
//     un-rugged: real SOL inside a sane band, the creator's own opening buy
//     small, at most two distinct outside buyers so far, no creator sale, no
//     single big dump, and the price not already run away.
//   * One small ticket per coin (0.1 SOL), a hard cap on total exposure, and
//     exits within a handful of slots (take-profit, stop-loss, time box, or
//     the creator selling). A flat line with small steady wins beats a wild
//     line with one moonshot.
//   * Guardrail insurance: the 6-hour final window needs 20 distinct coins
//     at >= 0.01 SOL each, and the sniper alone finds only ~15 in 6h on dev
//     data, so tiny probe round-trips top the count up when the pace lags.
//     Probes are insurance, never the strategy.
//   * Fully deterministic: no clock, no randomness, only insertion-ordered
//     maps walked in stream order.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

/** Every knob the sniper exposes. Values below are the tuned defaults. */
export interface Params {
  // Entry window (slots since the CreateEvent).
  minAge: number;
  maxAge: number;
  // Ticket size and the smallest buy worth a tx fee.
  stakeSol: number;
  minBuySol: number;
  // Real-SOL reserve band a launch must sit in at decision time.
  minRealSol: number;
  maxRealSol: number;
  // Rug filter: creator's own buy in the create slot, at most (SOL).
  maxDevBuySol: number;
  // Distinct non-creator buyers seen before entry: allowed band.
  minBuyers: number;
  maxBuyers: number;
  // Sells by others over buys, at most (fraction); biggest single
  // non-creator sell as a share of the reserve before it, at most.
  maxSellRatio: number;
  maxBigSellShare: number;
  // Price now over the create price, as a fraction: allowed band.
  minRunup: number;
  maxRunup: number;
  // Recent-flow window (slots) and what it must show.
  flowWindow: number;
  minFlowSol: number;
  minRecentBuyers: number;
  // Skip a coin outright once its creator has sold.
  skipDevSold: boolean;
  // Slippage tolerated on buys (bps).
  buySlipBps: number;
  // Optional first take-profit: sell tp1Part of the position once it is
  // worth (1 + tp1) of its cost; 0 disables it. After it, the remainder
  // stops out at cost * (1 + slAfterTp1).
  tp1: number;
  tp1Part: number;
  slAfterTp1: number;
  // Full exit when the position is worth (1 + tp) / (1 - sl) of its cost.
  tp: number;
  sl: number;
  // Trailing stop: once up at least trailArm, exit on a trail-sized fall
  // from the best value seen. 0 disables it.
  trailArm: number;
  trail: number;
  // Hard time box (slots) and exit-when-the-creator-sells switch.
  maxHold: number;
  exitOnDevSell: boolean;
  // Exit when no trade has touched the coin for this many slots.
  staleSlots: number;
  // Guardrail pacing, tuned for the 6-hour final window.
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  // Risk caps: most SOL at cost across all positions at once, and SOL
  // kept back as a cash reserve (plus one tx fee per order).
  maxExposureSol: number;
  cashReserveSol: number;
}

// Tuned by hourly-Sharpe sweeps over the dev window (see test/sweep*.ts)
// plus 6-hour slice robustness: 0.1 SOL tickets dilute the per-order tx
// fee and let a caught runner move the curve; maxAge 8 widens the entry
// window a little; tp/sl/maxHold sit in the sweep's flattest region (most
// trips exit on the 5-slot hold near breakeven, so tp/sl barely bind — the
// edge is fee dilution plus runner optionality). Slice medians on dev:
// hourly Sharpe -0.21, worst slice -0.31, net -0.014..-0.056 SOL per 6h
// slice. Every strategy family loses a little on this dev window (all three
// house pilots lose more); the final window is a fresh 6h draw, and this bot
// is built to bleed least while keeping the upside that makes a slice go
// positive.
export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 8,
  stakeSol: 0.1,
  minBuySol: 0.005,
  minRealSol: 0.3,
  maxRealSol: 30,
  maxDevBuySol: 0.5,
  minBuyers: 0,
  maxBuyers: 2,
  maxSellRatio: 1,
  maxBigSellShare: 1,
  minRunup: 0,
  maxRunup: 100,
  flowWindow: 10,
  minFlowSol: -1e12,
  minRecentBuyers: 0,
  skipDevSold: true,
  buySlipBps: 10_000,
  tp1: 0,
  tp1Part: 0.5,
  slAfterTp1: 0,
  tp: 0.1,
  sl: 0.08,
  trailArm: 0,
  trail: 0.1,
  maxHold: 5,
  exitOnDevSell: true,
  staleSlots: 1_000_000,
  targetCoins: 25,
  targetFills: 50,
  paceSecs: 21_600,
  probeSol: 0.02,
  maxProbes: 2,
  maxExposureSol: 1,
  cashReserveSol: 0.05,
};

const LAMPORTS_PER_SOL = 1e9;
/** Bonding-curve fee on a trade: 1.25% (95 bps protocol + 30 bps creator). */
const TRADE_FEE = 0.0125;

interface TradeTick {
  slot: number;
  isBuy: boolean;
  sol: number;
  trader: string;
}

/** Everything remembered about one launch. */
interface Launch {
  mint: Pubkey;
  bornSlot: number;
  creator: Pubkey;
  quote0: number;
  tokens0: number;
  creatorBuy: number;
  tradeCount: number;
  buyers: Set<Pubkey>;
  boughtSol: number;
  soldByOthers: number;
  worstSellShare: number;
  creatorSold: boolean;
  lastSeenSlot: number;
  ticks: TradeTick[];
  entered: boolean;
  finished: boolean;
  completed: boolean;
}

/** An open sniper position and what it has cost so far. */
interface OpenTrade {
  openedSlot: number;
  feesPaid: number;
  peakValue: number;
  creatorSoldAtOpen: boolean;
  bankedPart: boolean;
}

function blankLaunch(mint: Pubkey): Launch {
  return {
    mint,
    bornSlot: -1,
    creator: '',
    quote0: 0,
    tokens0: 1,
    creatorBuy: 0,
    tradeCount: 0,
    buyers: new Set(),
    boughtSol: 0,
    soldByOthers: 0,
    worstSellShare: 0,
    creatorSold: false,
    lastSeenSlot: -1,
    ticks: [],
    entered: false,
    finished: false,
    completed: false,
  };
}

/** What selling `tokens` against (quote, supply) pays after curve fees, in SOL. */
function proceeds(tokens: number, quote: number, supply: number): number {
  if (tokens <= 0 || supply <= 0) return 0;
  const quoteOut = (tokens * quote) / (supply + tokens);
  return (quoteOut / LAMPORTS_PER_SOL) * (1 - TRADE_FEE);
}

class SharpeSniper implements Bot {
  private launches = new Map<Pubkey, Launch>();
  private trades = new Map<Pubkey, OpenTrade>();
  private exiting = new Set<Pubkey>();
  private probeMints = new Map<Pubkey, boolean>();
  private fillsSeen = 0;
  private coinsTraded = new Set<Pubkey>();
  private windowStart: number | null = null;
  private windowEnd: number | null = null;

  constructor(private readonly cfg: Params) {}

  private launch(mint: Pubkey): Launch {
    let found = this.launches.get(mint);
    if (found === undefined) {
      found = blankLaunch(mint);
      this.launches.set(mint, found);
    }
    return found;
  }

  /** Net SOL bought minus sold, plus distinct buyers, over the last flowWindow slots. */
  private recentFlow(coin: Launch, now: number): { netSol: number; buyerCount: number } {
    const cutoff = now - this.cfg.flowWindow;
    let stale = 0;
    while (stale < coin.ticks.length && coin.ticks[stale]!.slot <= cutoff) stale++;
    if (stale > 0) coin.ticks.splice(0, stale);
    let net = 0;
    const who = new Set<Pubkey>();
    for (const tick of coin.ticks) {
      if (tick.isBuy) {
        net += tick.sol;
        who.add(tick.trader);
      } else {
        net -= tick.sol;
      }
    }
    return { netSol: net, buyerCount: who.size };
  }

  /** Fold one batch of chain events into the launch book. */
  private ingest(batch: Batch): void {
    for (const ev of batch.events) {
      if (ev.block_time !== null) {
        if (this.windowStart === null) this.windowStart = ev.block_time;
        if (this.windowEnd === null || ev.block_time > this.windowEnd) this.windowEnd = ev.block_time;
      }
      if (ev.event === 'CreateEvent') {
        const coin = this.launch(ev.mint);
        coin.bornSlot = ev.slot;
        coin.creator = ev.creator;
        coin.quote0 = Number(ev.virtual_quote_reserves);
        coin.tokens0 = Number(ev.virtual_token_reserves);
        coin.lastSeenSlot = ev.slot;
      } else if (ev.event === 'TradeEvent') {
        const coin = this.launches.get(ev.mint);
        if (coin === undefined) continue;
        const sol = Number(ev.sol_amount) / LAMPORTS_PER_SOL;
        coin.tradeCount++;
        coin.lastSeenSlot = ev.slot;
        coin.ticks.push({ slot: ev.slot, isBuy: ev.is_buy, sol, trader: ev.user });
        const fromCreator = ev.user === coin.creator;
        if (ev.is_buy) {
          coin.boughtSol += sol;
          if (fromCreator && ev.slot === coin.bornSlot) coin.creatorBuy += sol;
          else if (!fromCreator) coin.buyers.add(ev.user);
        } else if (fromCreator) {
          coin.creatorSold = true;
        } else {
          coin.soldByOthers += sol;
          const reserveBefore = Number(ev.real_quote_reserves) / LAMPORTS_PER_SOL + sol;
          if (reserveBefore > 0) {
            const share = sol / reserveBefore;
            if (share > coin.worstSellShare) coin.worstSellShare = share;
          }
        }
      } else {
        const coin = this.launches.get(ev.mint);
        if (coin !== undefined) {
          coin.completed = true;
          coin.finished = true;
        }
      }
    }
  }

  /** Reconcile fills and pending orders with the books. Returns pending counts per mint. */
  private syncFills(state: BotState, batch: Batch): Map<Pubkey, number> {
    for (const fill of batch.fills) {
      if (fill.status === 'filled' && !fill.client_id.startsWith('_')) {
        this.fillsSeen++;
        this.coinsTraded.add(fill.mint);
      }
      if (fill.client_id.startsWith('_')) {
        this.trades.delete(fill.mint);
        this.exiting.delete(fill.mint);
        continue;
      }
      const trade = this.trades.get(fill.mint);
      if (fill.status !== 'rejected' && trade !== undefined) {
        trade.feesPaid += Number(fill.tx_fee_lamports) / LAMPORTS_PER_SOL;
      }
      if (fill.side === 'buy' && fill.status === 'filled' && trade === undefined) {
        this.trades.set(fill.mint, {
          openedSlot: fill.slot,
          feesPaid: Number(fill.tx_fee_lamports) / LAMPORTS_PER_SOL,
          peakValue: 0,
          creatorSoldAtOpen: this.launches.get(fill.mint)?.creatorSold ?? false,
          bankedPart: false,
        });
      }
    }
    for (const mint of [...this.exiting]) {
      let stillOut = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'sell') stillOut = true;
      }
      if (!stillOut) this.exiting.delete(mint);
    }
    for (const mint of [...this.trades.keys()]) {
      if (state.positions.has(mint) || this.exiting.has(mint)) continue;
      let buyOut = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'buy') buyOut = true;
      }
      if (!buyOut) this.trades.delete(mint);
    }
    const pending = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pending.set(po.order.mint, (pending.get(po.order.mint) ?? 0) + 1);
    }
    return pending;
  }

  /** Plan exits for every open sniper position. Probes are closed elsewhere. */
  private planExits(state: BotState, batch: Batch, orders: OrderInput[], feeSol: number): void {
    const cap = state.hello.caps.max_orders_per_batch;
    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      if (this.exiting.has(mint) || this.probeMints.has(mint)) continue;
      const coin = this.launches.get(mint);
      let trade = this.trades.get(mint);
      if (trade === undefined) {
        trade = {
          openedSlot: batch.slot,
          feesPaid: feeSol,
          peakValue: 0,
          creatorSoldAtOpen: coin?.creatorSold ?? false,
          bankedPart: false,
        };
        this.trades.set(mint, trade);
      }
      const mark = marks.get(mint);
      const curve = state.curves.get(mint);
      const quote = mark ? Number(mark.virtual_quote_reserves) : curve ? Number(curve.virtual_quote_reserves) : 0;
      const supply = mark ? Number(mark.virtual_token_reserves) : curve ? Number(curve.virtual_token_reserves) : 1;
      const tokens = Number(pos.token_amount);
      const value = proceeds(tokens, quote, supply) - feeSol;
      const cost = Number(pos.cost_lamports) / LAMPORTS_PER_SOL + trade.feesPaid;
      if (value > trade.peakValue) trade.peakValue = value;
      let leave = false;
      if (cost > 0) {
        const p = this.cfg;
        if (p.tp1 > 0 && !trade.bankedPart && value >= cost * (1 + p.tp1)) {
          const part = Math.floor(tokens * p.tp1Part);
          if (part > 0 && part < tokens) {
            orders.push({ side: 'sell', mint, token_amount: BigInt(part), max_slippage_bps: 10_000 });
            this.exiting.add(mint);
            trade.bankedPart = true;
            trade.peakValue = 0;
            if (coin !== undefined) coin.finished = true;
            continue;
          }
        }
        if (value >= cost * (1 + p.tp)) leave = true;
        const stop = trade.bankedPart ? -p.slAfterTp1 : p.sl;
        if (value <= cost * (1 - stop)) leave = true;
        if (p.trailArm > 0 && trade.peakValue >= cost * (1 + p.trailArm) && value <= trade.peakValue * (1 - p.trail)) {
          leave = true;
        }
      }
      if (batch.slot - trade.openedSlot >= this.cfg.maxHold) leave = true;
      if (coin !== undefined) {
        if (this.cfg.exitOnDevSell && coin.creatorSold && !trade.creatorSoldAtOpen) leave = true;
        if (batch.slot - coin.lastSeenSlot >= this.cfg.staleSlots) leave = true;
      }
      if (!leave) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      this.exiting.add(mint);
      if (coin !== undefined) coin.finished = true;
    }
  }

  /** Close probe positions the moment their buy has landed. */
  private closeProbes(state: BotState, orders: OrderInput[], pending: Map<Pubkey, number>): void {
    const cap = state.hello.caps.max_orders_per_batch;
    for (const [mint, alreadySelling] of this.probeMints) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pending.has(mint)) this.probeMints.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pending.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      if (!alreadySelling) this.probeMints.set(mint, true);
    }
  }

  /** One buy per fresh launch, only when every rug-filter rule passes.
   *  Returns how many buys were placed, so the caller can track open slots. */
  private planEntries(state: BotState, batch: Batch, orders: OrderInput[], freeSol: number, exposureSol: number, openCount: number): number {
    const cap = state.hello.caps.max_orders_per_batch;
    const p = this.cfg;
    const feeSol = Number(state.txFeeLamports()) / LAMPORTS_PER_SOL;
    let free = freeSol;
    let exposure = exposureSol;
    let open = openCount;
    let placed = 0;
    for (const coin of this.launches.values()) {
      if (orders.length >= cap) break;
      if (coin.finished || coin.completed || coin.entered) continue;
      const age = batch.slot - coin.bornSlot;
      const curve = state.curves.get(coin.mint);
      if (curve === undefined || curve.complete) continue;
      if (age > p.maxAge) {
        coin.finished = true;
        continue;
      }
      if (age < p.minAge) continue;
      if (open >= state.hello.caps.max_open_positions) continue;
      if (coin.creatorSold && p.skipDevSold) {
        coin.finished = true;
        continue;
      }
      const reserve = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
      if (reserve < p.minRealSol || reserve > p.maxRealSol) continue;
      if (coin.creatorBuy > p.maxDevBuySol) continue;
      if (coin.buyers.size < p.minBuyers || coin.buyers.size > p.maxBuyers) continue;
      if (coin.boughtSol > 0 && coin.soldByOthers > coin.boughtSol * p.maxSellRatio) continue;
      if (coin.worstSellShare > p.maxBigSellShare) continue;
      const runup = (Number(curve.virtual_quote_reserves) * coin.tokens0) / (Number(curve.virtual_token_reserves) * coin.quote0) - 1;
      if (runup < p.minRunup || runup > p.maxRunup) continue;
      const flowNow = this.recentFlow(coin, batch.slot);
      if (flowNow.netSol < p.minFlowSol || flowNow.buyerCount < p.minRecentBuyers) continue;
      const maxBuy = Math.floor(Number(state.maxBuyLamports(coin.mint))) / LAMPORTS_PER_SOL;
      const size = Math.min(p.stakeSol, maxBuy);
      if (size < p.minBuySol) continue;
      if (free < size + feeSol + p.cashReserveSol) continue;
      if (exposure + size > p.maxExposureSol) continue;
      orders.push({
        side: 'buy',
        mint: coin.mint,
        quote_lamports: BigInt(Math.floor(size * LAMPORTS_PER_SOL)),
        max_slippage_bps: p.buySlipBps,
      });
      free -= size + feeSol;
      exposure += size;
      coin.entered = true;
      open++;
      placed++;
    }
    return placed;
  }

  /** Guardrail pacing for the 6h final window: open a probe when filled coins lag the pace. */
  private topUpGuardrail(state: BotState, orders: OrderInput[], freeSol: number, openCount: number, pending: Map<Pubkey, number>): void {
    const p = this.cfg;
    const cap = state.hello.caps.max_orders_per_batch;
    if (this.probeMints.size >= p.maxProbes) return;
    if (openCount >= state.hello.caps.max_open_positions) return;
    if (this.windowStart === null || this.windowEnd === null) return;
    const elapsed = Math.min(1, (this.windowEnd - this.windowStart) / p.paceSecs);
    const coinsShort = this.coinsTraded.size < Math.ceil(p.targetCoins * elapsed);
    const fillsShort = this.fillsSeen < Math.ceil(p.targetFills * elapsed);
    if (!coinsShort && !fillsShort) return;
    const feeSol = Number(state.txFeeLamports()) / LAMPORTS_PER_SOL;
    const minReserve = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
    let free = freeSol;
    for (const mint of state.curves.keys()) {
      if (orders.length >= cap || this.probeMints.size >= p.maxProbes) break;
      if (this.trades.has(mint) || this.probeMints.has(mint) || pending.has(mint) || state.positions.has(mint)) continue;
      if (coinsShort && this.coinsTraded.has(mint)) continue;
      const curve = state.curves.get(mint)!;
      if (curve.complete) continue;
      if (Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL < minReserve * 1.5) continue;
      if (free < p.probeSol + 2 * feeSol + p.cashReserveSol) break;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS_PER_SOL)),
        max_slippage_bps: p.buySlipBps,
      });
      this.probeMints.set(mint, false);
      free -= p.probeSol + feeSol;
    }
  }

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    this.ingest(batch);
    const pending = this.syncFills(state, batch);
    const orders: OrderInput[] = [];
    const feeSol = Number(state.txFeeLamports()) / LAMPORTS_PER_SOL;
    this.planExits(state, batch, orders, feeSol);
    this.closeProbes(state, orders, pending);
    let free = Number(state.freeCashLamports()) / LAMPORTS_PER_SOL;
    let exposure = 0;
    for (const [mint] of this.trades) {
      exposure += Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS_PER_SOL;
    }
    // Entries spend from the cash left after exits; probes spend what is left after entries.
    const afterEntries = this.planEntriesCounted(state, batch, orders, free, exposure, state.committedPositionCount());
    free = afterEntries.freeLeft;
    this.topUpGuardrail(state, orders, free, afterEntries.openNow, pending);
    return orders;
  }

  /** Entry planning that also reports the cash left and open slots afterwards. */
  private planEntriesCounted(
    state: BotState,
    batch: Batch,
    orders: OrderInput[],
    freeSol: number,
    exposureSol: number,
    openCount: number,
  ): { freeLeft: number; openNow: number } {
    const before = orders.length;
    const placed = this.planEntries(state, batch, orders, freeSol, exposureSol, openCount);
    // Recompute the cash left from the buys this batch actually placed.
    let spent = 0;
    const feeSol = Number(state.txFeeLamports()) / LAMPORTS_PER_SOL;
    for (let i = before; i < orders.length; i++) {
      const order = orders[i]!;
      if (order.side === 'buy') spent += Number(order.quote_lamports) / LAMPORTS_PER_SOL + feeSol;
    }
    return { freeLeft: freeSol - spent, openNow: openCount + placed };
  }
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  return new SharpeSniper(p);
}
