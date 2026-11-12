import { istToEpoch } from "../src/time.mjs";
import { makeCandle } from "../src/data/candles.mjs";
import { loadConfig } from "../src/config.mjs";

export const mk = (date, hm, o, h, l, c, v) => makeCandle(istToEpoch(date, hm), o, h, l, c, v);

export function cfg(overrides = {}) {
  const c = loadConfig();
  return { ...c, ...overrides, money: { ...c.money, ...(overrides.money || {}) }, strategy: { ...c.strategy, ...(overrides.strategy || {}) } };
}

// A quiet 15-minute opening range 99.5-100.5 on 1000 volume per candle.
export function openingRange(date) {
  return [mk(date, "09:15", 100, 100.5, 99.5, 100.2, 1000), mk(date, "09:20", 100.2, 100.4, 99.8, 100, 1000), mk(date, "09:25", 100, 100.3, 99.6, 100.1, 1000)];
}
