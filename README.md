# Trading autopilot

A rule-based intraday trading bot for NSE stocks with a hard money-management
layer: a config file, a `data/` folder that remembers everything, and a GitHub
Actions workflow. It lives in its own public repository because public repos get
unlimited free Actions minutes; the paper bot needs about 8,000 a month. **It ships in paper mode.**
Live mode exists, is gated behind several locks, and should only be switched on
after the paper results have earned it.

## Read this first: what to expect

Please read this paragraph before anything else, because the plan rests on it.

- SEBI's own study of ~7 million intraday traders found that **about 7 in 10
  lost money**, 8 in 10 among frequent traders, and that the losers paid
  trading charges worth a further 57% of their losses on top
  ([SEBI study, July 2024](https://www.business-standard.com/amp/markets/news/7-in-10-intraday-traders-in-equity-cash-suffered-losses-in-fy23-sebi-study-124072400975_1.html)).
  A bot does not change those odds by itself. It only makes you disciplined
  and tireless, which is worth something, but it is not an edge.
- Nobody, including this bot and the AI that wrote it, can promise a profit.
  The honest promise is different: **you will never lose more than ₹5,000**,
  the deposit is locked away as soon as there is a profit cushion, and every
  rule is enforced by code, not by mood.
- ₹10,000 is a small account. Without leverage a ₹1,400 stock lets you hold
  7 shares, so the realistic daily swing is tens of rupees, not thousands.
  The bot sizes positions by risk, not by hope.
- The strategy included (opening range breakout) is a well-known, honest
  baseline. On random data it loses slightly, as it should. Whether it earns
  on real data is exactly what the backtest and the paper month are for.
- Taxes: intraday profit is "speculative business income" in India, filed in
  ITR-3, and losses can only be set off against speculative gains. Keep
  `data/trades.json`; it is your trade log.

If after reading that you still want to run it, the rest of this file gets
you there safely.

## Platform: Angel One SmartAPI

The brokers with usable APIs for an individual in India are Zerodha (Kite
Connect), Angel One (SmartAPI), Dhan, Fyers and Upstox. Chosen: **Angel One**.

| Broker | API fee | Live + historical data | Daily login | Notes |
| --- | --- | --- | --- | --- |
| **Angel One SmartAPI** | free | free | TOTP, can be automated | Everything a bot needs at ₹0, static-IP whitelisting supported, long-running retail API programme |
| Zerodha Kite Connect | personal plan free, but no market data; ₹500/month with data ([Zerodha](https://zerodha.com/z-connect/updates/free-personal-apis-from-kite-connect)) | paid | browser login; automating it is not officially supported | Most reliable broker; the login step is the problem for a hands-off bot |
| Dhan | free | data API ₹499/month ([Dhan](https://dhanhq.co/trading-apis)) | long-lived token | Good API; sandbox is not a paper-trading simulator |
| Fyers | free | free | daily 2FA | Terms say the API is "not meant for fully automated trades" without regulator approval ([Fyers API terms](https://fyers.in/terms-and-conditions-api)) |
| Upstox | free, but a fee per API order | free | daily token | Reliability complaints in reviews |

Sources: [broker API charges comparison 2026](https://cernoquant.com/blog/broker-api-charges-comparison),
[best brokers for algo trading 2026](https://algotest.in/blog/best-brokers-for-algo-trading-in-india/),
[Zerodha Kite Connect FAQ](https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/kite-connect-api-faqs).

The code talks to Angel One through a small adapter (`src/broker/angelone.mjs`),
so another broker can be added later without touching the strategy or the
money rules.

## The rules SEBI makes you follow (since 1 April 2026)

SEBI's retail algo framework applies to every broker since April 2026
([Fyers summary](https://fyers.in/community/blogs-gdppin8d/post/sebi-s-new-algo-trading-rules-kick-in-on-april-1-here-is-what-changes-Yew3vdG4CgoXk1q),
[AlgoTest explainer](https://algotest.in/blog/what-is-a-static-ip/),
[Sahi explainer](https://www.sahi.com/blogs/sebi-algo-trading-rules-2026-what-every-retail-trader-must-know-before-april)).
What it means for this bot:

1. **Static IP.** API orders are accepted only from an IP address you have
   registered with the broker. GitHub Actions runners change IP every run, so
   **live mode cannot run on GitHub Actions**. It runs on a small cloud
   server with a fixed IP (Oracle Cloud's free tier in Mumbai, or any
   ₹300–500/month VPS in India).
2. **Daily 2FA.** Every session starts with a fresh TOTP login. The bot does
   this itself from the TOTP secret; that is the officially supported flow.
3. **Under 10 orders per second** needs no algo registration. This bot places
   at most a handful of orders per day.
4. **Your own API key, your own account.** No third-party bridges, no sharing
   keys, no running someone else's strategy through your account.

Verify the current wording on your broker's API page before going live; these
rules were new in 2026 and brokers were still adjusting their terms.

## The money rules (all in `config.json` → `money`)

| Rule | Default | What the code does |
| --- | --- | --- |
| deposit | ₹10,000 | Starting equity of the ledger |
| maxLoss | ₹5,000 | **Hard stop.** Equity ≤ ₹5,000 halts trading permanently (needs a manual `resume`) |
| protectPrincipalAfterProfit | ₹1,500 | Once realised profit reaches this, the floor moves up to ₹10,000: from then on **only profit is at risk**. If the cushion is lost, trading halts with the deposit intact |
| riskPerTradePct | 1% of risk capital | Risk capital = equity − floor. With ₹10,000 and a ₹5,000 floor that is ₹50 per trade |
| minRiskPerTrade | ₹25 | Below this a trade is not worth its charges; the bot waits |
| maxChargesPctOfRisk | 35% | Skip any trade whose round-trip charges would eat more than this share of the risk |
| maxDailyLossPct | 2% | Lose 2% of the day's starting equity and the bot stops for the day |
| maxTradesPerDay | 4 | |
| maxOpenPositions | 1 | |
| leverage | 1 | Intraday (MIS) margin lets brokers lend up to 5x. Leave it at 1 until the paper results justify more |

Plus three switches that beat every rule:

- `npm run kill` writes `data/KILL`; the running bot closes everything on its
  next tick and opens nothing. `npm run resume` lifts it. Committing the KILL
  file also stops the GitHub Actions paper runs.
- `TRADING_KILL=1` in the environment does the same.
- A halted ledger stays halted until you run `npm run resume`
  (`--allow-principal=true` also lowers the floor back to deposit − maxLoss;
  think twice).

## How a trading day goes

1. 09:15–09:30: watch the first 15 minutes of each stock in `universe`
   (12 large, liquid NSE names). Note the high and low.
2. 09:30–14:30: the first 5-minute candle that **closes outside that range on
   at least 1.2x the opening volume** is the signal. Long above, short below.
   Stop at the other side of the range (clamped to 0.3–1% of price), target
   at 1.5x the stop distance. One signal per stock per day; best volume first.
   With `strategy.breakevenAfterR` set (e.g. 1), the stop moves to just past
   the entry once the trade is that many risk-units in profit, and the
   exchange-side stop order is modified to match.
3. Risk layer sizes the position or refuses it. In live mode a
   stop-loss-market order is placed at the exchange immediately, so the stop
   holds even if the server dies.
4. Exits: stop, target, or square-off at 15:10. Angel One auto-squares
   intraday positions around 15:20 anyway.
5. Everything is written to `data/state.json` (ledger, open positions) and
   `data/trades.json` (every closed trade). A run that is interrupted picks
   up where it stopped.

Strategy parameters are in `config.json` → `strategy`. Adding a strategy means
one pure function `(candles, strategyCfg, session) → signal | null` in
`src/strategy/` registered in the `strategies` map.

## Step 0: backtest (today, no account needed)

```bash
npm test                      # 27 tests on the money rules, charges, strategy, engine
npm run backtest              # last 60 days of 5-minute candles from Yahoo Finance
npm run backtest -- --days=30 --verbose
npm run backtest -- --csv=path/to/csvs   # your own data: SYMBOL.csv, timestamp,open,high,low,close,volume
```

Yahoo only serves 60 days of 5-minute history, which is thin. Once you have
an Angel One login, `npm run login-check` proves the credentials and the
Angel One candle API gives longer history (wire it into `backtest` when
needed; the adapter already has `candles()`).

`npm run sweep` runs a grid of sensible variants (range length, volume filter,
target size, stop size, breakeven stop on/off, shorts on/off, entry cut-off) on
the same data and lists which, if any, finish positive after charges. It is a
sanity check, not a tuning tool: 60 days is far too little to tune on.

Judge the backtest on: net P&L after charges, max drawdown, win rate against
avg win / avg loss, and how often the daily stop fires. If it is negative over
60 days, do not paper trade it, change it.

## Step 1: paper trade for at least a month (GitHub Actions, free)

Already set up in `.github/workflows/trading-paper.yml`. Enable Actions on the
repo and it runs every weekday in two shifts, trading on live Yahoo prices
with a simulated broker, committing the ledger back after each shift.

- `Actions → Trading autopilot (paper) → Run workflow` with once = `true`
  for a smoke test.
- `npm run status` (or read `data/state.json`) shows equity, floor, open
  positions, the last trades and the day-by-day record.
- Add NSE holidays to `config.json` → `session.holidays` as `YYYY-MM-DD`;
  on a holiday there are simply no candles and the bot idles.

The paper month is the real test. Do not go live if the paper ledger is below
₹10,000 at the end of it.

## Step 2: going live (only after step 1 is positive)

1. **Angel One account** with funds, and the trading MPIN set.
2. **API app**: https://smartapi.angelone.in → Create an app of type
   *Trading API*. Copy the API key.
3. **TOTP**: https://smartapi.angelone.in/enable-totp → copy the base32 secret
   shown under the QR code (keep it like a password).
4. **Server with a static IP**: Oracle Cloud free tier (Mumbai region) or any
   Indian VPS. Install Node 20+, clone this repo.
5. **Whitelist the server's IP** in the SmartAPI app settings (the static IP
   requirement above). Set `ANGEL_PUBLIC_IP` to the same address in `.env`.
6. `cp .env.example .env`, fill `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`,
   `ANGEL_MPIN`, `ANGEL_TOTP_SECRET`.
7. `npm run login-check`: logs in, prints profile, funds, one price and
   today's candles. **Places no orders.** Fix anything it complains about.
8. Reset the paper ledger so live starts from the real deposit:
   `node src/index.mjs reset-paper --yes`. Set `money.deposit` to the amount
   actually in the account.
9. Add `LIVE_TRADING_ACK="I UNDERSTAND REAL MONEY"` to `.env`.
10. Schedule it. With cron on the server (times are IST):
    ```
    5 9 * * 1-5  cd /path/to/trading-autopilot && npm run live >> live.log 2>&1
    ```
    The process exits by itself after the close. Also keep `npm run kill`
    one SSH command away.

First live week: keep the defaults (no leverage, 1 position, ₹50 risk). Check
`npm run status` and the Angel One app every evening and make sure both agree.

## Commands

```bash
npm run paper                 # paper trade today's session with Yahoo prices (needs no account)
npm run paper -- --data=angel # paper trade with Angel One prices (needs login)
npm run live                  # real orders; needs .env and LIVE_TRADING_ACK
npm run backtest              # replay history through the same engine
npm run status                # ledger, positions, last trades
npm run login-check           # verify Angel One credentials, read-only
npm run kill / npm run resume # the big red button
npm test
```

## Files

```
config.json            money rules, session times, strategy parameters, stock universe, charge rates
src/index.mjs          CLI and the market-hours loop
src/engine.mjs         one tick: candles → manage positions → maybe open → save
src/risk.mjs           the money rules (read this one)
src/strategy/orb.mjs   opening range breakout
src/broker/paper.mjs   simulated fills with slippage and real charges
src/broker/angelone.mjs Angel One SmartAPI: login, orders, exchange stop orders, candles
src/data/yahoo.mjs     free candles for paper and backtests
src/data/csv.mjs       your own candle files
src/charges.mjs        brokerage, STT, exchange, SEBI, GST, stamp duty
src/totp.mjs           the 2FA code generator
data/state.json        ledger and open positions (committed by the paper workflow)
data/trades.json       every closed trade
```

## Known limits

- Built and tested without access to the live Angel One API (the development
  sandbox had no outbound network). Field names follow the SmartAPI docs;
  `npm run login-check` is there to catch any drift before an order exists.
- Paper mode uses Yahoo prices, which can lag a minute or two; paper fills
  are therefore slightly optimistic. Live uses the broker's own candles.
- Exits are evaluated on completed 5-minute candles plus the exchange-side
  stop order. Inside a candle the exchange stop is the only protection, which
  is why it is placed immediately after every entry.
- Charge rates in `config.json` are the discount-broker intraday schedule as
  of 2026. Check them against your contract note after the first live day.
