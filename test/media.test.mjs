import test from "node:test";
import assert from "node:assert/strict";
import { parseMediaLine, formatMediaLabel, mediaButtonStates } from "../mods/tunr/media.mjs";

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
