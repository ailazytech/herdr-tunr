import test from "node:test";
import assert from "node:assert/strict";
import {
  EARLY_END_MARGIN_SEC,
  MAX_STREAM_RETRIES,
  SUCCESS_PLAY_RESET_MS,
  RECONNECT_INPUT_ARGS,
  isHttpSource,
  evaluateAudioExit,
} from "../mods/tunr/playback-exit.mjs";

test("isHttpSource 僅對 http(s) 網址為 true，本機檔案與 system 為 false", () => {
  assert.equal(isHttpSource("https://example.com/stream.mp4"), true);
  assert.equal(isHttpSource("http://127.0.0.1:8080/a.mp4"), true);
  assert.equal(isHttpSource("HTTPS://youtu.be/abc"), true);
  assert.equal(isHttpSource("C:\\Videos\\a.mp4"), false);
  assert.equal(isHttpSource("/tmp/a.mp3"), false);
  assert.equal(isHttpSource("system"), false);
  assert.equal(isHttpSource(null), false);
  assert.deepEqual(RECONNECT_INPUT_ARGS, [
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_delay_max", "5",
  ]);
});

test("evaluateAudioExit 正確分辨真播完、提前中斷續播與超過 3 次失敗", () => {
  assert.equal(EARLY_END_MARGIN_SEC, 2);
  assert.equal(MAX_STREAM_RETRIES, 3);
  assert.equal(SUCCESS_PLAY_RESET_MS, 10_000);

  // 1. 正常播到結尾（離 dur 小於 2 秒且 exit code = 0）-> 播完
  assert.deepEqual(
    evaluateAudioExit({
      clock: 253.5,
      dur: 255,
      code: 0,
      retries: 2,
      lastSuccessAtMs: 1000,
      nowMs: 254500,
      hasClk: true,
    }),
    { action: "ended", nextRetries: 0 }
  );

  // 2. YouTube 串流中途以 code = 0 提早結束（186s / 255s）-> 從 186s 接著播
  assert.deepEqual(
    evaluateAudioExit({
      clock: 186,
      dur: 255,
      code: 0,
      retries: 0,
      lastSuccessAtMs: 1000,
      nowMs: 187000,
      hasClk: true,
      extracted: true,
    }),
    { action: "retry", resumeAt: 186, nextRetries: 1, refreshUrl: false }
  );

  // 3. 同一位置附近連續失敗（未滿 10 秒或未取得 clk）累積到 3 次後回報 playFailed
  const r1 = evaluateAudioExit({
    clock: 186,
    dur: 255,
    code: 1,
    retries: 0,
    lastSuccessAtMs: 0,
    nowMs: 1000,
    hasClk: false,
    extracted: true,
  });
  assert.deepEqual(r1, { action: "retry", resumeAt: 186, nextRetries: 1, refreshUrl: true });

  const r2 = evaluateAudioExit({
    clock: 186.2,
    dur: 255,
    code: 0,
    retries: r1.nextRetries,
    lastSuccessAtMs: 1500,
    nowMs: 4000, // 僅播 2.5 秒 (< 10 秒)，不可歸零
    hasClk: true,
    extracted: true,
  });
  assert.deepEqual(r2, { action: "retry", resumeAt: 186.2, nextRetries: 2, refreshUrl: true });

  const r3 = evaluateAudioExit({
    clock: 186.2,
    dur: 255,
    code: 1,
    retries: r2.nextRetries,
    lastSuccessAtMs: 0,
    nowMs: 20000, // hasClk=false，即使經過 20 秒也不可歸零
    hasClk: false,
    extracted: true,
  });
  assert.deepEqual(r3, { action: "retry", resumeAt: 186.2, nextRetries: 3, refreshUrl: true });

  const fail = evaluateAudioExit({
    clock: 186.2,
    dur: 255,
    code: 1,
    retries: r3.nextRetries,
    lastSuccessAtMs: 20500,
    nowMs: 22000,
    hasClk: true,
    extracted: true,
  });
  assert.deepEqual(fail, { action: "fail", error: "playFailed", nextRetries: 3 });

  // 4. 正常播放超過 10 秒後再斷線，會先把重試次數歸零
  const resetAfterSuccess = evaluateAudioExit({
    clock: 210,
    dur: 255,
    code: 0,
    retries: 3,
    lastSuccessAtMs: 100_000,
    nowMs: 112_000, // 12 秒 >= 10 秒
    hasClk: true,
    extracted: true,
  });
  assert.deepEqual(resetAfterSuccess, {
    action: "retry",
    resumeAt: 210,
    nextRetries: 1,
    refreshUrl: false,
  });

  // 5. 即使離 dur < 2 秒，exit code 非 0 仍不算播完
  assert.deepEqual(
    evaluateAudioExit({
      clock: 254.5,
      dur: 255,
      code: 1,
      retries: 3,
      lastSuccessAtMs: 0,
      nowMs: 5000,
      hasClk: false,
    }),
    { action: "fail", error: "playFailed", nextRetries: 3 }
  );
});

test("evaluateAudioExit 在無時長來源（dur = 0）維持既有判斷", () => {
  assert.deepEqual(
    evaluateAudioExit({
      clock: 30,
      dur: 0,
      code: 0,
      retries: 0,
      hasClk: true,
      extracted: true,
    }),
    { action: "ended", nextRetries: 0 }
  );

  assert.deepEqual(
    evaluateAudioExit({
      clock: 0,
      dur: 0,
      code: 0,
      retries: 0,
      hasClk: false,
      extracted: true,
    }),
    { action: "retry", resumeAt: 0, nextRetries: 1, refreshUrl: true }
  );

  assert.deepEqual(
    evaluateAudioExit({
      clock: 15,
      dur: 0,
      code: 1,
      retries: 3,
      hasClk: false,
      extracted: false,
    }),
    { action: "fail", error: "playFailed", nextRetries: 3 }
  );
});
