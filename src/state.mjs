// state.json: the money ledger, open positions and today's bookkeeping.
// trades.json: every closed trade, newest last. Both are committed back to the
// repo by the paper workflow so a run can resume where the last one stopped.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.mjs";

const STATE = () => path.join(DATA_DIR, "state.json");
const TRADES = () => path.join(DATA_DIR, "trades.json");
const KILL = () => path.join(DATA_DIR, "KILL");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function readState() {
  return readJson(STATE(), null);
}

export function writeState(state) {
  state.updatedAt = new Date().toISOString();
  writeJson(STATE(), state);
}

export function readTrades() {
  const t = readJson(TRADES(), []);
  return Array.isArray(t) ? t : [];
}

export function appendTrade(trade) {
  const all = readTrades();
  all.push(trade);
  writeJson(TRADES(), all);
}

// The kill switch: a file in data/ or an environment variable. Checked every tick.
export function killSwitchOn() {
  return process.env.TRADING_KILL === "1" || fs.existsSync(KILL());
}

export function setKillSwitch(on) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (on) fs.writeFileSync(KILL(), `stopped at ${new Date().toISOString()}\n`);
  else if (fs.existsSync(KILL())) fs.unlinkSync(KILL());
}
