import test from "node:test";
import assert from "node:assert/strict";
import { totp, base32Decode } from "../src/totp.mjs";

// RFC 6238 test vectors (SHA-1, secret "12345678901234567890").
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("base32 decodes the RFC secret", () => {
  assert.equal(base32Decode(SECRET).toString("ascii"), "12345678901234567890");
});

test("matches the RFC 6238 vectors", () => {
  assert.equal(totp(SECRET, { time: 59 * 1000, digits: 8 }), "94287082");
  assert.equal(totp(SECRET, { time: 1111111109 * 1000, digits: 8 }), "07081804");
  assert.equal(totp(SECRET, { time: 1234567890 * 1000, digits: 8 }), "89005924");
  assert.equal(totp(SECRET, { time: 59 * 1000 }), "287082");
});
