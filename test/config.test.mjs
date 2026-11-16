import test from "node:test";
import assert from "node:assert/strict";
import {
  SAVED_KEYS,
  MIN_OPACITY,
  MAX_OPACITY,
  OPACITY_STEPS,
  mergeConfigText,
  parseConfigText,
  resolveStartupConfig,
  clampOpacity,
  nextOpacityStep,
  normalizeLastSource,
  DEFAULT_CONFIG,
} from "../mods/tunr/config.js";

test("只改指定的鍵且保留 debug 與不認得的鍵，格式為 2 格縮排加結尾換行", () => {
  const existing = JSON.stringify({
    debug: true,
    volume: 80,
    mode: "mono",
    size: "S",
    video: true,
    source: "old.mp4",
    customFlag: "keep-me",
    extra: { a: 1 },
  }, null, 2) + "\n";

  const out = mergeConfigText(existing, {
    volume: 50,
    mode: "low",
    size: "M",
    video: false,
    source: "system",
    debug: false, // 不在 SAVED_KEYS 內，不應覆蓋原本的 debug
    ignoredKey: 123,
  });

  assert.equal(typeof out, "string");
  assert.ok(out.endsWith("\n"));
  assert.ok(out.includes('\n  "volume": 50'));

  const parsed = JSON.parse(out);
  assert.equal(parsed.volume, 50);
  assert.equal(parsed.mode, "low");
  assert.equal(parsed.size, "M");
  assert.equal(parsed.video, false);
  assert.equal(parsed.source, "system");
  assert.equal(parsed.debug, true);
  assert.equal(parsed.customFlag, "keep-me");
  assert.deepEqual(parsed.extra, { a: 1 });
  assert.equal("ignoredKey" in parsed, false);
});

test("source 為 system、網址、Windows 路徑都正確", () => {
  const base = JSON.stringify({ debug: false });

  for (const src of [
    "system",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42",
    "C:\\Users\\user\\Videos\\測試影片.mp4",
  ]) {
    const out = mergeConfigText(base, { source: src });
    assert.ok(out !== null);
    const parsed = JSON.parse(out);
    assert.equal(parsed.source, src);
    assert.equal(parsed.debug, false);
  }
});

test("原本的檔案壞掉（不是 JSON 或非物件）時不會丟出例外，也不會寫回壞內容", () => {
  for (const broken of ["{broken json", "not json at all", "[1, 2, 3]", "123", '"str"']) {
    let result;
    assert.doesNotThrow(() => {
      result = mergeConfigText(broken, { volume: 60, size: "L" });
    });
    assert.equal(result, null);
  }
});

test("檔案不存在（null/undefined）時以空物件為基底產生設定", () => {
  const out = mergeConfigText(null, { volume: 40, mode: "low", size: "L", video: true, source: "system" });
  assert.ok(out !== null);
  assert.ok(out.endsWith("\n"));
  assert.deepEqual(JSON.parse(out), {
    volume: 40,
    mode: "low",
    size: "L",
    video: true,
    source: "system",
  });
});

test("能處理帶有 UTF-8 BOM 的既有 config.json", () => {
  const withBom = "\uFEFF" + JSON.stringify({ debug: true, volume: 80 });
  const out = mergeConfigText(withBom, { volume: 30, mode: "low" });
  assert.ok(out !== null);
  assert.deepEqual(JSON.parse(out), {
    debug: true,
    volume: 30,
    mode: "low",
  });
});

test("三層合併順序：預設值 → config.json → settings.json（只蓋五個鍵）", () => {
  const cfg = parseConfigText(JSON.stringify({
    source: "C:/a.mp4",
    size: "M",
    mode: "mono",
    video: true,
    volume: 50,
    debug: true,
  }));
  const settings = parseConfigText(JSON.stringify({
    size: "L",
    mode: "low",
    video: false,
    volume: 20,
    source: "system",
    debug: false, // 不在 SAVED_KEYS 內，不可蓋掉 config.json 的 debug
  }));

  const merged = resolveStartupConfig(cfg, settings);
  assert.equal(merged.source, "system");
  assert.equal(merged.size, "L");
  assert.equal(merged.mode, "low");
  assert.equal(merged.video, false);
  assert.equal(merged.volume, 20);
  assert.equal(merged.debug, true);
});

test("settings.json 壞掉或不存在時用 config.json；兩者都沒有時用預設值", () => {
  const cfg = parseConfigText(JSON.stringify({ source: "system", volume: 33, debug: true }));
  const brokenSettings = parseConfigText("{not valid json");
  const withCfgOnly = resolveStartupConfig(cfg, brokenSettings);
  assert.equal(withCfgOnly.source, "system");
  assert.equal(withCfgOnly.volume, 33);
  assert.equal(withCfgOnly.mode, DEFAULT_CONFIG.mode);
  assert.equal(withCfgOnly.size, DEFAULT_CONFIG.size);
  assert.equal(withCfgOnly.debug, true);

  const defaultsOnly = resolveStartupConfig(parseConfigText(null), parseConfigText("{broken"));
  assert.deepEqual(defaultsOnly, DEFAULT_CONFIG);
});

