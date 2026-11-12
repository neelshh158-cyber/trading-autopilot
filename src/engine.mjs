// One tick = look at the completed candles, manage open positions, maybe open a
// new one, save state. The same engine runs backtests, paper trading and live
// trading; only the data source and broker differ.
import { istParts, isTradingDay, istToEpoch } from "./time.mjs";
import { netPnl } from "./charges.mjs";
import * as risk from "./risk.mjs";
import { strategies, tick as roundTick } from "./strategy/orb.mjs";

export function emptyState(money) {
  return { ledger: risk.createLedger(money), positions: [], today: { date: null, signalled: {} } };
}

export class Engine {
  constructor({ cfg, broker, data, store, log = () => {}, killSwitch = () => false }) {
    this.cfg = cfg;
    this.broker = broker;
    this.data = data;
    this.store = store; // { state, save(), appendTrade(t) }
    this.log = log;
    this.killSwitch = killSwitch;
    this.signal = strategies[cfg.strategy.name];
    if (!this.signal) throw new Error(`unknown strategy ${cfg.strategy.name}`);
    this.candleMs = cfg.session.candleMinutes * 60 * 1000;
  }

  get state() {
    return this.store.state;
  }

  async tick(nowMs = Date.now()) {
    const { cfg, state } = this;
    const parts = istParts(new Date(nowMs));
    if (!isTradingDay(parts, cfg.session.holidays)) return { idle: "not a trading day" };
    if (state.today.date !== parts.date) state.today = { date: parts.date, signalled: {} };
    risk.ensureDay(state.ledger, parts.date);

    if (this.killSwitch()) {
      await this.closeAll(nowMs, "kill switch");
      this.store.save();
      return { idle: "kill switch on" };
    }
    if (state.ledger.halted) {
      await this.closeAll(nowMs, "trading halted");
      this.store.save();
      return { idle: `halted: ${state.ledger.haltReason}` };
    }
    // A position from an earlier day means that day's run was cut short before
    // the square-off. Settle it on that day's own candles, never on today's.
    for (const pos of [...state.positions]) if (pos.date !== parts.date) await this.settleStale(pos).catch((e) => this.log(`settle ${pos.symbol}: ${e.message}`));

    if (parts.minutes < cfg.session.openMin) return { idle: "pre-open" };

    const openCount = state.positions.length;
    const gate = risk.canOpen(state.ledger, cfg.money, cfg.session, { date: parts.date, minutes: parts.minutes, openCount });
    const wantSymbols = new Set(state.positions.map((p) => p.symbol));
    if (gate.ok) for (const u of cfg.universe) if (!state.today.signalled[u.symbol]) wantSymbols.add(u.symbol);

    const candles = {};
    for (const u of cfg.universe) {
      if (!wantSymbols.has(u.symbol)) continue;
      try {
        const all = await this.data.candles(u, parts.date);
        candles[u.symbol] = all.filter((k) => k.ts + this.candleMs <= nowMs).sort((a, b) => a.ts - b.ts);
      } catch (e) {
        this.log(`data ${u.symbol}: ${e.message}`);
      }
    }

    // 1. Manage what is open.
    for (const pos of [...state.positions]) {
      const ks = (candles[pos.symbol] || []).filter((k) => k.ts > pos.lastCandleTs);
      const filled = await this.broker.checkStopFilled(pos).catch((e) => (this.log(`stop check ${pos.symbol}: ${e.message}`), null));
      if (filled?.exitPrice) {
        await this.finish(pos, filled.exitPrice, "stop (exchange)", nowMs);
        continue;
      }
      let closed = false;
      for (const k of ks) {
        pos.lastCandleTs = k.ts;
        const hit = exitFromCandle(pos, k);
        if (hit) {
          await this.closePosition(pos, hit.price, hit.reason, nowMs);
          closed = true;
          break;
        }
        const be = breakevenStop(pos, k, cfg.strategy.breakevenAfterR);
        if (be != null) {
          pos.stop = be;
          pos.breakeven = true;
          this.log(`${pos.symbol}: ${cfg.strategy.breakevenAfterR}R in favour, stop moved to ${be}`);
          await this.broker.modifyStop?.(pos, be)?.catch?.((e) => this.log(`modify stop ${pos.symbol}: ${e.message}`));
        }
      }
      if (!closed && parts.minutes >= cfg.session.squareOffMin) {
        const ref = ks.at(-1)?.c ?? (candles[pos.symbol] || []).at(-1)?.c ?? pos.entry;
        await this.closePosition(pos, ref, "square-off", nowMs);
      }
    }

    // 2. Maybe open something new.
    const opened = [];
    if (gate.ok && parts.minutes < cfg.session.squareOffMin) {
      const signals = [];
      for (const u of cfg.universe) {
        if (state.today.signalled[u.symbol] || state.positions.some((p) => p.symbol === u.symbol)) continue;
        const sig = this.signal(candles[u.symbol] || [], cfg.strategy, cfg.session);
        if (sig) signals.push({ u, sig, lastTs: candles[u.symbol].at(-1).ts });
      }
      signals.sort((a, b) => b.sig.volRatio - a.sig.volRatio);
      for (const { u, sig, lastTs } of signals) {
        state.today.signalled[u.symbol] = true; // one shot per symbol per day, taken or not
        const again = risk.canOpen(state.ledger, cfg.money, cfg.session, { date: parts.date, minutes: parts.minutes, openCount: state.positions.length });
        if (!again.ok) break;
        const size = risk.positionSize(state.ledger, cfg.money, cfg.charges, sig);
        if (!size.qty) {
          this.log(`${u.symbol} ${sig.side} skipped: ${size.reason}`);
          continue;
        }
        try {
          const fill = await this.broker.open({ u, side: sig.side, qty: size.qty, stop: sig.stop, target: sig.target, signalPrice: sig.entry });
          const pos = {
            id: `${parts.date}-${u.symbol}-${fill.orderId}`,
            date: parts.date,
            symbol: u.symbol,
            yahoo: u.yahoo,
            angel: u.angel,
            side: sig.side,
            qty: size.qty,
            entry: fill.entryPrice,
            stop: sig.stop,
            target: sig.target,
            riskPerShare: Math.abs(fill.entryPrice - sig.stop),
            riskAmt: size.riskAmt,
            openedAt: new Date(nowMs).toISOString(),
            openedHm: parts.hm,
            lastCandleTs: lastTs,
            orderId: fill.orderId,
            slOrderId: fill.slOrderId,
            reason: sig.reason,
          };
          state.positions.push(pos);
          risk.ensureDay(state.ledger, parts.date).trades += 1;
          opened.push(pos);
          this.log(`OPEN ${pos.side} ${pos.qty} ${pos.symbol} @ ${pos.entry} stop ${pos.stop} target ${pos.target} (risk ₹${size.riskAmt}) — ${sig.reason}`);
        } catch (e) {
          this.log(`open ${u.symbol} failed: ${e.message}`);
        }
      }
    }
    this.store.save();
    return { opened, gate: gate.ok ? null : gate.reason };
  }

