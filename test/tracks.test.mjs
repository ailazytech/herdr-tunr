import test from "node:test";
import assert from "node:assert/strict";
import {
  PREV_RESTART_SEC,
  isMediaFilename,
  compareNaturalNames,
  buildFolderTrackList,
  parseYouTubeSource,
  buildYouTubeTrackUrl,
  buildYouTubePlaylistFetchUrl,
  extractPlaylistVideoIds,
  buildYouTubeTrackList,
  emptyTrackState,
  getTrackNavState,
  decidePrevAction,
  decideNextAction,
  shouldAutoAdvance,
  failedTrackState,
  trackNavTipKey,
} from "../mods/tunr/tracks.mjs";

test("抓不到清單：按鈕變灰，提示說明原因", () => {
  const failed = failedTrackState();
  assert.deepEqual(getTrackNavState(failed), { hasPrev: false, hasNext: false, canPrev: false, canNext: false });
  assert.equal(trackNavTipKey(failed, "prev"), "listUnavailable");
  assert.equal(trackNavTipKey(failed, "next"), "listUnavailable");
  assert.equal(trackNavTipKey(emptyTrackState(false), "prev"), "prevTrack");
  assert.equal(trackNavTipKey(emptyTrackState(true), "next"), "nextTrack");
  assert.equal(trackNavTipKey(null, "next"), "nextTrack");
});

test("YouTube 網址解析、清單位置尋找與組出 watch?v=&list= 網址", () => {
  const pl = parseYouTubeSource("https://www.youtube.com/watch?v=vid2&list=PLabc123&index=2");
  assert.deepEqual(pl, {
    listId: "PLabc123",
    videoId: "vid2",
    isMix: false,
    isPlaylistPath: false,
  });

  const rd = parseYouTubeSource("https://youtu.be/abcXYZ?list=RDabcXYZ");
  assert.deepEqual(rd, {
    listId: "RDabcXYZ",
    videoId: "abcXYZ",
    isMix: true,
    isPlaylistPath: false,
  });

  const purePl = parseYouTubeSource("https://www.youtube.com/playlist?list=PLonly");
  assert.deepEqual(purePl, {
    listId: "PLonly",
    videoId: null,
    isMix: false,
    isPlaylistPath: true,
  });

  assert.equal(parseYouTubeSource("https://example.com/watch?v=a&list=PL1"), null);
  assert.equal(parseYouTubeSource("C:\\Media\\a.mp4"), null);
  assert.equal(parseYouTubeSource("https://www.youtube.com/watch?v=singleOnly")?.listId, null);

  assert.equal(
    buildYouTubeTrackUrl("vid2", "PLabc123"),
    "https://www.youtube.com/watch?v=vid2&list=PLabc123"
  );
  assert.equal(
    buildYouTubePlaylistFetchUrl({ listId: "RDabc", videoId: "abc" }, "fallback"),
    "https://www.youtube.com/watch?v=abc&list=RDabc"
  );
  assert.equal(
    buildYouTubePlaylistFetchUrl({ listId: "PLonly", videoId: null }, "fallback"),
    "https://www.youtube.com/playlist?list=PLonly"
  );

  const ids = extractPlaylistVideoIds(
    JSON.stringify({
      _type: "playlist",
      entries: [
        { id: "id1", title: "One" },
        { id: "", url: "https://www.youtube.com/watch?v=id2" },
        { title: "Missing ID" },
        { id: "id3", title: "Three" },
      ],
    })
  );
  assert.deepEqual(ids, ["id1", "id2", "id3"]);
  assert.deepEqual(extractPlaylistVideoIds("not json"), []);

  const listState = buildYouTubeTrackList(ids, "id2", "PLtest");
  assert.equal(listState.index, 1);
  assert.deepEqual(listState.tracks, [
    "https://www.youtube.com/watch?v=id1&list=PLtest",
    "https://www.youtube.com/watch?v=id2&list=PLtest",
    "https://www.youtube.com/watch?v=id3&list=PLtest",
  ]);

  assert.deepEqual(decideNextAction(listState), {
    action: "load",
    source: "https://www.youtube.com/watch?v=id3&list=PLtest",
    index: 2,
  });

  const missingCur = buildYouTubeTrackList(ids, "other", "PLtest");
  assert.equal(missingCur.index, -1);
  assert.deepEqual(getTrackNavState(missingCur), {
    hasPrev: false,
    hasNext: false,
    canPrev: false,
    canNext: false,
  });

  // 背景清單尚未取到之前按鈕先變灰
  assert.deepEqual(getTrackNavState(emptyTrackState(true)), {
    hasPrev: false,
    hasNext: false,
    canPrev: false,
    canNext: false,
  });
});

