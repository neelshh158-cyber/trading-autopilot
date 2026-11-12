#!/usr/bin/env node
// Entry point.
//   node src/index.mjs run --mode=paper|live [--data=yahoo|angel] [--max-minutes=N] [--once]
//   node src/index.mjs backtest [--days=60] [--csv=dir] [--verbose]
//   node src/index.mjs sweep [--days=60] [--csv=dir]
//   node src/index.mjs status
//   node src/index.mjs login-check
//   node src/index.mjs kill | resume [--allow-principal]
//   node src/index.mjs reset-paper --yes
import fs from "node:fs";
import path from "node:path";
import { ROOT, DATA_DIR, loadConfig, loadDotEnv } from "./config.mjs";
import { log } from "./log.mjs";
import { istParts, isTradingDay, sleep } from "./time.mjs";
import { readState, writeState, appendTrade, readTrades, killSwitchOn, setKillSwitch } from "./state.mjs";
import { Engine, emptyState } from "./engine.mjs";
import { PaperBroker } from "./broker/paper.mjs";
import { AngelOne, hasAngelCreds } from "./broker/angelone.mjs";
import { YahooData, yahooHistory } from "./data/yahoo.mjs";
import { loadCsvDir } from "./data/csv.mjs";
import { runBacktest, runSweep } from "./backtest.mjs";
import * as risk from "./risk.mjs";

function parseArgs(argv) {
  const out = { command: "status" };
  for (const a of argv) {
    if (!a.startsWith("--")) out.command = a;
    else {
      const [k, v = "true"] = a.slice(2).split("=");
      out[k] = v;
    }
  }
  return out;
}

function fileStore(cfg) {
  const state = readState() || emptyState(cfg.money);
  if (!state.ledger) state.ledger = risk.createLedger(cfg.money);
  state.positions ||= [];
  state.today ||= { date: null, signalled: {} };
  return { state, save: () => writeState(state), appendTrade };
}

async function run(args) {
  const cfg = loadConfig();
  const mode = args.mode === "live" ? "live" : "paper";
  const store = fileStore(cfg);
  const s = cfg.session;

  let broker, data;
  if (mode === "live") {
    if (process.env.LIVE_TRADING_ACK !== "I UNDERSTAND REAL MONEY") throw new Error('Live mode needs LIVE_TRADING_ACK="I UNDERSTAND REAL MONEY" in the environment.');
    if (!hasAngelCreds()) throw new Error("Live mode needs ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_MPIN and ANGEL_TOTP_SECRET.");
    broker = new AngelOne({ charges: cfg.charges, log });
    await broker.prepare(cfg.universe);
    data = broker;
    const rms = await broker.funds().catch(() => null);
    if (rms) log(`Angel One funds: available ₹${rms.availablecash ?? rms.net ?? "?"}`);
  } else {
    broker = new PaperBroker({ slippageBps: cfg.paper.slippageBps, charges: cfg.charges });
    if (args.data === "angel") {
      if (!hasAngelCreds()) throw new Error("--data=angel needs the Angel One credentials");
      data = new AngelOne({ charges: cfg.charges, log });
      await data.prepare(cfg.universe);
    } else data = new YahooData({ log });
  }

  const engine = new Engine({ cfg, broker, data, store, log, killSwitch: killSwitchOn });
  const sum = risk.summary(store.state.ledger);
  log(`${mode.toUpperCase()} mode. equity ₹${sum.equity}, floor ₹${sum.floor}, risk capital ₹${sum.riskCapital}, open positions ${store.state.positions.length}${sum.halted ? ` — HALTED: ${sum.haltReason}` : ""}`);
  if (killSwitchOn()) log("kill switch is ON: nothing will be opened, anything open will be closed");

  const started = Date.now();
  const maxMs = Number(args["max-minutes"] || 0) * 60_000;
  let errors = 0;
  for (;;) {
    const now = Date.now();
    const p = istParts(new Date(now));
    if (!isTradingDay(p, s.holidays)) return log(`${p.date} is not a trading day; nothing to do`);
    if (p.minutes > s.closeMin) return log("market closed for the day");
    if (maxMs && now - started > maxMs) return log("time budget used up; state saved, next run continues");
    try {
      const r = await engine.tick(now);
      if (r?.idle) log(`${p.hm} idle: ${r.idle}`);
      else log(`${p.hm} tick ok${r.gate ? ` (no entries: ${r.gate})` : ""}; open ${store.state.positions.length}, equity ₹${risk.equity(store.state.ledger)}`);
      errors = 0;
    } catch (e) {
      errors++;
      log(`tick failed (${errors}): ${e.message}`);
      if (errors >= 5 && mode === "live" && store.state.positions.length) {
        log("5 failures in a row with open positions: closing everything");
        await engine.closeAll(Date.now(), "repeated errors").catch((err) => log(`emergency close failed: ${err.message}`));
        store.save();
        throw e;
      }
    }
    if (args.once) return;
    // Wake a few seconds after the next candle closes.
    const candleMs = s.candleMinutes * 60_000;
    const next = Math.floor(Date.now() / candleMs) * candleMs + candleMs + 5000;
    await sleep(Math.max(15_000, next - Date.now()));
  }
}

