// Simulated broker: fills at the reference price with a little adverse slippage
// and charges exactly what the real broker would. No network.
import { orderCharges } from "../charges.mjs";

export class PaperBroker {
  constructor({ slippageBps = 5, charges }) {
    this.slip = slippageBps / 10000;
    this.charges = charges;
    this.mode = "paper";
    this.nextId = 1;
  }

  async prepare() {}

  async open({ side, qty, signalPrice }) {
    const entryPrice = round(side === "LONG" ? signalPrice * (1 + this.slip) : signalPrice * (1 - this.slip));
    const ch = orderCharges(side === "LONG" ? "BUY" : "SELL", qty, entryPrice, this.charges).total;
    return { orderId: `P${this.nextId++}`, slOrderId: null, entryPrice, entryCharges: ch };
  }

  // The exchange-side stop order does not exist on paper; the engine detects stops from candles.
  async checkStopFilled() {
    return null;
  }

  async close(position, refPrice) {
    const exitPrice = round(position.side === "LONG" ? refPrice * (1 - this.slip) : refPrice * (1 + this.slip));
    return { exitPrice, orderId: `P${this.nextId++}` };
  }
}

const round = (x) => Math.round(x * 100) / 100;
