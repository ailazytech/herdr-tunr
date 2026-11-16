import test from "node:test";
import assert from "node:assert/strict";
import {
  VOLUME_THROTTLE_MS,
  clampVolume,
  volumeToGain,
  formatVolumeGain,
  buildAzmqCommand,
  escapeFilterValue,
  buildAudioFilterChain,
  buildFfplayAudioArgs,
  hasAzmqFilter,
  createThrottle,
} from "../mods/tunr/volume.mjs";

test("clampVolume 與音量換算曲線維持 0..1 線性振幅並避免浮點誤差", () => {
  assert.equal(clampVolume(0), 0);
  assert.equal(clampVolume(100), 100);
  assert.equal(clampVolume(-5), 0);
  assert.equal(clampVolume(130), 100);
  assert.equal(clampVolume("35"), 35);
  assert.equal(clampVolume(35.4, 80, { round: true }), 35);
  assert.equal(clampVolume("bad", 42), 42);
  assert.equal(clampVolume(null, 80), 80);

  assert.equal(volumeToGain(0), 0);
  assert.equal(volumeToGain(5), 0.05);
  assert.equal(volumeToGain(30), 0.3);
  assert.equal(volumeToGain(50), 0.5);
  assert.equal(volumeToGain(80), 0.8);
  assert.equal(volumeToGain(100), 1);

  assert.equal(formatVolumeGain(30), "0.3");
  assert.equal(buildAzmqCommand(0), "volume volume 0");
  assert.equal(buildAzmqCommand(35), "volume volume 0.35");
  assert.equal(buildAzmqCommand(100), "volume volume 1");
});

test("escapeFilterValue、buildAudioFilterChain 與 buildFfplayAudioArgs 正確組裝有無 azmq 的參數", () => {
  assert.equal(escapeFilterValue("tcp://127.0.0.1:5555"), "tcp\\\\://127.0.0.1\\\\:5555");

  assert.equal(
    buildAudioFilterChain({ port: 55555, volume: 30, speed: 1 }),
    "azmq=bind_address=tcp\\\\://127.0.0.1\\\\:55555,volume=0.3"
  );
  assert.equal(
    buildAudioFilterChain({ port: 55555, volume: 30, speed: 1.5 }),
    "azmq=bind_address=tcp\\\\://127.0.0.1\\\\:55555,atempo=1.5,volume=0.3"
  );
  assert.equal(buildAudioFilterChain({ port: 0, volume: 30, speed: 1 }), null);
  assert.equal(buildAudioFilterChain({ port: 0, volume: 30, speed: 2 }), "atempo=2");

  // 有 azmq 時固定 -volume 100，由 volume 濾鏡負責音量
  assert.deepEqual(
    buildFfplayAudioArgs({ source: "a.mp4", at: 12, volume: 25, speed: 1.25, port: 41234, reconnectArgs: ["-reconnect", "1"] }),
    [
      "-nodisp", "-autoexit", "-hide_banner",
      "-reconnect", "1",
      "-ss", "12", "-volume", "100",
      "-af", "azmq=bind_address=tcp\\\\://127.0.0.1\\\\:41234,atempo=1.25,volume=0.25",
      "a.mp4",
    ]
  );

  // 無 azmq 時退回原本的 -volume <0..100> 參數
  assert.deepEqual(
    buildFfplayAudioArgs({ source: "a.mp4", at: 12, volume: 25, speed: 1, port: 0 }),
    ["-nodisp", "-autoexit", "-hide_banner", "-ss", "12", "-volume", "25", "a.mp4"]
  );
});

test("hasAzmqFilter 正確辨識 ffmpeg -filters 輸出", () => {
  const sampleWith = [
    "Filters:",
    "  T.. = Timeline support",
    " .. azmq              A->A       Receive commands through ZMQ and broker them to filters.",
    " T. volume            A->A       Change input volume.",
  ].join("\n");
  const sampleWithout = [
    "Filters:",
    " .. zmq               V->V       Receive commands through ZMQ and broker them to filters.",
    " T. volume            A->A       Change input volume.",
  ].join("\n");

  assert.equal(hasAzmqFilter(sampleWith), true);
  assert.equal(hasAzmqFilter(sampleWithout), false);
  assert.equal(hasAzmqFilter(""), false);
  assert.equal(hasAzmqFilter(null), false);
});

test("createThrottle 最多每 50ms 送一次且保證送出最後一個值", () => {
  assert.equal(VOLUME_THROTTLE_MS, 50);

  let fakeNow = 0;
  let nextTimerId = 0; // 故意從 0 開始以驗證不會誤判 falsy
  const timers = new Map();
  const sent = [];

  const throttle = createThrottle({
    intervalMs: 50,
    nowFn: () => fakeNow,
    scheduleFn: (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { fn, runAt: fakeNow + ms });
      return id;
    },
    cancelFn: (id) => {
      timers.delete(id);
    },
    onSend: (v) => {
      sent.push({ t: fakeNow, v });
    },
  });

  const advanceTo = (targetMs) => {
    while (true) {
      let earliest = null;
      for (const [id, item] of timers.entries()) {
        if (item.runAt <= targetMs && (!earliest || item.runAt < earliest.runAt)) {
          earliest = { id, ...item };
        }
      }
      if (!earliest) break;
      timers.delete(earliest.id);
      fakeNow = earliest.runAt;
      earliest.fn();
    }
    fakeNow = targetMs;
  };

  // t=0 首發立即送出
  throttle.push(10);
  assert.deepEqual(sent, [{ t: 0, v: 10 }]);

  // 50ms 內連續拖動：合併成最後一個值 45，並在 t=50 送出
  fakeNow = 10; throttle.push(20);
  fakeNow = 25; throttle.push(35);
  fakeNow = 40; throttle.push(45);
  assert.equal(throttle.isPending(), true);
  assert.equal(sent.length, 1);

  advanceTo(49);
  assert.equal(sent.length, 1);

  advanceTo(50);
  assert.equal(throttle.isPending(), false);
  assert.deepEqual(sent, [{ t: 0, v: 10 }, { t: 50, v: 45 }]);

  // 相隔 >= 50ms 再送，立刻送出
  advanceTo(100);
  throttle.push(60);
  assert.deepEqual(sent, [{ t: 0, v: 10 }, { t: 50, v: 45 }, { t: 100, v: 60 }]);

  // flush 立即送出待送值；cancel 放棄待送值
  fakeNow = 110; throttle.push(70);
  fakeNow = 120; throttle.push(75);
  throttle.flush();
  assert.deepEqual(sent, [{ t: 0, v: 10 }, { t: 50, v: 45 }, { t: 100, v: 60 }, { t: 120, v: 75 }]);

  fakeNow = 130; throttle.push(80);
  throttle.cancel();
  advanceTo(200);
  assert.equal(sent.length, 4);
  assert.equal(throttle.isPending(), false);
});
