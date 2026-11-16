import test from "node:test";
import assert from "node:assert/strict";
import {
  nextGeneration,
  isCurrentGeneration,
  shouldAbortConnect,
  shouldApplyEngineFailure,
  shouldHandleSocketClose,
  rememberSourceState,
  toggleSystemMode,
  classifySourceKind,
  sanitizeErrorMessage,
  formatWindowLogLine,
  appendWindowLog,
  engineFailureMessage,
  isWouldBlockError,
  isNameTakenError,
} from "../mods/tunr/engine-state.mjs";

test("引擎世代遞增與舊連線不覆蓋新規則", () => {
  const g1 = nextGeneration(0);
  const g2 = nextGeneration(g1);
  assert.equal(g1, 1);
  assert.equal(g2, 2);

  assert.equal(isCurrentGeneration(g1, g2), false);
  assert.equal(isCurrentGeneration(g2, g2), true);

  assert.equal(shouldAbortConnect(g1, g2, false), true);
  assert.equal(shouldAbortConnect(g2, g2, true), true);
  assert.equal(shouldAbortConnect(g2, g2, false), false);

  // 舊連線失敗不能寫進新的 this.message 或誤觸結束
  assert.equal(shouldApplyEngineFailure(g1, g2, false), false);
  assert.equal(shouldApplyEngineFailure(g2, g2, true), false);
  assert.equal(shouldApplyEngineFailure(g2, g2, false), true);

  // readLoop 結束只在最新世代、同一支 socket、非 handoff、未關閉時生效
  assert.equal(shouldHandleSocketClose(g1, g2, true, false, false), false);
  assert.equal(shouldHandleSocketClose(g2, g2, false, false, false), false);
  assert.equal(shouldHandleSocketClose(g2, g2, true, true, false), false);
  assert.equal(shouldHandleSocketClose(g2, g2, true, false, true), false);
  assert.equal(shouldHandleSocketClose(g2, g2, true, false, false), true);
});

test("lastSource 記憶與 📻 來回切換（檔案／網址／無來源）", () => {
  // 1. 原本播放檔案，切到 📻 後記住 lastSource，再切回來會播原檔案
  const s1 = rememberSourceState({ source: null, lastSource: null }, "C:\\Users\\a\\song.mp3");
  assert.deepEqual(s1, { source: "C:\\Users\\a\\song.mp3", lastSource: "C:\\Users\\a\\song.mp3" });

  const toSys = toggleSystemMode(s1);
  assert.deepEqual(toSys, {
    changed: true,
    action: "connect",
    source: "system",
    lastSource: "C:\\Users\\a\\song.mp3",
  });

  const backToFile = toggleSystemMode({ source: toSys.source, lastSource: toSys.lastSource });
  assert.deepEqual(backToFile, {
    changed: true,
    action: "connect",
    source: "C:\\Users\\a\\song.mp3",
    lastSource: "C:\\Users\\a\\song.mp3",
  });

  // 2. 原本播放網址，切到 📻 再切回來會接回原網址
  const urlState = rememberSourceState(s1, "https://example.com/watch?v=1");
  assert.equal(urlState.lastSource, "https://example.com/watch?v=1");
  const urlOn = toggleSystemMode(urlState, true);
  assert.equal(urlOn.source, "system");
  assert.equal(urlOn.lastSource, "https://example.com/watch?v=1");
  const urlOff = toggleSystemMode(urlOn, false);
  assert.deepEqual(urlOff, {
    changed: true,
    action: "connect",
    source: "https://example.com/watch?v=1",
    lastSource: "https://example.com/watch?v=1",
  });

  // 3. 沒有 lastSource 時關掉 📻 -> 清回等待拖入（clear）且無錯誤
  const noLastOff = toggleSystemMode({ source: "system", lastSource: null }, false);
  assert.deepEqual(noLastOff, {
    changed: true,
    action: "clear",
    source: null,
    lastSource: null,
  });

  // 4. system-on / system-off 幂等性
  assert.equal(toggleSystemMode({ source: "system", lastSource: "a.mp4" }, true).action, "noop");
  assert.equal(toggleSystemMode({ source: "a.mp4", lastSource: "a.mp4" }, false).action, "noop");
  assert.equal(toggleSystemMode({ source: null, lastSource: null }, false).action, "noop");
});