test("opacity 支援 SAVED_KEYS 寫回、三層合併與 5-100 範圍限制與步驟切換", () => {
  assert.equal(MIN_OPACITY, 5);
  assert.equal(MAX_OPACITY, 100);
  assert.deepEqual(OPACITY_STEPS, [100, 75, 50, 25, 10, 5]);
  assert.equal(clampOpacity(2), 5);
  assert.equal(clampOpacity(5), 5);
  assert.equal(clampOpacity(10), 10);
  assert.equal(clampOpacity(150), 100);
  assert.equal(clampOpacity("65.4"), 65);
  assert.equal(clampOpacity("bad", 80), 80);

  const merged = resolveStartupConfig(
    parseConfigText(JSON.stringify({ opacity: 85 })),
    parseConfigText(JSON.stringify({ opacity: 2 }))
  );
  assert.equal(merged.opacity, 5);

  const out = mergeConfigText(JSON.stringify({ debug: false }), { opacity: 5 });
  assert.deepEqual(JSON.parse(out), { debug: false, opacity: 5 });

  let step = 100;
  const seq = [];
  for (let i = 0; i < 6; i++) {
    step = nextOpacityStep(step);
    seq.push(step);
  }
  assert.deepEqual(seq, [75, 50, 25, 10, 5, 100]);
  assert.equal(nextOpacityStep(60), 50);
});

test("lastSource 支援 SAVED_KEYS 寫回、規範化與三層合併", () => {
  assert.ok(SAVED_KEYS.includes("lastSource"));
  assert.equal(normalizeLastSource("system"), null);
  assert.equal(normalizeLastSource("  "), null);
  assert.equal(normalizeLastSource(null), null);
  assert.equal(normalizeLastSource("C:\\music\\a.mp3"), "C:\\music\\a.mp3");
  assert.equal(normalizeLastSource("https://example.com/live"), "https://example.com/live");

  const merged = resolveStartupConfig(
    parseConfigText(JSON.stringify({ source: "C:/a.mp4" })),
    parseConfigText(JSON.stringify({ source: "system", lastSource: "https://example.com/v" }))
  );
  assert.equal(merged.source, "system");
  assert.equal(merged.lastSource, "https://example.com/v");

  // settings 有設定但 lastSource 為 system（非法）時會忽略；若當前 source 為檔案則補記
  const inferred = resolveStartupConfig(
    parseConfigText(JSON.stringify({ source: "C:/fallback.mp4" })),
    parseConfigText(JSON.stringify({ lastSource: "system" }))
  );
  assert.equal(inferred.lastSource, "C:/fallback.mp4");

  const saved = mergeConfigText(JSON.stringify({ debug: false }), {
    source: null,
    lastSource: "C:/song.mp3",
  });
  assert.deepEqual(JSON.parse(saved), {
    debug: false,
    source: null,
    lastSource: "C:/song.mp3",
  });
});

test("eq 預設為 true、包含在 SAVED_KEYS 且可正確儲存與覆寫", () => {
  assert.ok(SAVED_KEYS.includes("eq"));
  assert.equal(DEFAULT_CONFIG.eq, true);

  const fromDisk = resolveStartupConfig({ eq: false }, {});
  assert.equal(fromDisk.eq, false);

  const fromSettings = resolveStartupConfig({ eq: false }, { eq: true });
  assert.equal(fromSettings.eq, true);

  const saved = mergeConfigText(JSON.stringify({ eq: true }), { eq: false });
  assert.equal(JSON.parse(saved).eq, false);
});

test("speed 預設為 1、包含在 SAVED_KEYS 且支援三層合併與規範化", () => {
  assert.ok(SAVED_KEYS.includes("speed"));
  assert.equal(DEFAULT_CONFIG.speed, 1);

  const fromDisk = resolveStartupConfig({ speed: 1.5 }, {});
  assert.equal(fromDisk.speed, 1.5);

  const fromSettings = resolveStartupConfig({ speed: 1.5 }, { speed: 0.75 });
  assert.equal(fromSettings.speed, 0.75);

  const invalid = resolveStartupConfig({ speed: "bad" }, { speed: null });
  assert.equal(invalid.speed, 1);

  const saved = mergeConfigText(JSON.stringify({ speed: 1 }), { speed: 2 });
  assert.equal(JSON.parse(saved).speed, 2);
});
