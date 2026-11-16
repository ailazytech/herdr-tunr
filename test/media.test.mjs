import test from "node:test";
import assert from "node:assert/strict";
import { parseMediaLine, formatMediaLabel, mediaButtonStates, displayWidth, truncateByWidth } from "../mods/tunr/media.mjs";

test("parseMediaLine parses valid SMTC JSON lines and normalizes fields", () => {
  const parsed = parseMediaLine(
    '  {"status":"playing","title":"  Song A ","artist":"Artist B","app":"Player","canPlay":false,"canPause":true,"canNext":true,"canPrev":false}\n'
  );
  assert.deepEqual(parsed, {
    status: "playing",
    title: "Song A",
    artist: "Artist B",
    app: "Player",
    canPlay: false,
    canPause: true,
    canNext: true,
    canPrev: false,
  });

  const noneStatus = parseMediaLine('{"status":"unknown","title":123}');
  assert.deepEqual(noneStatus, {
    status: "none",
    title: "",
    artist: "",
    app: "",
    canPlay: false,
    canPause: false,
    canNext: false,
    canPrev: false,
  });
});

test("parseMediaLine returns null on incomplete, broken, or non-object input", () => {
  assert.equal(parseMediaLine(null), null);
  assert.equal(parseMediaLine(""), null);
  assert.equal(parseMediaLine('{"status":"playing"'), null);
  assert.equal(parseMediaLine('{"status":}'), null);
  assert.equal(parseMediaLine("[1,2,3]"), null);
  assert.equal(parseMediaLine('"hello"'), null);
});

test("formatMediaLabel formats title/artist, falls back, and truncates with ellipsis", () => {
  assert.equal(formatMediaLabel(null, "System audio"), "System audio");
  assert.equal(formatMediaLabel({ status: "none", title: "Song", artist: "Artist" }, "System audio"), "System audio");
  assert.equal(formatMediaLabel({ status: "playing", title: "", artist: "" }, "System audio"), "System audio");
  assert.equal(
    formatMediaLabel({ status: "playing", title: "Track", artist: "Band" }, "System audio"),
    "Track — Band"
  );
  assert.equal(formatMediaLabel({ status: "paused", title: "Only Title", artist: "" }, "System audio"), "Only Title");
  assert.equal(formatMediaLabel({ status: "paused", title: "", artist: "Only Artist" }, "System audio"), "Only Artist");
  assert.equal(
    formatMediaLabel({ status: "playing", title: "Very Long Song Title", artist: "Very Long Artist" }, "System audio", 10),
    "Very Long…"
  );
});

test("mediaButtonStates computes session, toggle, prev, and next states", () => {
  assert.deepEqual(mediaButtonStates(null), {
    hasSession: false,
    isPlaying: false,
    canToggle: true,
    canPrev: false,
    canNext: false,
  });
  assert.deepEqual(mediaButtonStates({ status: "none", canPlay: true, canNext: true }), {
    hasSession: false,
    isPlaying: false,
    canToggle: true,
    canPrev: false,
    canNext: false,
  });
  assert.deepEqual(
    mediaButtonStates({
      status: "playing",
      canPlay: true,
      canPause: false,
      canPrev: true,
      canNext: false,
    }),
    {
      hasSession: true,
      isPlaying: true,
      canToggle: false,
      canPrev: true,
      canNext: false,
    }
  );
  assert.deepEqual(
    mediaButtonStates({
      status: "paused",
      canPlay: true,
      canPause: false,
      canPrev: false,
      canNext: true,
    }),
    {
      hasSession: true,
      isPlaying: false,
      canToggle: true,
      canPrev: false,
      canNext: true,
    }
  );
});

const hasLoneSurrogate = (s) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
};

test("displayWidth 與 truncateByWidth 依等寬格數計算且不切破全形字與 emoji", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("中文"), 4);
  assert.equal(displayWidth("あいう"), 6);
  assert.equal(displayWidth("한글"), 4);
  assert.equal(displayWidth("🎵🔥"), 4);
  assert.equal(displayWidth("A中🎵"), 5);

  const cases = [
    { label: { status: "playing", title: "中文長歌名測試", artist: "虛構演出者" }, max: 10 },
    { label: { status: "playing", title: "あいうえおかきく", artist: "歌手" }, max: 9 },
    { label: { status: "playing", title: "가나다라마바사", artist: "밴드" }, max: 8 },
    { label: { status: "playing", title: "AB🎵CD🔥EF", artist: "" }, max: 5 },
    { label: { status: "playing", title: "A🎵B🎶C", artist: "" }, max: 4 },
    { label: { status: "playing", title: "家庭 👨‍👩‍👧 合唱", artist: "" }, max: 8 },
  ];

  for (const { label, max } of cases) {
    const out = formatMediaLabel(label, "System audio", max);
    assert.ok(displayWidth(out) <= max, `寬度不應超過 ${max}，實際=${displayWidth(out)} (${out})`);
    assert.equal(hasLoneSurrogate(out), false, `不應產生孤立代理對 (${out})`);
    assert.ok(out.endsWith("…"), `應以省略號結尾 (${out})`);
  }

  assert.equal(truncateByWidth("你好世界", 8), "你好世界");
  assert.equal(truncateByWidth("AB🎵CD", 4), "AB…");
  assert.equal(truncateByWidth("AB🎵CD", 5), "AB🎵…");
});
