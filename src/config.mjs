import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hmToMinutes } from "./time.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.TRADING_DATA_DIR || path.join(ROOT, "data");

export function loadDotEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export function loadConfig(file = process.env.TRADING_CONFIG || "config.json") {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
  validate(cfg);
  const s = cfg.session;
  cfg.session = {
    ...s,
    openMin: hmToMinutes(s.open),
    lastEntryMin: hmToMinutes(s.lastEntry),
    squareOffMin: hmToMinutes(s.squareOff),
    closeMin: hmToMinutes(s.close),
  };
  return cfg;
}

export function validate(cfg) {
  const m = cfg.money;
  if (!m || !(m.deposit > 0)) throw new Error("config.money.deposit must be > 0");
  if (!(m.maxLoss > 0 && m.maxLoss <= m.deposit)) throw new Error("config.money.maxLoss must be between 0 and the deposit");
  if (!(m.riskPerTradePct > 0 && m.riskPerTradePct <= 5)) throw new Error("config.money.riskPerTradePct must be in (0, 5]");
  if (!(m.leverage >= 1 && m.leverage <= 5)) throw new Error("config.money.leverage must be between 1 and 5");
  if (!Array.isArray(cfg.universe) || cfg.universe.length === 0) throw new Error("config.universe is empty");
  const s = cfg.session;
  if (!(hmToMinutes(s.open) < hmToMinutes(s.lastEntry) && hmToMinutes(s.lastEntry) < hmToMinutes(s.squareOff) && hmToMinutes(s.squareOff) < hmToMinutes(s.close))) {
    throw new Error("config.session times must be open < lastEntry < squareOff < close");
  }
}
