import test from "node:test";
import assert from "node:assert/strict";
import { encodeEqBands, decodeEqBands, stepDecayLevels, EQ_PREFIX } from "../mods/tunr/eq.mjs";

test("encodeEqBands 產生 ASCII \\x02 訊框並正確限幅", () => {
  const encoded = encodeEqBands([0, 0.5, 1, -0.4, 2.5, Number.NaN, Infinity]);
  assert.equal(encoded, `${EQ_PREFIX}0590900`);
  assert.equal(encodeEqBands(null), EQ_PREFIX);
  assert.equal(encodeEqBands([]), EQ_PREFIX);
});

test("decodeEqBands 正確解碼並重用長度相符的緩衝區", () => {
  const target = new Uint8Array(5);
  const res = decodeEqBands(`${EQ_PREFIX}02579`, target);
  assert.equal(res, target);
  assert.deepEqual(Array.from(res), [0, 2, 5, 7, 9]);

  // 長度不符時配置新 Uint8Array
  const resized = decodeEqBands(`${EQ_PREFIX}138`, target);
  assert.notEqual(resized, target);
  assert.ok(resized instanceof Uint8Array);
  assert.deepEqual(Array.from(resized), [1, 3, 8]);
});

test("decodeEqBands 遇不合法格式回傳 null", () => {
  assert.equal(decodeEqBands(""), null);
  assert.equal(decodeEqBands(EQ_PREFIX), null);
  assert.equal(decodeEqBands("\x011234"), null);
  assert.equal(decodeEqBands(`${EQ_PREFIX}12a4`), null);
  assert.equal(decodeEqBands(`${EQ_PREFIX}1/:9`), null);
  assert.equal(decodeEqBands(null), null);
});

test("stepDecayLevels 漸減至 cutoff 以下歸零並穩定回報 allZero", () => {
  const levels = new Float32Array([0.8, 0.06, 0]);
  const r1 = stepDecayLevels(levels, 0.75, 0.05);
  assert.equal(r1.changed, true);
  assert.equal(r1.allZero, false);
  assert.ok(Math.abs(levels[0] - 0.6) < 1e-6);
  assert.equal(levels[1], 0); // 0.06 * 0.75 = 0.045 < 0.05 -> 0
  assert.equal(levels[2], 0);

  let steps = 1;
  let last = r1;
  while (!last.allZero && steps < 50) {
    last = stepDecayLevels(levels, 0.75, 0.05);
    steps++;
  }
  assert.equal(last.allZero, true);
  assert.equal(levels[0], 0);

  const settled = stepDecayLevels(levels, 0.75, 0.05);
  assert.equal(settled.changed, false);
  assert.equal(settled.allZero, true);
});
