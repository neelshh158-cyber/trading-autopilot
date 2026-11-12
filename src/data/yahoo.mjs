// Free 5-minute NSE candles from Yahoo Finance's chart endpoint. Good enough for
// paper trading and for backtests over the last ~60 days (Yahoo's limit for 5m).
// Not for live money: it can lag by a minute or two and has no uptime promise.
//
// Yahoo answers 429 to anonymous requests, so we first collect a session cookie
// and a "crumb" token the way the website does, and retry with backoff.
import fs from "node:fs";
import path from "node:path";
import { makeCandle } from "./candles.mjs";
import { DATA_DIR } from "../config.mjs";
import { sleep, istParts } from "../time.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
let session = null; // { cookie, crumb }

async function getSession(fresh = false) {
  if (session && !fresh) return session;
  const r1 = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
  const setCookies = typeof r1.headers.getSetCookie === "function" ? r1.headers.getSetCookie() : [r1.headers.get("set-cookie") || ""];
  const cookie = setCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  if (!cookie) throw new Error("yahoo: no session cookie");
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: cookie } });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.includes("<")) throw new Error(`yahoo: no crumb (HTTP ${r2.status})`);
  session = { cookie, crumb };
  return session;
}

export async function fetchYahooCandles(yahooSymbol, { interval = "5m", range = "1d" } = {}) {
  const base = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(2000 * 2 ** (attempt - 1));
    const headers = { "User-Agent": UA, Accept: "application/json" };
    let url = base;
    try {
      const s = await getSession(attempt > 0);
      headers.Cookie = s.cookie;
      url += `&crumb=${encodeURIComponent(s.crumb)}`;
    } catch (e) {
      lastErr = e; // try without a session; sometimes that still works
    }
    const res = await fetch(url, { headers });
    if (res.status === 429 || res.status === 401 || res.status >= 500) {
      lastErr = new Error(`yahoo ${yahooSymbol}: HTTP ${res.status}`);
      continue;
    }
    if (!res.ok) throw new Error(`yahoo ${yahooSymbol}: HTTP ${res.status}`);
    const json = await res.json();
    const r = json?.chart?.result?.[0];
    if (!r) throw new Error(`yahoo ${yahooSymbol}: ${json?.chart?.error?.description || "no data"}`);
    const q = r.indicators?.quote?.[0] || {};
    const out = [];
    (r.timestamp || []).forEach((t, i) => {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
      if ([o, h, l, c].some((x) => x == null)) return;
      out.push(makeCandle(t * 1000, o, h, l, c, v ?? 0));
    });
    return out;
  }
  throw lastErr || new Error(`yahoo ${yahooSymbol}: gave up`);
}

export class YahooData {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.cache = new Map(); // symbol -> { at, candles }
  }
  // Candles for one symbol on one date; re-fetched at most every 20 s. A past
  // date (a position left over from an interrupted run) needs a wider window.
  async candles(u, date) {
    const range = date === istParts().date ? "1d" : "5d";
    const key = `${u.yahoo}:${range}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 20_000) return hit.candles.filter((k) => k.date === date);
    const candles = await fetchYahooCandles(u.yahoo, { range });
    this.cache.set(key, { at: Date.now(), candles });
    await sleep(250); // be polite between symbols
    return candles.filter((k) => k.date === date);
  }
}

// History for backtests, cached on disk for a day.
export async function yahooHistory(u, { range = "60d", log = () => {} } = {}) {
  const dir = path.join(DATA_DIR, "cache");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${u.yahoo}-5m-${range}-${new Date().toISOString().slice(0, 10)}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const candles = await fetchYahooCandles(u.yahoo, { interval: "5m", range });
  fs.writeFileSync(file, JSON.stringify(candles));
  log(`${u.symbol}: ${candles.length} candles from Yahoo`);
  await sleep(500);
  return candles;
}
