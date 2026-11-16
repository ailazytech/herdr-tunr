import test from "node:test";
import assert from "node:assert/strict";
import {
  SPEED_STEPS,
  DEFAULT_SPEED,
  normalizeSpeed,
  nextSpeedStep,
  formatSpeedLabel,
  advanceMediaClock,
  audioTimestampToMediaPos,
  computePlaybackClock,
} from "../mods/tunr/speed.mjs";

test("倍速選項與左鍵往後／右鍵往回循環順序正確", () => {
  assert.deepEqual(SPEED_STEPS, [0.75, 1, 1.25, 1.5, 2]);
  assert.equal(DEFAULT_SPEED, 1);

  const forward = [];
  let cur = 1;
  for (let i = 0; i < 5; i++) {
    cur = nextSpeedStep(cur, 1);
    forward.push(cur);
  }
  assert.deepEqual(forward, [1.25, 1.5, 2, 0.75, 1]);

  const backward = [];
  cur = 1;
  for (let i = 0; i < 5; i++) {
    cur = nextSpeedStep(cur, -1);
    backward.push(cur);
  }
  assert.deepEqual(backward, [0.75, 2, 1.5, 1.25, 1]);
});

test("normalizeSpeed 與 formatSpeedLabel 處理合法、近似與無效值", () => {
  for (const s of SPEED_STEPS) {
    assert.equal(normalizeSpeed(s), s);
    assert.equal(normalizeSpeed(String(s)), s);
    assert.equal(formatSpeedLabel(s), `${s}×`);
  }

  assert.equal(normalizeSpeed(undefined), 1);
  assert.equal(normalizeSpeed(null), 1);
  assert.equal(normalizeSpeed(""), 1);
  assert.equal(normalizeSpeed(false), 1);
  assert.equal(normalizeSpeed(0), 1);
  assert.equal(normalizeSpeed(-2), 1);
  assert.equal(normalizeSpeed("bad"), 1);
  assert.equal(normalizeSpeed(NaN, 1.5), 1.5);
  assert.equal(normalizeSpeed(1.3), 1.25);
  assert.equal(normalizeSpeed(3), 2);
  assert.equal(normalizeSpeed(0.2), 0.75);
});

test("advanceMediaClock 與 audioTimestampToMediaPos 依起點、牆上時間與倍速換算媒體時間", () => {
  assert.equal(advanceMediaClock(10, 2000, 1), 12);
  assert.equal(advanceMediaClock(10, 2000, 1.5), 13);
  assert.equal(advanceMediaClock(10, 2000, 2), 14);
  assert.equal(advanceMediaClock(10, 2000, 0.75), 11.5);
  assert.equal(advanceMediaClock(5.5, -500, 2), 5.5);

  // ffplay -ss 15 報出 baseTime=10.39，經過 2.0 秒輸出時間後在 2x 等於原片 15 + 4 = 19
  assert.equal(audioTimestampToMediaPos({ at: 15, rawTime: 10.39, baseTime: 10.39, speed: 2 }), 15);
  assert.equal(audioTimestampToMediaPos({ at: 15, rawTime: 12.39, baseTime: 10.39, speed: 2 }), 19);
  assert.equal(audioTimestampToMediaPos({ at: 15, rawTime: 12.39, baseTime: 10.39, speed: 0.75 }), 16.5);
  assert.equal(audioTimestampToMediaPos({ at: 0, rawTime: 4, baseTime: 0, speed: 1.5 }), 6);
});

test("computePlaybackClock 在暫停、有音軌 clk 外推與無音軌牆上時鐘都正確套用倍速", () => {
  // 暫停時固定回傳 pos
  assert.equal(
    computePlaybackClock({
      playing: false,
      pos: 12.5,
      speed: 2,
      hasAudio: true,
      clk: { pos: 20, wall: 1000 },
      startWall: 1000,
      nowMs: 5000,
    }),
    12.5
  );

  // 有音軌且已有 clk：依 clk.pos 加上牆上時間 * speed
  assert.equal(
    computePlaybackClock({
      playing: true,
      pos: 0,
      speed: 1.5,
      hasAudio: true,
      clk: { pos: 10, wall: 2000 },
      startWall: 1000,
      nowMs: 2400,
    }),
    10.6
  );

  // 有音軌但 clk 尚未回報（4 秒內等待 ffplay）：停在起點 pos
  assert.equal(
    computePlaybackClock({
      playing: true,
      pos: 8,
      speed: 2,
      hasAudio: true,
      clk: null,
      startWall: 1000,
      nowMs: 2000,
    }),
    8
  );

  // 有音軌但超過 4 秒仍無 clk：退回牆上時間 * speed
  assert.equal(
    computePlaybackClock({
      playing: true,
      pos: 8,
      speed: 2,
      hasAudio: true,
      clk: null,
      startWall: 1000,
      nowMs: 6000,
    }),
    18
  );

  // 無音軌時直接使用牆上時間 * speed
  assert.equal(
    computePlaybackClock({
      playing: true,
      pos: 3,
      speed: 0.75,
      hasAudio: false,
      clk: null,
      startWall: 1000,
      nowMs: 5000,
    }),
    6
  );
  assert.equal(
    computePlaybackClock({
      playing: true,
      pos: 3,
      speed: 2,
      hasAudio: false,
      clk: null,
      startWall: 1000,
      nowMs: 5000,
    }),
    11
  );
});
