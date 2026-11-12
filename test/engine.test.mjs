import test from "node:test";
import assert from "node:assert/strict";
import { runBacktest } from "../src/backtest.mjs";
import { exitFromCandle } from "../src/engine.mjs";
import { cfg, mk, openingRange } from "./helpers.mjs";

const D = "2026-11-03";
const flat = (date, from, to, price = 100.8) => {
  const out = [];
  for (let m = from; m <= to; m += 5) out.push(mk(date, `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`, price, price + 0.2, price - 0.2, price, 900));
  return out;
};
const one = (sym, candles) => ({ ...cfg(), universe: [{ symbol: sym, yahoo: `${sym}.NS`, angel: `${sym}-EQ` }], candles });

test("breakout, stop hit, loss booked with charges, one shot per symbol per day", async () => {
  const day = [...openingRange(D), mk(D, "09:30", 100.3, 101.2, 100.2, 101, 2000), mk(D, "09:35", 100.8, 100.9, 99, 99.2, 1500), ...flat(D, 9 * 60 + 40, 15 * 60 + 25)];
  const c = one("SBIN", day);
  const { trades, ledger, report } = await runBacktest(c, { SBIN: day });
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.side, "LONG");
  assert.equal(t.qty, 50);
  assert.equal(t.exitReason, "stop");
  assert.ok(Math.abs(t.entry - 101.05) < 0.011); // 5 bps slippage
  assert.ok(t.exit <= 100);
  assert.ok(t.net < -50 && t.net > -70, `net ${t.net}`);
  assert.equal(report.finalEquity, Math.round((10000 + t.net) * 100) / 100);
  assert.equal(ledger.days[D].trades, 1);
});

test("target hit books a profit", async () => {
  const day = [...openingRange(D), mk(D, "09:30", 100.3, 101.2, 100.2, 101, 2000), mk(D, "09:35", 101.1, 102.8, 101, 102.6, 1500), ...flat(D, 9 * 60 + 40, 15 * 60 + 25, 102.5)];
  const { trades } = await runBacktest(one("INFY", day), { INFY: day });
  assert.equal(trades[0].exitReason, "target");
  assert.ok(trades[0].net > 60, `net ${trades[0].net}`);
});

test("open position is squared off at 15:10", async () => {
  const day = [...openingRange(D), mk(D, "09:30", 100.3, 101.2, 100.2, 101, 2000), ...flat(D, 9 * 60 + 35, 15 * 60 + 25, 101.3)];
  const { trades } = await runBacktest(one("TCS", day), { TCS: day });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].exitReason, "square-off");
  assert.equal(trades[0].closedHm, "15:10");
});

test("the daily stop blocks the second trade of a bad day", async () => {
  const lose = (date) => [...openingRange(date), mk(date, "09:30", 100.3, 101.2, 100.2, 101, 2000), mk(date, "09:35", 100.8, 100.9, 99, 99.2, 1500), ...flat(date, 9 * 60 + 40, 15 * 60 + 25)];
  const late = [...openingRange(D), ...flat(D, 9 * 60 + 30, 11 * 60, 100.1).map((k) => ({ ...k, v: 900 })), mk(D, "11:05", 100.3, 101.2, 100.2, 101, 2000), ...flat(D, 11 * 60 + 10, 15 * 60 + 25, 101)];
  const c = { ...cfg({ money: { maxDailyLossPct: 0.5, maxOpenPositions: 2 } }), universe: [{ symbol: "A", yahoo: "A.NS", angel: "A-EQ" }, { symbol: "B", yahoo: "B.NS", angel: "B-EQ" }] };
  const { trades, ledger } = await runBacktest(c, { A: lose(D), B: late });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].symbol, "A");
  assert.match(ledger.days[D].stopped, /daily stop/);
});

