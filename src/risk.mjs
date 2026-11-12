// The money rules. Nothing trades unless this file says yes.
//
//   deposit ................ what you put in (₹10,000)
//   floor .................. equity level at which trading halts for good.
//                            Starts at deposit - maxLoss (₹5,000). Once realised
//                            profit reaches protectPrincipalAfterProfit, the floor
//                            moves up to the deposit, so from then on only profit
//                            is ever at risk ("trade from the profit, not the deposit").
//   risk capital ........... equity - floor. Every position risks riskPerTradePct of it.
//   daily stop ............. stop for the day after losing maxDailyLossPct of the
//                            equity the day started with.
import { roundTripCharges } from "./charges.mjs";

const r2 = (x) => Math.round(x * 100) / 100;

export function createLedger(money) {
  return {
    deposit: money.deposit,
    floor: r2(money.deposit - money.maxLoss),
    realised: 0,
    charges: 0,
    trades: 0,
    principalProtected: false,
    halted: false,
    haltReason: null,
    haltedAt: null,
    days: {},
  };
}

export const equity = (l) => r2(l.deposit + l.realised);
export const riskCapital = (l) => Math.max(0, r2(equity(l) - l.floor));

export function ensureDay(ledger, date) {
  if (!ledger.days[date]) ledger.days[date] = { startEquity: equity(ledger), net: 0, trades: 0, stopped: null };
  return ledger.days[date];
}

// Called when a trade closes. Returns a list of notable events for the log.
export function recordClose(ledger, money, trade) {
  const events = [];
  const day = ensureDay(ledger, trade.date);
  ledger.realised = r2(ledger.realised + trade.net);
  ledger.charges = r2(ledger.charges + trade.charges);
  ledger.trades += 1;
  day.net = r2(day.net + trade.net);

  const eq = equity(ledger);
  if (!ledger.principalProtected && ledger.realised >= money.protectPrincipalAfterProfit) {
    ledger.principalProtected = true;
    ledger.floor = ledger.deposit;
    events.push(`principal protected: profit reached ₹${ledger.realised}, floor moved to ₹${ledger.floor}`);
  }
  if (eq <= ledger.deposit - money.maxLoss) {
    halt(ledger, `hard stop: equity ₹${eq} is down ₹${r2(ledger.deposit - eq)} from the deposit (limit ₹${money.maxLoss})`);
    events.push(ledger.haltReason);
  } else if (eq <= ledger.floor) {
    halt(ledger, `floor reached: equity ₹${eq} is at the protected floor ₹${ledger.floor}; the profit cushion is used up`);
    events.push(ledger.haltReason);
  }
  const dailyLimit = r2((day.startEquity * money.maxDailyLossPct) / 100);
  if (!day.stopped && day.net <= -dailyLimit) {
    day.stopped = `daily stop: lost ₹${-day.net} today (limit ₹${dailyLimit})`;
    events.push(day.stopped);
  }
  return events;
}

export function halt(ledger, reason) {
  ledger.halted = true;
  ledger.haltReason = reason;
  ledger.haltedAt = new Date().toISOString();
}

// May a new position be opened right now?
export function canOpen(ledger, money, session, { date, minutes, openCount }) {
  if (ledger.halted) return { ok: false, reason: ledger.haltReason };
  const day = ensureDay(ledger, date);
  if (day.stopped) return { ok: false, reason: day.stopped };
  if (minutes < session.openMin) return { ok: false, reason: "market not open" };
  if (minutes > session.lastEntryMin) return { ok: false, reason: `no new entries after ${session.lastEntry}` };
  if (openCount >= money.maxOpenPositions) return { ok: false, reason: "max open positions" };
  if (day.trades >= money.maxTradesPerDay) return { ok: false, reason: "max trades for the day" };
  if (riskCapital(ledger) < money.minRiskPerTrade * 10) return { ok: false, reason: `risk capital ₹${riskCapital(ledger)} too small to trade sensibly` };
  return { ok: true };
}

// How many shares, given where the stop is. 0 means "skip this trade".
export function positionSize(ledger, money, charges, { entry, stop }) {
  const stopDist = Math.abs(entry - stop);
  if (!(stopDist > 0) || !(entry > 0)) return { qty: 0, reason: "bad prices" };
  const rc = riskCapital(ledger);
  let riskAmt = r2((rc * money.riskPerTradePct) / 100);
  if (riskAmt < money.minRiskPerTrade) {
    if (rc < money.minRiskPerTrade * 10) return { qty: 0, reason: "risk capital too small" };
    riskAmt = money.minRiskPerTrade;
  }
  const buyingPower = equity(ledger) * money.leverage;
  let qty = Math.floor(riskAmt / stopDist);
  qty = Math.min(qty, Math.floor(buyingPower / entry));
  if (qty < 1) return { qty: 0, reason: `one share would risk ₹${r2(stopDist)} or cost ₹${r2(entry)}, more than allowed` };
  const actualRisk = r2(qty * stopDist); // smaller than riskAmt when buying power capped the size
  const est = roundTripCharges(qty, entry, entry, charges);
  if (est > (actualRisk * money.maxChargesPctOfRisk) / 100) {
    return { qty: 0, reason: `charges ₹${est} would eat ${Math.round((est / actualRisk) * 100)}% of the ₹${actualRisk} risked` };
  }
  return { qty, riskAmt: actualRisk, notional: r2(qty * entry), charges: est };
}

export function summary(ledger) {
  return {
    equity: equity(ledger),
    floor: ledger.floor,
    riskCapital: riskCapital(ledger),
    realised: ledger.realised,
    charges: ledger.charges,
    trades: ledger.trades,
    principalProtected: ledger.principalProtected,
    halted: ledger.halted,
    haltReason: ledger.haltReason,
  };
}
