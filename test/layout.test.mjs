import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowSize, doesFit, nextFitSize, biggerFitSize, smallerSize, canOpenVideo, bestFitSize, compactHeaderFitsTime, eqBandCount } from '../mods/tunr/layout.js';

test('windowSize dimensions for S, M, L in video and compact audio-only modes', () => {
  // S: cols 48, rows 16. Width: 48*6 + 16 = 304. Video Height: 30 + 16*12 + 16 + 56 = 294. Compact: 64.
  assert.deepEqual(windowSize('S', true), { width: 304, height: 294 });
  assert.deepEqual(windowSize('S', false), { width: 304, height: 64 });

  // M: cols 64, rows 22. Width: 64*6 + 16 = 400. Video Height: 30 + 22*12 + 16 + 56 = 366. Compact: 64.
  assert.deepEqual(windowSize('M', true), { width: 400, height: 366 });
  assert.deepEqual(windowSize('M', false), { width: 400, height: 64 });

  // L: cols 80, rows 27. Width: 80*6 + 16 = 496. Video Height: 30 + 27*12 + 16 + 56 = 426. Compact: 64.
  assert.deepEqual(windowSize('L', true), { width: 496, height: 426 });
  assert.deepEqual(windowSize('L', false), { width: 496, height: 64 });
});

test('放得下照常循環：只聽聲音 -> S -> M -> L -> 只聽聲音', () => {
  const vp = { width: 1920, height: 1032 };
  const pos = { x: 100, y: 100 };

  // 只聽聲音(S) -> S(有畫面)
  assert.deepEqual(nextFitSize('S', pos, false, vp), { sizeKey: 'S', video: true, skipped: null, changed: true });

  // S -> M
  assert.deepEqual(nextFitSize('S', pos, true, vp), { sizeKey: 'M', video: true, skipped: null, changed: true });

  // M -> L
  assert.deepEqual(nextFitSize('M', pos, true, vp), { sizeKey: 'L', video: true, skipped: null, changed: true });

  // L -> 只聽聲音(S)
  assert.deepEqual(nextFitSize('L', pos, true, vp), { sizeKey: 'S', video: false, skipped: null, changed: true });

  // pos 為 null（從沒拖過、置中）時照常換大小
  assert.deepEqual(nextFitSize('S', null, true, vp), { sizeKey: 'M', video: true, skipped: null, changed: true });
});

test('M/L 放不下跳到下一個放得下的，只聽聲音開畫面放不下則維持不變', () => {
  const vp = { width: 1920, height: 1032 };
  // 右下角：pos = (1485, 700)
  // S(有畫面): 1485+304=1789<=1920, 700+294=994<=1032 (放得下)
  // M(有畫面): 1485+400=1885<=1920, 700+366=1066>1032 (放不下)
  // L(有畫面): 寬度高度均超出
  // 只聽聲音(S): 1485+304=1789<=1920, 700+64=764<=1032 (放得下)
  const posBottomRight = { x: 1485, y: 700 };

  // 從 S(有畫面) 按循環：M、L 放不下，跳過回到只聽聲音(S)
  const fitFromS = nextFitSize('S', posBottomRight, true, vp);
  assert.deepEqual(fitFromS, { sizeKey: 'S', video: false, skipped: 'M', changed: true });

  // 若視窗在 (1000, 644)：S、M 放得下，L 放不下（644+426=1070>1032）
  const posMid = { x: 1000, y: 644 };
  const fitFromM = nextFitSize('M', posMid, true, vp);
  assert.deepEqual(fitFromM, { sizeKey: 'S', video: false, skipped: 'L', changed: true });

  // 若視窗在 (1485, 760)：只聽聲音(64px)放得下，但有畫面 S(294px)放不下 -> 維持只聽聲音
  const posLow = { x: 1485, y: 760 };
  const fitFromAudio = nextFitSize('S', posLow, false, vp);
  assert.deepEqual(fitFromAudio, { sizeKey: 'S', video: false, skipped: 'S', changed: false });
});

test('全都放不下不變', () => {
  const vp = { width: 1920, height: 1032 };
  // 視窗拖到極度靠邊：pos = (1800, 990)
  // 連只聽聲音 S (304x64) 都放不下
  const posExt = { x: 1800, y: 990 };

  const fit = nextFitSize('S', posExt, true, vp);
  assert.equal(fit.sizeKey, 'S');
  assert.equal(fit.video, true);
  assert.equal(fit.skipped, 'M');
  assert.equal(fit.changed, false);
});

