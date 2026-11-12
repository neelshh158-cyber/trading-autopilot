// Candle shape used everywhere: { ts (epoch ms, candle start), date, min (IST minutes), o, h, l, c, v }
import { istParts } from "../time.mjs";

export function makeCandle(tsMs, o, h, l, c, v) {
  const p = istParts(new Date(tsMs));
  return { ts: tsMs, date: p.date, min: p.minutes, o, h, l, c, v };
}

// Group a flat list of candles by IST date.
export function byDate(candles) {
  const out = {};
  for (const k of candles) (out[k.date] ||= []).push(k);
  return out;
}