test("資料夾自然排序、影音副檔名篩選、前後首與子資料夾排除", () => {
  assert.equal(isMediaFilename("a2.mp4"), true);
  assert.equal(isMediaFilename("TRACK10.FLAC"), true);
  assert.equal(isMediaFilename("note.txt"), false);
  assert.equal(isMediaFilename("cover.png"), false);
  assert.equal(isMediaFilename(".mp4"), false);

  const raw = ["a10.mp4", "a2.mp4", "a1.mp4", "a.mp4", "a-2.mp4"];
  assert.deepEqual([...raw].sort(compareNaturalNames), [
    "a.mp4",
    "a-2.mp4",
    "a1.mp4",
    "a2.mp4",
    "a10.mp4",
  ]);
  assert.deepEqual(["第10集.mkv", "第2集.mkv"].sort(compareNaturalNames), [
    "第2集.mkv",
    "第10集.mkv",
  ]);

  const entries = [
    { name: "subfolder.mp4", isDirectory: () => true },
    { name: "readme.txt", isDirectory: () => false },
    { name: "thumb.jpg", isDirectory: () => false },
    { name: "a10.mp4", isDirectory: () => false },
    { name: "a2.MP4", isDirectory: () => false },
    { name: "a1.mp3", isDirectory: () => false },
  ];

  const folder = buildFolderTrackList(entries, "C:\\Media\\A2.mp4");
  assert.equal(folder.dir, "C:\\Media");
  assert.deepEqual(folder.tracks, [
    "C:\\Media\\a1.mp3",
    "C:\\Media\\a2.MP4",
    "C:\\Media\\a10.mp4",
  ]);
  assert.equal(folder.index, 1);

  assert.deepEqual(getTrackNavState(folder), {
    hasPrev: true,
    hasNext: true,
    canPrev: true,
    canNext: true,
  });
  assert.deepEqual(decideNextAction(folder), {
    action: "load",
    source: "C:\\Media\\a10.mp4",
    index: 2,
  });

  const last = buildFolderTrackList(entries, "C:\\Media\\a10.mp4");
  assert.deepEqual(getTrackNavState(last), {
    hasPrev: true,
    hasNext: false,
    canPrev: true,
    canNext: false,
  });
  assert.deepEqual(decideNextAction(last), { action: "none" });

  // 單支檔案沒有上下首
  const single = buildFolderTrackList([{ name: "only.mp4", isDirectory: () => false }], "C:\\Media\\only.mp4");
  assert.deepEqual(getTrackNavState(single), {
    hasPrev: false,
    hasNext: false,
    canPrev: false,
    canNext: false,
  });
});

test("上一首 3 秒規則：超過 3 秒回開頭，3 秒內跳前一首", () => {
  assert.equal(PREV_RESTART_SEC, 3);
  const tracks = ["C:\\m\\01.mp3", "C:\\m\\02.mp3", "C:\\m\\03.mp3"];
  const mid = { kind: "folder", tracks, index: 1, loading: false };
  const first = { kind: "folder", tracks, index: 0, loading: false };

  assert.deepEqual(decidePrevAction(mid, 3.01), { action: "seek0" });
  assert.deepEqual(decidePrevAction(mid, 12.5), { action: "seek0" });
  assert.deepEqual(decidePrevAction(mid, 3), {
    action: "load",
    source: "C:\\m\\01.mp3",
    index: 0,
  });
  assert.deepEqual(decidePrevAction(mid, 0.4), {
    action: "load",
    source: "C:\\m\\01.mp3",
    index: 0,
  });
  assert.deepEqual(decidePrevAction(first, 10), { action: "none" });
});

test("自動接續判斷：播完且有下一首才接，手動暫停、失敗與最後一首不接", () => {
  const tracks = ["C:\\m\\01.mp4", "C:\\m\\02.mp4"];
  const atFirst = { kind: "folder", tracks, index: 0, loading: false };
  const atLast = { kind: "folder", tracks, index: 1, loading: false };

  // 播完且有下一首 -> 自動接續
  assert.deepEqual(
    shouldAutoAdvance({
      isSystem: false,
      prevEnded: false,
      status: { playing: false, ended: true, error: null },
      trackState: atFirst,
      alreadyAdvanced: false,
    }),
    { advance: true, source: "C:\\m\\02.mp4", index: 1 }
  );

  // 手動暫停（ended: false）-> 不接
  assert.deepEqual(
    shouldAutoAdvance({
      isSystem: false,
      prevEnded: false,
      status: { playing: false, ended: false, error: null },
      trackState: atFirst,
      alreadyAdvanced: false,
    }),
    { advance: false }
  );

  // 播放失敗（playFailed / resolveFailed）-> 不接
  for (const err of ["playFailed", "resolveFailed", "missingYtDlp"]) {
    assert.deepEqual(
      shouldAutoAdvance({
        isSystem: false,
        prevEnded: false,
        status: { playing: false, ended: true, error: err },
        trackState: atFirst,
        alreadyAdvanced: false,
      }),
      { advance: false }
    );
  }

  // 到最後一首就停
  assert.deepEqual(
    shouldAutoAdvance({
      isSystem: false,
      prevEnded: false,
      status: { playing: false, ended: true, error: null },
      trackState: atLast,
      alreadyAdvanced: false,
    }),
    { advance: false }
  );

  // 系統音訊不自動接續、已經處理過不重複接續
  assert.deepEqual(
    shouldAutoAdvance({
      isSystem: true,
      prevEnded: false,
      status: { playing: false, ended: true, error: null },
      trackState: atFirst,
      alreadyAdvanced: false,
    }),
    { advance: false }
  );
  assert.deepEqual(
    shouldAutoAdvance({
      isSystem: false,
      prevEnded: true,
      status: { playing: false, ended: true, error: null },
      trackState: atFirst,
      alreadyAdvanced: false,
    }),
    { advance: false }
  );
  assert.deepEqual(
    shouldAutoAdvance({
      isSystem: false,
      prevEnded: false,
      status: { playing: false, ended: true, error: null },
      trackState: atFirst,
      alreadyAdvanced: true,
    }),
    { advance: false }
  );
});
