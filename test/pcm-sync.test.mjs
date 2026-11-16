import test from "node:test";
import assert from "node:assert/strict";
import { alignPcmWindow, computeBackpressure, PcmTimeline } from "../mods/tunr/pcm-sync.mjs";

function makeInt16Chunks(sampleValues, splitBytes = null) {
  const full = Buffer.alloc(sampleValues.length * 2);
  for (let i = 0; i < sampleValues.length; i++) {
    full.writeInt16LE(sampleValues[i], i * 2);
  }
  if (!splitBytes) return [full];
  const out = [];
  let offset = 0;
  for (const size of splitBytes) {
    if (offset >= full.length) break;
    const end = Math.min(full.length, offset + size);
    out.push(full.subarray(offset, end));
    offset = end;
  }
  if (offset < full.length) out.push(full.subarray(offset));
  return out;
}

test("alignPcmWindow 依 clockSec 取樣且絕不超前聲音", () => {
  const sampleRate = 22050;
  // 已解碼 5 秒（startTime = 0），但 clockSec 才到 1.0s
  const aligned = alignPcmWindow({
    startTime: 0,
    sampleRate,
    bufferStartSample: 0,
    totalSamples: sampleRate * 5,
    clockSec: 1.0,
    windowSamples: 2048,
  });
  assert.equal(aligned.ready, true);
  assert.equal(aligned.sliceEnd, 22050);
  assert.equal(aligned.sliceStart, 22050 - 2048);
  assert.equal(aligned.padLeft, 0);

  // 播放剛開始樣本不足一個 window 時左側補零
  const early = alignPcmWindow({
    startTime: 0,
    sampleRate,
    bufferStartSample: 0,
    totalSamples: sampleRate * 2,
    clockSec: 0.04,
    windowSamples: 2048,
  });
  const expectedEnd = Math.round(0.04 * sampleRate);
  assert.equal(early.ready, true);
  assert.equal(early.sliceStart, 0);
  assert.equal(early.sliceEnd, expectedEnd);
  assert.equal(early.padLeft, 2048 - expectedEnd);

  // 解碼落後超過 maxBehindSec 應等待而非強推舊音訊
  const lagging = alignPcmWindow({
    startTime: 0,
    sampleRate,
    bufferStartSample: 0,
    totalSamples: 1000,
    clockSec: 1.0,
    windowSamples: 2048,
    maxBehindSec: 0.35,
  });
  assert.equal(lagging.ready, false);

  // 尚未到達 startTime 時不應輸出
  const beforeStart = alignPcmWindow({
    startTime: 10,
    sampleRate,
    bufferStartSample: 0,
    totalSamples: sampleRate * 2,
    clockSec: 9.9,
    windowSamples: 2048,
  });
  assert.equal(beforeStart.ready, false);
});

test("computeBackpressure 在領先超過 2 秒暫停、低於 1 秒恢復", () => {
  const pauseState = computeBackpressure({
    startTime: 10,
    sampleRate: 22050,
    totalSamples: 22050 * 2.5,
    clockSec: 10.2, // decodedTime = 12.5, lead = 2.3s > 2.0s
  });
  assert.equal(pauseState.shouldPause, true);
  assert.equal(pauseState.shouldResume, false);

  const holdState = computeBackpressure({
    startTime: 10,
    sampleRate: 22050,
    totalSamples: 22050 * 2.0,
    clockSec: 10.5, // lead = 1.5s (遲滯帶內)
  });
  assert.equal(holdState.shouldPause, false);
  assert.equal(holdState.shouldResume, false);

  const resumeState = computeBackpressure({
    startTime: 10,
    sampleRate: 22050,
    totalSamples: 22050 * 2.0,
    clockSec: 11.2, // lead = 0.8s < 1.0s
  });
  assert.equal(resumeState.shouldPause, false);
  assert.equal(resumeState.shouldResume, true);
});

test("PcmTimeline 正確處理奇數 byte 分片、時鐘對齊與舊緩衝區清理", () => {
  const sampleRate = 1000;
  const tl = new PcmTimeline({ startTime: 10, sampleRate, keepBehindSec: 0.1 });
  // 產生 3000 筆已知值（i * 10）：前半 0..1999 較小，後半較大以辨別時間對齊
  const vals = new Array(3000);
  for (let i = 0; i < vals.length; i++) {
    vals[i] = i < 2000 ? 100 : 16384;
  }
  const chunks = makeInt16Chunks(vals, [5, 7, 1001, 2003]);
  for (const ch of chunks) tl.pushPcm16(ch);
  assert.equal(tl.totalSamples, 3000);

  // seek 到 10s 時在 clockSec=9.9 不取樣
  assert.equal(tl.getWindowForClock(9.9, 256), null);

  // clockSec = 11.5 (elapsed = 1.5s -> endSample = 1500)，全數應仍是前半 100/32768
  const wQuiet = tl.getWindowForClock(11.5, 256);
  assert.ok(wQuiet instanceof Float32Array);
  assert.equal(wQuiet.length, 256);
  for (let i = 0; i < wQuiet.length; i++) {
    assert.ok(Math.abs(wQuiet[i] - 100 / 32768) < 1e-6);
  }

  // clockSec = 12.5 (elapsed = 2.5s -> samples [2244..2500))，全數應為後半 0.5
  const wLoud = tl.getWindowForClock(12.5, 256);
  assert.ok(wLoud instanceof Float32Array);
  for (let i = 0; i < wLoud.length; i++) {
    assert.ok(Math.abs(wLoud[i] - 16384 / 32768) < 1e-6);
  }
  assert.ok(tl.bufferStartSample > 0, "舊區塊應隨 clockSec 前進被清理");
});
