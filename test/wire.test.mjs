import test from "node:test";
import assert from "node:assert/strict";
import { ascii, escapeAsciiJson } from "../mods/tunr/wire.mjs";

const SAMPLES = [
  { name: "Chinese", title: "夜曲（鋼琴版）", artist: "虛構樂團" },
  { name: "Japanese", title: "蒼い夜明け〜夢の続き", artist: "架空シンガー" },
  { name: "Korean", title: "달빛 아래서", artist: "가상밴드" },
  { name: "Emoji", title: "🎵 Midnight Groove 🔥✨🎧", artist: "Synth 👨‍👩‍👧 Lab" },
  { name: "Mixed", title: "Test 世界 / ハロー / 안녕 🎶 [Live]", artist: "Alpha — Beta" },
];

test("escapeAsciiJson 輸出全為 ASCII 且 JSON.parse 完整還原非 ASCII 與 emoji", () => {
  for (const sample of SAMPLES) {
    const payload = { status: "playing", media: { status: "playing", title: sample.title, artist: sample.artist } };
    const encoded = escapeAsciiJson(JSON.stringify(payload));
    assert.match(encoded, /^[\x00-\x7f]*$/, `${sample.name} 不可包含非 ASCII 字元`);
    assert.deepEqual(JSON.parse(encoded), payload, `${sample.name} 應完整還原`);
  }
});

test("模擬引擎送出位元組經由 ascii() 與 JSON.parse 整條鏈完全還原", () => {
  for (const sample of SAMPLES) {
    const payload = {
      pos: 12.34,
      dur: 0,
      playing: true,
      isSystem: true,
      media: {
        status: "playing",
        title: sample.title,
        artist: sample.artist,
        canPlay: false,
        canPause: true,
      },
    };
    const wireText = "\x01" + escapeAsciiJson(JSON.stringify(payload)) + "\f";
    const wireBytes = Buffer.from(wireText, "utf8");

    // 刻意以小區塊切分模擬 TCP 分段送達
    let received = "";
    for (let offset = 0; offset < wireBytes.length; offset += 7) {
      received += ascii(wireBytes.subarray(offset, offset + 7));
    }

    assert.ok(received.endsWith("\f"));
    const frame = received.slice(0, -1);
    assert.ok(frame.startsWith("\x01"));
    const decoded = JSON.parse(frame.slice(1));
    assert.deepEqual(decoded, payload, `${sample.name} 整條鏈應與原本物件完全一致`);
  }
});
