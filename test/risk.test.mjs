import test from "node:test";
import assert from "node:assert/strict";
import * as risk from "../src/risk.mjs";
import { cfg } from "./helpers.mjs";

const c = cfg();
const session = c.session;
const close = (ledger, net, date = "2026-11-03") => risk.recordClose(ledger, c.money, { date, net, charges: 5 });

test("fresh ledger: ₹10,000 equity, floor ₹5,000, risk capital ₹5,000", () => {
  const l = risk.createLedger(c.money);
  assert.equal(risk.equity(l), 10000);
  assert.equal(l.floor, 5000);
  assert.equal(risk.riskCapital(l), 5000);
});

test("1% of risk capital per trade, sized by the stop distance", () => {
  const l = risk.createLedger(c.money);
  const s = risk.positionSize(l, c.money, c.charges, { entry: 100, stop: 99 });
  assert.equal(s.qty, 50);
  assert.equal(s.riskAmt, 50);
});

test("never buy more than the equity can pay for", () => {
  const l = risk.createLedger(c.money);
  const s = risk.positionSize(l, c.money, c.charges, { entry: 3000, stop: 2990 });
  assert.equal(s.qty, 3); // 50 / 10 = 5 wanted, 10000 / 3000 = 3 affordable
  assert.equal(s.riskAmt, 30); // the risk actually taken, not the ₹50 planned
});

test("skip trades where charges would eat the risk", () => {
  const l = risk.createLedger(c.money);
  // Stop 0.05% away: buying power caps the size at 10 shares risking ₹5, and the
  // ₹10,000 round trip costs about ₹10.
  const s = risk.positionSize(l, c.money, c.charges, { entry: 1000, stop: 999.5 });
  assert.equal(s.qty, 0);
  assert.match(s.reason, /charges/);
});

test("hard stop: losing ₹5,000 halts trading for good", () => {
  const l = risk.createLedger(c.money);
  close(l, -2000);
  assert.equal(l.halted, false);
  const events = close(l, -3000);
  assert.equal(l.halted, true);
  assert.match(l.haltReason, /hard stop/);
  assert.ok(events.some((e) => /hard stop/.test(e)));
  assert.equal(risk.canOpen(l, c.money, session, { date: "2026-11-04", minutes: 600, openCount: 0 }).ok, false);
});

test("principal protection: after ₹1,500 profit only the profit is at risk", () => {
  const l = risk.createLedger(c.money);
  close(l, 800);
  assert.equal(l.principalProtected, false);
  close(l, 800, "2026-11-04");
  assert.equal(l.principalProtected, true);
  assert.equal(l.floor, 10000);
  assert.equal(risk.riskCapital(l), 1600);
  // Give the cushion back → halt at the floor, deposit untouched.
  close(l, -1600, "2026-11-05");
  assert.equal(l.halted, true);
  assert.match(l.haltReason, /floor reached/);
  assert.equal(risk.equity(l), 10000);
});

test("daily stop after losing 2% of the day's starting equity", () => {
  const l = risk.createLedger(c.money);
  close(l, -150);
  assert.equal(l.days["2026-11-03"].stopped, null);
  close(l, -60);
  assert.match(l.days["2026-11-03"].stopped, /daily stop/);
  assert.equal(risk.canOpen(l, c.money, session, { date: "2026-11-03", minutes: 600, openCount: 0 }).ok, false);
  assert.equal(risk.canOpen(l, c.money, session, { date: "2026-11-04", minutes: 600, openCount: 0 }).ok, true);
});

test("no entries before the open, after the cut-off, or beyond the position cap", () => {
  const l = risk.createLedger(c.money);
  const at = (minutes, openCount = 0) => risk.canOpen(l, c.money, session, { date: "2026-11-03", minutes, openCount }).ok;
  assert.equal(at(9 * 60), false);
  assert.equal(at(10 * 60), true);
  assert.equal(at(14 * 60 + 31), false);
  assert.equal(at(10 * 60, 1), false);
});
