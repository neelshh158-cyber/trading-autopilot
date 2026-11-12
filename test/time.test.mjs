import test from "node:test";
import assert from "node:assert/strict";
import { istParts, istToEpoch, isTradingDay, hmToMinutes } from "../src/time.mjs";

test("IST round trip", () => {
  const p = istParts(new Date(istToEpoch("2026-11-03", "09:15")));
  assert.equal(p.date, "2026-11-03");
  assert.equal(p.hm, "09:15");
  assert.equal(p.minutes, hmToMinutes("09:15"));
  assert.equal(p.weekday, "Tue");
});

test("weekends and listed holidays are not trading days", () => {
  assert.equal(isTradingDay(istParts(new Date(istToEpoch("2026-11-07", "10:00")))), false); // Saturday
  assert.equal(isTradingDay(istParts(new Date(istToEpoch("2026-11-03", "10:00"))), ["2026-11-03"]), false);
  assert.equal(isTradingDay(istParts(new Date(istToEpoch("2026-11-03", "10:00")))), true);
});
