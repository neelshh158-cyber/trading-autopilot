import test from "node:test";
import assert from "node:assert/strict";
import { orbSignal } from "../src/strategy/orb.mjs";
import { cfg, mk, openingRange } from "./helpers.mjs";

const c = cfg();
const D = "2026-11-03";

test("no signal while the opening range is still forming", () => {
  assert.equal(orbSignal(openingRange(D).slice(0, 2), c.strategy, c.session), null);
});

test("long on a high-volume close above the range", () => {
  const sig = orbSignal([...openingRange(D), mk(D, "09:30", 100.3, 101.2, 100.2, 101, 2000)], c.strategy, c.session);
  assert.equal(sig.side, "LONG");
  assert.equal(sig.entry, 101);
  assert.equal(sig.stop, 100); // 1% cap beats the range low at 99.5
  assert.equal(sig.target, 102.5);
});

test("short on a high-volume close below the range", () => {
  const sig = orbSignal([...openingRange(D), mk(D, "09:30", 99.8, 99.9, 98.8, 99, 2000)], c.strategy, c.session);
  assert.equal(sig.side, "SHORT");
  assert.equal(sig.entry, 99);
  assert.ok(sig.stop > 99 && sig.target < 99);
});

test("needs volume, and only the first breakout counts", () => {
  const weak = orbSignal([...openingRange(D), mk(D, "09:30", 100.3, 101.2, 100.2, 101, 1100)], c.strategy, c.session);
  assert.equal(weak, null);
  const second = orbSignal([...openingRange(D), mk(D, "09:30", 100.3, 101.2, 100.2, 101, 1100), mk(D, "09:35", 101, 101.5, 100.9, 101.3, 3000)], c.strategy, c.session);
  assert.equal(second, null);
});

test("no entries after the cut-off time", () => {
  assert.equal(orbSignal([...openingRange(D), mk(D, "14:35", 100.3, 101.2, 100.2, 101, 2000)], c.strategy, c.session), null);
});

test("a wild opening range is skipped", () => {
  const wide = [mk(D, "09:15", 100, 103, 97, 100, 1000), mk(D, "09:20", 100, 101, 99, 100, 1000), mk(D, "09:25", 100, 101, 99, 100, 1000)];
  assert.equal(orbSignal([...wide, mk(D, "09:30", 103, 104, 103, 103.5, 5000)], c.strategy, c.session), null);
});
