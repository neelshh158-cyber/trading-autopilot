// Angel One SmartAPI: login with TOTP, place INTRADAY market orders, protect each
// position with a stop-loss-market order at the exchange, read candles and funds.
//
// Endpoints follow https://smartapi.angelone.in/docs . Angel One changes field
// names now and then; `npm run login-check` exercises the read-only calls so
// problems surface before any order is placed.
import os from "node:os";
import { totp } from "../totp.mjs";
import { makeCandle } from "../data/candles.mjs";
import { orderCharges } from "../charges.mjs";
import { sleep } from "../time.mjs";

const BASE = process.env.ANGEL_BASE_URL || "https://apiconnect.angelone.in";

export function hasAngelCreds() {
  return ["ANGEL_API_KEY", "ANGEL_CLIENT_CODE", "ANGEL_MPIN", "ANGEL_TOTP_SECRET"].every((k) => process.env[k]);
}

function localIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === "IPv4" && !i.internal) return i.address;
  return "127.0.0.1";
}
function mac() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (!i.internal && i.mac && i.mac !== "00:00:00:00:00:00") return i.mac;
  return "00:00:00:00:00:01";
}

export class AngelOne {
  constructor({ charges, log = () => {} }) {
    this.charges = charges;
    this.log = log;
    this.mode = "live";
    this.jwt = null;
    this.feedToken = null;
    this.tokens = {}; // tradingsymbol -> symboltoken
  }

