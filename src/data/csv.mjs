// Candles from CSV files, one per symbol: <dir>/<SYMBOL>.csv with a header row and
// columns  timestamp,open,high,low,close,volume  where timestamp is ISO 8601
// (any zone, e.g. 2026-10-01T09:15:00+05:30) or epoch seconds.
import fs from "node:fs";
import path from "node:path";
import { makeCandle } from "./candles.mjs";

export function readCsvCandles(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const header = lines.shift().toLowerCase().split(",").map((s) => s.trim());
  const col = (names) => header.findIndex((h) => names.includes(h));
  const iT = col(["timestamp", "time", "date", "datetime"]);
  const iO = col(["open", "o"]), iH = col(["high", "h"]), iL = col(["low", "l"]), iC = col(["close", "c"]), iV = col(["volume", "v", "vol"]);
  if ([iT, iO, iH, iL, iC].includes(-1)) throw new Error(`${file}: need timestamp,open,high,low,close columns`);
  return lines.map((line) => {
    const f = line.split(",");
    const raw = f[iT].trim();
    const ts = /^\d{9,13}$/.test(raw) ? Number(raw) * (raw.length <= 10 ? 1000 : 1) : Date.parse(raw);
    return makeCandle(ts, +f[iO], +f[iH], +f[iL], +f[iC], iV >= 0 ? +f[iV] : 0);
  });
}

export function loadCsvDir(dir, universe) {
  const out = {};
  for (const u of universe) {
    const file = path.join(dir, `${u.symbol}.csv`);
    if (fs.existsSync(file)) out[u.symbol] = readCsvCandles(file);
  }
  return out;
}
