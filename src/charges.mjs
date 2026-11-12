// NSE equity intraday charges for a discount broker (flat ₹20 or 0.03% per
// executed order, whichever is lower). Rates live in config.json so they can be
// corrected when the broker or the government changes them.
const r2 = (x) => Math.round(x * 100) / 100;

export function orderCharges(side, qty, price, c) {
  const turnover = qty * price;
  const brokerage = Math.min(c.brokeragePerOrder, (turnover * c.brokeragePct) / 100);
  const stt = side === "SELL" ? (turnover * c.sttIntradaySellPct) / 100 : 0;
  const exchange = (turnover * c.exchangePct) / 100;
  const sebi = (turnover * c.sebiPct) / 100;
  const gst = ((brokerage + exchange + sebi) * c.gstPct) / 100;
  const stamp = side === "BUY" ? (turnover * c.stampBuyPct) / 100 : 0;
  const total = brokerage + stt + exchange + sebi + gst + stamp;
  return { brokerage: r2(brokerage), stt: r2(stt), exchange: r2(exchange), sebi: r2(sebi), gst: r2(gst), stamp: r2(stamp), total: r2(total) };
}

// Full in-and-out cost of a trade, either direction.
export function roundTripCharges(qty, entryPrice, exitPrice, c) {
  return r2(orderCharges("BUY", qty, Math.min(entryPrice, exitPrice), c).total + orderCharges("SELL", qty, Math.max(entryPrice, exitPrice), c).total);
}

// Net profit of a closed trade after charges.
export function netPnl(side, qty, entry, exit, c) {
  const gross = side === "LONG" ? (exit - entry) * qty : (entry - exit) * qty;
  const charges = roundTripCharges(qty, entry, exit, c);
  return { gross: r2(gross), charges, net: r2(gross - charges) };
}
