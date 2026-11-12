// Opening Range Breakout on 5-minute candles.
//
// Wait for the first `rangeMinutes` of the session, note its high and low.
// Take the FIRST candle that closes outside that range on above-average volume,
// in the direction of the break. Stop goes at the other side of the range
// (clamped between minStopPct and maxStopPct of price), target at targetR
// times the stop distance. One signal per symbol per day.
//
// This is a well-known, simple, honest baseline. It is not a money machine.
// Measure it with `npm run backtest` before trusting it with anything.

export const tick = (x) => Math.round(Math.round(x / 0.05) * 0.05 * 100) / 100;

export function orbSignal(candles, strat, session) {
  const step = session.candleMinutes;
  const rangeEnd = session.openMin + strat.rangeMinutes;
  const range = candles.filter((k) => k.min >= session.openMin && k.min < rangeEnd);
  if (range.length < strat.rangeMinutes / step) return null;

  const orHigh = Math.max(...range.map((k) => k.h));
  const orLow = Math.min(...range.map((k) => k.l));
  if (((orHigh - orLow) / orLow) * 100 > strat.rangeMaxPct) return null;
  const avgVol = range.reduce((s, k) => s + k.v, 0) / range.length;

  const after = candles.filter((k) => k.min >= rangeEnd);
  if (after.length === 0) return null;
  const last = after[after.length - 1];
  if (last.min > session.lastEntryMin) return null;
  // Only the first breakout of the day counts.
  if (after.slice(0, -1).some((k) => k.c > orHigh || k.c < orLow)) return null;

  const volRatio = avgVol > 0 ? last.v / avgVol : 0;
  if (volRatio < strat.volumeMult) return null;

  const minD = (last.c * strat.minStopPct) / 100;
  const maxD = (last.c * strat.maxStopPct) / 100;
  const clamp = (d) => Math.min(maxD, Math.max(minD, d));

  if (last.c > orHigh) {
    const entry = tick(last.c);
    const dist = clamp(entry - orLow);
    const stop = tick(entry - dist);
    return { side: "LONG", entry, stop, target: tick(entry + strat.targetR * (entry - stop)), volRatio, orHigh, orLow, reason: `close ${entry} above range high ${orHigh}, volume ${volRatio.toFixed(1)}x` };
  }
  if (last.c < orLow && strat.allowShort) {
    const entry = tick(last.c);
    const dist = clamp(orHigh - entry);
    const stop = tick(entry + dist);
    return { side: "SHORT", entry, stop, target: tick(entry - strat.targetR * (stop - entry)), volRatio, orHigh, orLow, reason: `close ${entry} below range low ${orLow}, volume ${volRatio.toFixed(1)}x` };
  }
  return null;
}

export const strategies = { orb: orbSignal };