test("視窗錯誤紀錄會去除網址與路徑並限制最多 200 行", () => {
  assert.equal(classifySourceKind(null), "none");
  assert.equal(classifySourceKind("system"), "system");
  assert.equal(classifySourceKind("https://youtu.be/abc"), "url");
  assert.equal(classifySourceKind("C:\\secret\\track.flac"), "file");

  const sanitized = sanitizeErrorMessage(
    'spawn failed --source "https://secret.example/watch?v=xyz" C:\\Users\\me\\Music\\secret-song.mp3 \\\\nas\\share\\a.wav /home/u/dir/x.mp4\nline2'
  );
  assert.ok(!sanitized.includes("secret.example"));
  assert.ok(!sanitized.includes("secret-song"));
  assert.ok(!sanitized.includes("nas\\share"));
  assert.ok(!sanitized.includes("/home/u/"));
  assert.ok(!sanitized.includes("\n"));

  const line = formatWindowLogLine({
    time: "2026-11-13T00:00:00.000Z",
    step: "connectEngine",
    source: "https://private.example/track?id=99",
    error: new Error("timeout connecting C:\\Users\\me\\file.mp4"),
  });
  assert.ok(line.includes("step=connectEngine"));
  assert.ok(line.includes("source=url"));
  assert.ok(!line.includes("private.example"));
  assert.ok(!line.includes("Users\\me"));

  let text = "";
  for (let i = 1; i <= 205; i++) {
    text = appendWindowLog(text, `line-${i}`, 200);
  }
  const kept = text.trimEnd().split("\n");
  assert.equal(kept.length, 200);
  assert.equal(kept[0], "line-6");
  assert.equal(kept[199], "line-205");
});

test("讀取迴圈出錯顯示引擎已結束，其他步驟顯示連不上", () => {
  assert.equal(engineFailureMessage("read_loop"), "engineEnded");
  for (const step of ["init", "start_engine", "tcp_connect", "resume_connect", "platform_check"]) {
    assert.equal(engineFailureMessage(step), "connectFailed");
  }
});

test("暫時沒有資料的讀取錯誤要重讀，其他錯誤照常", () => {
  assert.equal(isWouldBlockError(new Error("socket read failed: Resource temporarily unavailable (os error 11)")), true);
  assert.equal(isWouldBlockError(new Error("socket read failed (os error 35)")), true);
  assert.equal(isWouldBlockError("socket read failed (os error 10035)"), true);
  assert.equal(isWouldBlockError(new Error("socket read failed: 遠端主機已強制關閉一個現存的連線。 (os error 10054)")), false);
  assert.equal(isWouldBlockError(new Error("os error 110")), false);
  assert.equal(isWouldBlockError(null), false);
  // Windows 的讀取逾時
  assert.equal(isWouldBlockError(new Error("socket read failed: 連線嘗試失敗，因為連線對象有一段時間並未正確回應，或是連線建立失敗，因為連線的主機無法回應。 (os error 10060)")), true);
  assert.equal(isWouldBlockError(new Error("os error 100600")), false);
});

test("hc run 撞名才重試，其他錯誤照常", () => {
  assert.equal(isNameTakenError('{"error":{"hint":"pick another name, or kill the one holding it","kind":"name_taken","message":"a live terminal is already named \\"tunr-engine\\""}}'), true);
  assert.equal(isNameTakenError('{"error":{"kind":"spawn_failed","message":"program not found"}}'), false);
  assert.equal(isNameTakenError(""), false);
  assert.equal(isNameTakenError(undefined), false);
});