test('開畫面與精簡高度檢查 doesFit / canOpenVideo', () => {
  const vp = { width: 1920, height: 1032 };

  // 只聽聲音高度 64px，在 y=968 仍放得下，但有畫面 S(294px) 放不下
  assert.equal(doesFit({ x: 1485, y: 968 }, windowSize('S', false), vp), true);
  assert.equal(doesFit({ x: 1485, y: 969 }, windowSize('S', false), vp), false);

  assert.equal(canOpenVideo('S', { x: 1485, y: 700 }, vp), true);
  assert.equal(canOpenVideo('S', { x: 1485, y: 760 }, vp), false);
  assert.equal(canOpenVideo('M', { x: 1485, y: 700 }, vp), false);
});

test('開啟時超出改成放得下的最大尺寸', () => {
  const vp = { width: 1600, height: 800 };
  const pos = { x: 1200, y: 460 };
  assert.equal(bestFitSize(pos, true, vp), 'S');
  assert.equal(bestFitSize({ x: 1000, y: 360 }, true, vp), 'L');
  assert.equal(bestFitSize({ x: 1500, y: 700 }, true, vp), null);
  // 只聽聲音高度為 64px，寬度 L(496) 1000+496<=1600 且 730+64=794<=800
  assert.equal(bestFitSize({ x: 1000, y: 730 }, false, vp), 'L');
});

test('biggerFitSize 與 smallerSize 依新順序（只聽聲音 < S < M < L）切換', () => {
  const vp = { width: 1920, height: 1032 };

  // 放大：只聽聲音 -> 打開畫面，維持目前寬度
  assert.deepEqual(biggerFitSize('S', { x: 100, y: 100 }, false, vp), { sizeKey: 'S', video: true, skipped: null, changed: true });
  assert.deepEqual(biggerFitSize('M', { x: 100, y: 100 }, false, vp), { sizeKey: 'M', video: true, skipped: null, changed: true });
  assert.deepEqual(biggerFitSize('L', { x: 100, y: 100 }, false, vp), { sizeKey: 'L', video: true, skipped: null, changed: true });

  // 只聽聲音放大時放不下 -> 維持只聽聲音並回報放不下的尺寸
  assert.deepEqual(biggerFitSize('S', { x: 1485, y: 760 }, false, vp), { sizeKey: 'S', video: false, skipped: 'S', changed: false });
  assert.deepEqual(biggerFitSize('M', { x: 1485, y: 700 }, false, vp), { sizeKey: 'M', video: false, skipped: 'M', changed: false });

  // 有畫面時放大：S -> M -> L，L 時不能再放大
  assert.deepEqual(biggerFitSize('S', { x: 100, y: 100 }, true, vp), { sizeKey: 'M', video: true, skipped: null, changed: true });
  assert.deepEqual(biggerFitSize('M', { x: 100, y: 100 }, true, vp), { sizeKey: 'L', video: true, skipped: null, changed: true });
  assert.deepEqual(biggerFitSize('L', { x: 100, y: 100 }, true, vp), { sizeKey: 'L', video: true, skipped: null, changed: false });

  // 有畫面時放不下
  assert.deepEqual(biggerFitSize('M', { x: 1000, y: 644 }, true, vp), { sizeKey: 'M', video: true, skipped: 'L', changed: false });
  assert.deepEqual(biggerFitSize('S', { x: 1485, y: 700 }, true, vp), { sizeKey: 'S', video: true, skipped: 'M', changed: false });

  // 縮小：L -> M -> S -> 只聽聲音(S)；只聽聲音時不能再縮小
  assert.deepEqual(smallerSize('L', true), { sizeKey: 'M', video: true, changed: true });
  assert.deepEqual(smallerSize('M', true), { sizeKey: 'S', video: true, changed: true });
  assert.deepEqual(smallerSize('S', true), { sizeKey: 'S', video: false, changed: true });
  assert.deepEqual(smallerSize('S', false), { sizeKey: 'S', video: false, changed: false });
  assert.deepEqual(smallerSize('M', false), { sizeKey: 'M', video: false, changed: false });
  assert.deepEqual(smallerSize('L', false), { sizeKey: 'L', video: false, changed: false });
});

test('compactHeaderFitsTime 依視窗寬度與提示狀態決定是否顯示時間', () => {
  assert.equal(compactHeaderFitsTime(304, '0:09/5:00', false), true);
  assert.equal(compactHeaderFitsTime(400, '0:09/5:00', false), true);
  assert.equal(compactHeaderFitsTime(496, '0:09/5:00', false), true);
  assert.equal(compactHeaderFitsTime(304, '0:09/5:00', true), false);
  assert.equal(compactHeaderFitsTime(304, '', false), false);
  assert.equal(compactHeaderFitsTime(200, '0:09/5:00', false), false);
});

test('eqBandCount 依視窗欄數輸出 S=36、M=48、L=60 頻帶數', () => {
  assert.equal(eqBandCount(48), 36);
  assert.equal(eqBandCount(64), 48);
  assert.equal(eqBandCount(80), 60);
});