  // Replay the rest of the position's own day and close it where the live run
  // would have: at its stop or target, else at the square-off time.
  async settleStale(pos) {
    const { cfg } = this;
    const all = await this.data.candles({ symbol: pos.symbol, yahoo: pos.yahoo, angel: pos.angel }, pos.date);
    const ks = all.filter((k) => k.ts > pos.lastCandleTs && k.min < cfg.session.squareOffMin).sort((a, b) => a.ts - b.ts);
    const squareOffMs = istToEpoch(pos.date, cfg.session.squareOff);
    for (const k of ks) {
      pos.lastCandleTs = k.ts;
      const hit = exitFromCandle(pos, k);
      if (hit) return this.closePosition(pos, hit.price, `${hit.reason} (settled late)`, k.ts + this.candleMs);
      const be = breakevenStop(pos, k, cfg.strategy.breakevenAfterR);
      if (be != null) {
        pos.stop = be;
        pos.breakeven = true;
      }
    }
    const ref = ks.at(-1)?.c ?? all.at(-1)?.c;
    if (ref == null) throw new Error(`no candles for ${pos.date} to settle on`);
    return this.closePosition(pos, ref, "square-off (settled late)", squareOffMs);
  }

  async closePosition(pos, refPrice, reason, nowMs) {
    const fill = await this.broker.close(pos, refPrice, reason);
    await this.finish(pos, fill.exitPrice, reason, nowMs);
  }

  async finish(pos, exitPrice, reason, nowMs) {
    const { state, cfg } = this;
    const pnl = netPnl(pos.side, pos.qty, pos.entry, exitPrice, cfg.charges);
    const trade = { ...pos, exit: exitPrice, exitReason: reason, closedAt: new Date(nowMs).toISOString(), closedHm: istParts(new Date(nowMs)).hm, ...pnl };
    state.positions = state.positions.filter((p) => p.id !== pos.id);
    const events = risk.recordClose(state.ledger, cfg.money, trade);
    trade.equityAfter = risk.equity(state.ledger);
    this.store.appendTrade(trade);
    this.log(`CLOSE ${pos.side} ${pos.qty} ${pos.symbol} @ ${exitPrice} (${reason}) net ₹${pnl.net} → equity ₹${trade.equityAfter}`);
    for (const ev of events) this.log(`!! ${ev}`);
  }

  async closeAll(nowMs, reason) {
    for (const pos of [...this.state.positions]) {
      let ref = pos.entry;
      try {
        const ks = await this.data.candles({ symbol: pos.symbol, yahoo: pos.yahoo, angel: pos.angel }, istParts(new Date(nowMs)).date);
        ref = ks.at(-1)?.c ?? ref;
      } catch {}
      await this.closePosition(pos, ref, reason, nowMs).catch((e) => this.log(`close ${pos.symbol} failed: ${e.message}`));
    }
  }
}

// Once price has moved `afterR` times the initial risk in our favour, move the
// stop to just past the entry so a fizzled trade cannot turn into a loser.
export function breakevenStop(pos, k, afterR) {
  if (!(afterR > 0) || pos.breakeven) return null;
  const r = pos.riskPerShare ?? Math.abs(pos.entry - pos.stop);
  const favourable = pos.side === "LONG" ? k.h - pos.entry : pos.entry - k.l;
  if (favourable < afterR * r) return null;
  const pad = pos.entry * 0.0015; // covers charges and slippage
  return roundTick(pos.side === "LONG" ? pos.entry + pad : pos.entry - pad);
}

// Did this candle take out the stop or the target? Stop is checked first (worst case).
export function exitFromCandle(pos, k) {
  if (pos.side === "LONG") {
    if (k.l <= pos.stop) return { price: Math.min(k.o, pos.stop), reason: "stop" };
    if (k.h >= pos.target) return { price: Math.max(k.o, pos.target), reason: "target" };
  } else {
    if (k.h >= pos.stop) return { price: Math.max(k.o, pos.stop), reason: "stop" };
    if (k.l <= pos.target) return { price: Math.min(k.o, pos.target), reason: "target" };
  }
  return null;
}