test("gap through the stop exits at the open, not the stop", () => {
  const pos = { side: "LONG", stop: 100, target: 103 };
  assert.deepEqual(exitFromCandle(pos, mk(D, "10:00", 98, 99, 97, 98.5, 1)), { price: 98, reason: "stop" });
  assert.deepEqual(exitFromCandle(pos, mk(D, "10:00", 101, 103.5, 100.5, 103, 1)), { price: 103, reason: "target" });
  assert.equal(exitFromCandle(pos, mk(D, "10:00", 101, 102, 100.5, 101.5, 1)), null);
  const sh = { side: "SHORT", stop: 100, target: 97 };
  assert.deepEqual(exitFromCandle(sh, mk(D, "10:00", 99, 100.5, 98, 100, 1)), { price: 100, reason: "stop" });
});

test("breakeven stop moves to just past entry after 1R in favour", async () => {
  const { breakevenStop } = await import("../src/engine.mjs");
  const pos = { side: "LONG", entry: 100, stop: 99, riskPerShare: 1 };
  assert.equal(breakevenStop(pos, mk(D, "10:00", 100.2, 100.8, 100, 100.5, 1), 1), null);
  assert.equal(breakevenStop(pos, mk(D, "10:05", 100.5, 101.1, 100.4, 101, 1), 1), 100.15);
  assert.equal(breakevenStop({ ...pos, breakeven: true }, mk(D, "10:05", 100.5, 101.1, 100.4, 101, 1), 1), null);
  assert.equal(breakevenStop(pos, mk(D, "10:05", 100.5, 103, 100.4, 101, 1), 0), null);
  const sh = { side: "SHORT", entry: 100, stop: 101, riskPerShare: 1 };
  assert.equal(breakevenStop(sh, mk(D, "10:05", 99.5, 99.6, 98.9, 99, 1), 1), 99.85);
});

test("a fizzled trade with breakeven on exits flat instead of losing at square-off", async () => {
  const day = [...openingRange(D), mk(D, "09:30", 100.3, 101.2, 100.2, 101, 2000), mk(D, "09:35", 101.1, 102.1, 101, 101.8, 1500), mk(D, "09:40", 101.8, 101.9, 100.1, 100.3, 1500), ...flat(D, 9 * 60 + 45, 15 * 60 + 25, 100.3)];
  const c = { ...one("ITC", day), strategy: { ...cfg().strategy, breakevenAfterR: 1 } };
  const { trades } = await runBacktest(c, { ITC: day });
  assert.equal(trades[0].exitReason, "stop");
  assert.ok(Math.abs(trades[0].net) < 10, `net ${trades[0].net}`);
});

test("a position left open by an interrupted run is settled on its own day's candles", async () => {
  const { Engine, emptyState } = await import("../src/engine.mjs");
  const { PaperBroker } = await import("../src/broker/paper.mjs");
  const c = one("AXISBANK", []);
  const Y = "2026-11-02", T = "2026-11-03";
  const yesterday = [...openingRange(Y), mk(Y, "09:30", 99.8, 99.9, 98.8, 99, 2000), ...flat(Y, 9 * 60 + 35, 15 * 60 + 25, 99.6)];
  const today = [...openingRange(T), ...flat(T, 9 * 60 + 30, 15 * 60 + 25, 100)];
  const data = { candles: async (u, date) => (date === Y ? yesterday : date === T ? today : []) };
  const trades = [];
  const store = { state: emptyState(c.money), save() {}, appendTrade: (t) => trades.push(t) };
  store.state.positions.push({ id: "x", date: Y, symbol: "AXISBANK", yahoo: "AXISBANK.NS", angel: "AXISBANK-EQ", side: "SHORT", qty: 5, entry: 99, stop: 100, target: 97.5, riskPerShare: 1, riskAmt: 5, lastCandleTs: mk(Y, "09:30", 0, 0, 0, 0, 0).ts, orderId: "P1", slOrderId: null });
  const engine = new Engine({ cfg: c, broker: new PaperBroker({ slippageBps: 5, charges: c.charges }), data, store });
  await engine.tick(mk(T, "09:05", 0, 0, 0, 0, 0).ts);
  assert.equal(store.state.positions.length, 0);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].exitReason, "square-off (settled late)");
  assert.equal(trades[0].closedHm, "15:10");
  assert.equal(trades[0].date, Y);
  assert.ok(trades[0].net < 0 && trades[0].net > -10, `net ${trades[0].net}`); // shorted 99, closed ~99.6
});
