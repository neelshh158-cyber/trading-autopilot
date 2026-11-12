import test from "node:test";
import assert from "node:assert/strict";
import { orderCharges, roundTripCharges, netPnl } from "../src/charges.mjs";
import { loadConfig } from "../src/config.mjs";

const c = loadConfig().charges;

test("brokerage is the lower of ₹20 and 0.03%", () => {
  assert.equal(orderCharges("BUY", 10, 100, c).brokerage, 0.3); // ₹1,000 turnover
  assert.equal(orderCharges("BUY", 1000, 100, c).brokerage, 20); // ₹1,00,000 turnover
});

test("STT only on the sell side, stamp duty only on the buy side", () => {
  const buy = orderCharges("BUY", 100, 100, c);
  const sell = orderCharges("SELL", 100, 100, c);
  assert.equal(buy.stt, 0);
  assert.ok(sell.stt > 0);
  assert.ok(buy.stamp > 0);
  assert.equal(sell.stamp, 0);
});

test("a ₹10,000 round trip costs about ₹10", () => {
  const rt = roundTripCharges(100, 100, 100, c);
  assert.ok(rt > 8 && rt < 12, `got ${rt}`);
});

test("netPnl handles shorts", () => {
  const p = netPnl("SHORT", 10, 100, 95, c);
  assert.equal(p.gross, 50);
  assert.ok(p.net < 50 && p.net > 45);
});