async function loadCandles(cfg, args) {
  let candles;
  if (args.csv) candles = loadCsvDir(path.resolve(args.csv), cfg.universe);
  else {
    candles = {};
    for (const u of cfg.universe) {
      try {
        candles[u.symbol] = await yahooHistory(u, { range: `${args.days || 60}d`, log });
      } catch (e) {
        log(`${u.symbol}: ${e.message}`);
      }
    }
  }
  if (!Object.keys(candles).length) throw new Error("no candles loaded");
  return candles;
}

async function sweep(args) {
  const cfg = loadConfig();
  const candles = await loadCandles(cfg, args);
  const results = await runSweep(cfg, candles, {
    onResult: (r, i, n) => {
      if (i % 16 === 0 || i === n) log(`${i}/${n} variants done`);
    },
  });
  const positive = results.filter((r) => r.net > 0);
  console.log(`\n${results.length} variants over ${Object.keys(candles).length} stocks. ${positive.length} finished positive after charges.`);
  console.log("\nBest 12:");
  console.table(results.slice(0, 12));
  console.log("Worst 5:");
  console.table(results.slice(-5));
  const out = path.join(ROOT, "out");
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `sweep-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  console.log("details:", file);
}

async function backtest(args) {
  const cfg = loadConfig();
  const candles = await loadCandles(cfg, args);
  const { report, trades, equityCurve } = await runBacktest(cfg, candles, { log, verbose: args.verbose === "true" });
  console.log("\nBacktest", equityCurve[0]?.date, "→", equityCurve.at(-1)?.date);
  console.table({
    "trading days": report.days,
    trades: report.trades,
    "win rate %": report.winRate,
    "gross P&L ₹": report.grossPnl,
    "charges ₹": report.charges,
    "net P&L ₹": report.netPnl,
    "avg win ₹": report.avgWin,
    "avg loss ₹": report.avgLoss,
    "max drawdown ₹": report.maxDrawdown,
    "final equity ₹": report.finalEquity,
  });
  if (report.halted) console.log("HALTED:", report.halted);
  console.log("by symbol:", report.bySymbol);
  console.log("exits:", report.byReason);
  const out = path.join(ROOT, "out");
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `backtest-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify({ report, equityCurve, trades }, null, 2));
  console.log("details:", file);
}

function status() {
  const cfg = loadConfig();
  const state = readState();
  if (!state) return console.log("No state yet. Run `npm run paper` on a market day or `npm run backtest`.");
  console.log("kill switch:", killSwitchOn() ? "ON" : "off");
  console.table(risk.summary(state.ledger));
  if (state.positions.length) console.table(state.positions.map((p) => ({ symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entry, stop: p.stop, target: p.target, since: p.openedHm })));
  const trades = readTrades();
  console.log(`${trades.length} closed trades. Last 10:`);
  console.table(trades.slice(-10).map((t) => ({ date: t.date, symbol: t.symbol, side: t.side, qty: t.qty, entry: t.entry, exit: t.exit, why: t.exitReason, net: t.net })));
  const days = Object.entries(state.ledger.days).slice(-10).map(([date, d]) => ({ date, net: d.net, trades: d.trades, stopped: d.stopped ? "yes" : "" }));
  if (days.length) console.table(days);
  void cfg;
}

async function loginCheck() {
  const cfg = loadConfig();
  if (!hasAngelCreds()) throw new Error("Set ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_MPIN, ANGEL_TOTP_SECRET first (see .env.example)");
  const b = new AngelOne({ charges: cfg.charges, log });
  await b.login();
  const prof = await b.profile();
  log(`profile: ${prof.name} (${prof.clientcode}), exchanges ${prof.exchanges?.join(",")}`);
  const rms = await b.funds();
  log(`funds: available ₹${rms.availablecash}, net ₹${rms.net}`);
  const u = cfg.universe[0];
  log(`${u.angel} token ${await b.token(u)}, LTP ₹${await b.ltp(u)}`);
  const ks = await b.candles(u, istParts().date);
  log(`${ks.length} five-minute candles today for ${u.symbol}`);
  log("login-check passed. No orders were placed.");
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "run":
      return run(args);
    case "backtest":
      return backtest(args);
    case "sweep":
      return sweep(args);
    case "status":
      return status();
    case "login-check":
      return loginCheck();
    case "kill":
      setKillSwitch(true);
      return console.log("Kill switch ON. The running bot closes open positions on its next tick and opens nothing. `npm run resume` to lift it.");
    case "resume": {
      setKillSwitch(false);
      const state = readState();
      if (state?.ledger?.halted) {
        const cfg = loadConfig();
        if (args["allow-principal"] === "true") {
          state.ledger.floor = cfg.money.deposit - cfg.money.maxLoss;
          state.ledger.principalProtected = false;
        }
        state.ledger.halted = false;
        state.ledger.haltReason = null;
        writeState(state);
        console.log(`Halt lifted. floor ₹${state.ledger.floor}, risk capital ₹${risk.riskCapital(state.ledger)}`);
      }
      return console.log("Kill switch off.");
    }
    case "reset-paper": {
      if (args.yes !== "true") throw new Error("This wipes data/state.json and data/trades.json. Re-run with --yes.");
      for (const f of ["state.json", "trades.json", "KILL"]) {
        const file = path.join(DATA_DIR, f);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      return console.log("Paper ledger reset.");
    }
    default:
      throw new Error(`unknown command ${args.command}`);
  }
}

main().catch((e) => {
  console.error(`✖ ${e.message}`);
  process.exit(1);
});