  headers() {
    const h = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-UserType": "USER",
      "X-SourceID": "WEB",
      "X-ClientLocalIP": localIp(),
      "X-ClientPublicIP": process.env.ANGEL_PUBLIC_IP || localIp(),
      "X-MACAddress": mac(),
      "X-PrivateKey": process.env.ANGEL_API_KEY,
    };
    if (this.jwt) h.Authorization = `Bearer ${this.jwt}`;
    return h;
  }

  async req(method, path, body) {
    const res = await fetch(BASE + path, { method, headers: this.headers(), body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    if (!res.ok || json.status === false) throw new Error(`${path}: ${json.message || res.status} (${json.errorcode || ""})`);
    return json.data;
  }

  async login() {
    const data = await this.req("POST", "/rest/auth/angelbroking/user/v1/loginByPassword", {
      clientcode: process.env.ANGEL_CLIENT_CODE,
      password: process.env.ANGEL_MPIN,
      totp: totp(process.env.ANGEL_TOTP_SECRET),
      state: "trading-autopilot",
    });
    this.jwt = data.jwtToken;
    this.feedToken = data.feedToken;
    this.refreshToken = data.refreshToken;
    this.log("Angel One: logged in");
  }

  async prepare(universe) {
    await this.login();
    for (const u of universe) await this.token(u);
  }

  async profile() {
    return this.req("GET", "/rest/secure/angelbroking/user/v1/getProfile");
  }

  async funds() {
    return this.req("GET", "/rest/secure/angelbroking/user/v1/getRMS");
  }

  async token(u) {
    if (this.tokens[u.angel]) return this.tokens[u.angel];
    const list = await this.req("POST", "/rest/secure/angelbroking/order/v1/searchScrip", { exchange: "NSE", searchscrip: u.angel.replace(/-EQ$/, "") });
    const hit = (list || []).find((s) => s.tradingsymbol === u.angel);
    if (!hit) throw new Error(`no NSE instrument named ${u.angel}`);
    this.tokens[u.angel] = String(hit.symboltoken);
    await sleep(350); // searchScrip is rate limited
    return this.tokens[u.angel];
  }

  async candles(u, date) {
    const token = await this.token(u);
    const data = await this.req("POST", "/rest/secure/angelbroking/historical/v1/getCandleData", {
      exchange: "NSE",
      symboltoken: token,
      interval: "FIVE_MINUTE",
      fromdate: `${date} 09:00`,
      todate: `${date} 15:35`,
    });
    await sleep(350); // 3 requests per second allowed
    return (data || []).map(([t, o, h, l, c, v]) => makeCandle(Date.parse(t), +o, +h, +l, +c, +v));
  }

  async ltp(u) {
    const token = await this.token(u);
    const d = await this.req("POST", "/rest/secure/angelbroking/order/v1/getLtpData", { exchange: "NSE", tradingsymbol: u.angel, symboltoken: token });
    return Number(d.ltp);
  }

  async orderBook() {
    return (await this.req("GET", "/rest/secure/angelbroking/order/v1/getOrderBook")) || [];
  }

  async positions() {
    return (await this.req("GET", "/rest/secure/angelbroking/order/v1/getPosition")) || [];
  }

  async placeOrder(o) {
    const d = await this.req("POST", "/rest/secure/angelbroking/order/v1/placeOrder", o);
    return String(d.orderid);
  }

  async cancelOrder(variety, orderid) {
    return this.req("POST", "/rest/secure/angelbroking/order/v1/cancelOrder", { variety, orderid });
  }

  // Wait for an order to fill; returns the order-book entry.
  async waitFill(orderid, seconds = 15) {
    let last;
    for (let i = 0; i < seconds; i++) {
      await sleep(1000);
      last = (await this.orderBook()).find((o) => String(o.orderid) === orderid);
      const st = (last?.status || last?.orderstatus || "").toLowerCase();
      if (st === "complete") return last;
      if (["rejected", "cancelled"].includes(st)) throw new Error(`order ${orderid} ${st}: ${last?.text || ""}`);
    }
    throw new Error(`order ${orderid} not filled after ${seconds}s (status ${last?.status})`);
  }

  async open({ u, side, qty, stop }) {
    const token = await this.token(u);
    const buy = side === "LONG";
    const orderId = await this.placeOrder({
      variety: "NORMAL",
      tradingsymbol: u.angel,
      symboltoken: token,
      transactiontype: buy ? "BUY" : "SELL",
      exchange: "NSE",
      ordertype: "MARKET",
      producttype: "INTRADAY",
      duration: "DAY",
      price: "0",
      squareoff: "0",
      stoploss: "0",
      quantity: String(qty),
    });
    const fill = await this.waitFill(orderId);
    const entryPrice = Number(fill.averageprice);
    // Safety net at the exchange: if this process dies, the stop still works.
    let slOrderId = null;
    try {
      slOrderId = await this.placeOrder({
        variety: "STOPLOSS",
        tradingsymbol: u.angel,
        symboltoken: token,
        transactiontype: buy ? "SELL" : "BUY",
        exchange: "NSE",
        ordertype: "STOPLOSS_MARKET",
        producttype: "INTRADAY",
        duration: "DAY",
        price: "0",
        triggerprice: String(stop),
        squareoff: "0",
        stoploss: "0",
        quantity: String(qty),
      });
    } catch (e) {
      this.log(`WARNING: stop order for ${u.angel} failed (${e.message}); the bot will manage the stop itself`);
    }
    return { orderId, slOrderId, entryPrice, entryCharges: orderCharges(buy ? "BUY" : "SELL", qty, entryPrice, this.charges).total };
  }

  // Move the exchange-side stop order (breakeven). If it fails the bot still
  // manages the new stop itself and the old, wider order stays as the backstop.
  async modifyStop(pos, newStop) {
    if (!pos.slOrderId) return;
    const token = await this.token({ angel: pos.angel });
    await this.req("POST", "/rest/secure/angelbroking/order/v1/modifyOrder", {
      variety: "STOPLOSS",
      orderid: pos.slOrderId,
      ordertype: "STOPLOSS_MARKET",
      producttype: "INTRADAY",
      duration: "DAY",
      price: "0",
      triggerprice: String(newStop),
      quantity: String(pos.qty),
      tradingsymbol: pos.angel,
      symboltoken: token,
      exchange: "NSE",
    });
  }

  async checkStopFilled(pos) {
    if (!pos.slOrderId) return null;
    const o = (await this.orderBook()).find((x) => String(x.orderid) === pos.slOrderId);
    const st = (o?.status || o?.orderstatus || "").toLowerCase();
    if (st === "complete") return { exitPrice: Number(o.averageprice) };
    if (["rejected", "cancelled"].includes(st)) {
      this.log(`WARNING: stop order ${pos.slOrderId} for ${pos.symbol} is ${st}; bot-managed stop only`);
      pos.slOrderId = null;
    }
    return null;
  }

  async close(pos, _refPrice, reason) {
    const token = await this.token({ angel: pos.angel });
    if (pos.slOrderId) {
      try {
        await this.cancelOrder("STOPLOSS", pos.slOrderId);
      } catch (e) {
        // It may have just filled; take that fill if so.
        const done = await this.checkStopFilled(pos);
        if (done) return done;
        this.log(`cancel stop ${pos.slOrderId}: ${e.message}`);
      }
    }
    const orderId = await this.placeOrder({
      variety: "NORMAL",
      tradingsymbol: pos.angel,
      symboltoken: token,
      transactiontype: pos.side === "LONG" ? "SELL" : "BUY",
      exchange: "NSE",
      ordertype: "MARKET",
      producttype: "INTRADAY",
      duration: "DAY",
      price: "0",
      squareoff: "0",
      stoploss: "0",
      quantity: String(pos.qty),
    });
    const fill = await this.waitFill(orderId);
    this.log(`exit ${pos.symbol} (${reason}) filled @ ${fill.averageprice}`);
    return { exitPrice: Number(fill.averageprice), orderId };
  }
}
