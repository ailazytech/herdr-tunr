import test from "node:test";
import assert from "node:assert/strict";
import {
  TAG_RATE,
  TAG_PCM,
  TAG_MEDIA,
  encodeSystemFrame,
  createSystemStreamParser,
} from "../mods/tunr/system-stream.mjs";

test("同一段 chunk 同時包含 rate、PCM 與 media JSON 也能準確分離解析", () => {
  const parser = createSystemStreamParser();
  const pcm1 = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x7f, 0x80]);
  const pcm2 = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
  const mediaJson = JSON.stringify({
    title: "夜に駆ける",
    artist: "YOASOBI",
    app: "chrome.exe",
    status: "playing",
    canPause: true,
    canPlay: false,
    canNext: true,
    canPrev: true,
  }) + "\n";

  const combined = Buffer.concat([
    encodeSystemFrame(TAG_RATE, "48000"),
    encodeSystemFrame(TAG_PCM, pcm1),
    encodeSystemFrame(TAG_MEDIA, mediaJson),
    encodeSystemFrame(TAG_PCM, pcm2),
  ]);

  const events = parser.push(combined);
  assert.equal(events.length, 4);
  assert.deepEqual(events[0], { type: "rate", sampleRate: 48000 });
  assert.equal(events[1].type, "pcm");
  assert.ok(events[1].data.equals(pcm1));
  assert.equal(events[2].type, "media");
  assert.deepEqual(events[2].media, {
    title: "夜に駆ける",
    artist: "YOASOBI",
    app: "chrome.exe",
    status: "playing",
    canPlay: false,
    canPause: true,
    canNext: true,
    canPrev: true,
  });
  assert.equal(events[3].type, "pcm");
  assert.ok(events[3].data.equals(pcm2));
});

test("分框與 JSON 行在任意位元組（包含 1 byte 與非 ASCII UTF-8 半截）切斷時仍能安全還原", () => {
  const parser = createSystemStreamParser();
  const pcm = Buffer.alloc(64);
  for (let i = 0; i < pcm.length; i++) pcm[i] = i & 0xff;

  const fullMediaBuf = Buffer.from(
    JSON.stringify({
      title: "繁體中文歌名🎵測試",
      artist: "歌手名稱",
      app: "msedge.exe",
      status: "paused",
      canPlay: true,
      canPause: false,
      canNext: false,
      canPrev: true,
    }) + "\n",
    "utf8"
  );
  // 故意將 UTF-8 編碼在多字節（繁體中文／🎵 emoji）中間拆成兩包 TAG_MEDIA 框，並以每 1 byte 送入解析器
  const emojiOffset = fullMediaBuf.indexOf(Buffer.from("🎵", "utf8")) + 2;
  const partA = fullMediaBuf.subarray(0, emojiOffset);
  const partB = fullMediaBuf.subarray(emojiOffset);

  const wire = Buffer.concat([
    encodeSystemFrame(TAG_RATE, "44100"),
    encodeSystemFrame(TAG_MEDIA, partA),
    encodeSystemFrame(TAG_PCM, pcm),
    encodeSystemFrame(TAG_MEDIA, partB),
  ]);

  const collected = [];
  for (let i = 0; i < wire.length; i++) {
    collected.push(...parser.push(wire.subarray(i, i + 1)));
  }

  const rates = collected.filter((e) => e.type === "rate");
  const pcms = collected.filter((e) => e.type === "pcm");
  const medias = collected.filter((e) => e.type === "media");

  assert.equal(rates.length, 1);
  assert.equal(rates[0].sampleRate, 44100);
  assert.equal(pcms.length, 1);
  assert.ok(pcms[0].data.equals(pcm));
  assert.equal(medias.length, 1);
  assert.equal(medias[0].media.title, "繁體中文歌名🎵測試");
  assert.equal(medias[0].media.artist, "歌手名稱");
  assert.equal(medias[0].media.status, "paused");
  assert.equal(medias[0].media.canPlay, true);
  assert.equal(medias[0].media.canPrev, true);
});

test("壞掉的 JSON 與雜訊前導位元組不會影響後續合法分框解析", () => {
  const parser = createSystemStreamParser();
  const pcmAfter = Buffer.from([0x10, 0x20, 0x30, 0x40]);
  const badAndGood = Buffer.concat([
    Buffer.from("noise-before-frame"),
    encodeSystemFrame(TAG_MEDIA, "{broken json\n"),
    encodeSystemFrame(TAG_MEDIA, JSON.stringify({ title: "", artist: "", status: "stopped" }) + "\n"),
    encodeSystemFrame(TAG_PCM, pcmAfter),
  ]);

  const events = parser.push(badAndGood);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "media");
  assert.equal(events[0].media.status, "stopped");
  assert.equal(events[1].type, "pcm");
  assert.ok(events[1].data.equals(pcmAfter));
});
