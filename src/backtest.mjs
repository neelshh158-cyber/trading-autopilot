// Replay history through the very same engine, candle by candle.
import { Engine, emptyState } from "./engine.mjs";
import { PaperBroker } from "./broker/paper.mjs";
import { istToEpoch, minutesToHm } from "./time.mjs";
import { byDate } from "./data/candles.mjs";
import * as risk from "./risk.mjs";
import { hmToMinutes } from "./time.mjs";

class ReplayData {
  constructor(candlesBySymbol) {
    this.days = {};
    for (const [sym, list] of Object.entries(candlesBySymbol)) this.days[sym] = byDate(list);
  }
  async candles(u, date) {
    return this.days[u.symbol]?.[date] || [];
  }
}

export async function runBacktest(cfg, candlesBySymbol, { log = () => {}, verbose = false } = {}) {
  const dates = [...new Set(Object.values(candlesBySymbol).flat().map((k) => k.date))].sort();
  const trades = [];
  const store = { state: emptyState(cfg.money), save() {}, appendTrade: (t) => trades.push(t) };
  const broker = new PaperBroker({ slippageBps: cfg.paper.slippageBps, charges: cfg.charges });
  const engine = new Engine({ cfg, broker, data: new ReplayData(candlesBySymbol), store, log: verbose ? log : () => {} });
  const s = cfg.session;
  const equityCurve = [];
  for (const date of dates) {
    for (let m = s.openMin + s.candleMinutes; m <= s.closeMin; m += s.candleMinutes) {
      await engine.tick(istToEpoch(date, minutesToHm(m)) + 1000);
    }
    equityCurve.push({ date, equity: risk.equity(store.state.ledger) });
    if (store.state.ledger.halted) break;
  }
  return { trades, ledger: store.state.ledger, equityCurve, dates, report: report(trades, store.state.ledger, equityCurve, cfg) };
}

export function report(trades, ledger, curve, cfg) {
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net <= 0);
  let peak = cfg.money.deposit, maxDd = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    maxDd = Math.max(maxDd, peak - p.equity);
  }
  const sum = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
  const bySymbol = {};
  for (const t of trades) bySymbol[t.symbol] = Math.round(((bySymbol[t.symbol] || 0) + t.net) * 100) / 100;
  const byReason = {};
  for (const t of trades) byReason[t.exitReason] = (byReason[t.exitReason] || 0) + 1;
  return {
    days: curve.length,
    trades: trades.length,
    winRate: trades.length ? Math.round((wins.length / trades.length) * 100) : 0,
    grossPnl: sum(trades.map((t) => t.gross)),
    charges: sum(trades.map((t) => t.charges)),
    netPnl: sum(trades.map((t) => t.net)),
    avgWin: wins.length ? Math.round((sum(wins.map((t) => t.net)) / wins.length) * 100) / 100 : 0,
    avgLoss: losses.length ? Math.round((sum(losses.map((t) => t.net)) / losses.length) * 100) / 100 : 0,
    maxDrawdown: Math.round(maxDd * 100) / 100,
    finalEquity: risk.equity(ledger),
    halted: ledger.halted ? ledger.haltReason : null,
    bySymbol,
    byReason,
  };
}

// Try a grid of sensible variants on the same data. This is a sanity check
// ("is any honest version of this positive?"), not a search for the best
// numbers: 60 days is far too little to tune on, and tuned numbers lie.
export const SWEEP_GRID = {
  rangeMinutes: [15, 30],
  volumeMult: [1.0, 1.5],
  targetR: [1, 2, 3],
  maxStopPct: [0.5, 1.0],
  breakevenAfterR: [0, 1],
  allowShort: [true, false],
  lastEntry: ["11:00", "14:30"],
};

export async function runSweep(cfg, candlesBySymbol, { grid = SWEEP_GRID, onResult = () => {} } = {}) {
  const keys = Object.keys(grid);
  const combos = keys.reduce((acc, k) => acc.flatMap((c) => grid[k].map((v) => ({ ...c, [k]: v }))), [{}]);
  const results = [];
  for (const combo of combos) {
    const { lastEntry, ...strat } = combo;
    const variant = {
      ...cfg,
      strategy: { ...cfg.strategy, ...strat },
      session: { ...cfg.session, lastEntry, lastEntryMin: hmToMinutes(lastEntry) },
    };
    const { report } = await runBacktest(variant, candlesBySymbol);
    const row = { ...combo, trades: report.trades, winRate: report.winRate, net: report.netPnl, maxDD: report.maxDrawdown, charges: report.charges };
    results.push(row);
    onResult(row, results.length, combos.length);
  }
  results.sort((a, b) => b.net - a.net);
  return results;
}
