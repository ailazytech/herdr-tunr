import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowSize, doesFit, nextFitSize, canOpenVideo, bestFitSize } from '../mods/tunr/layout.js';

test('windowSize dimensions for S, M, L in video and audio modes', () => {
  // S: cols 48, rows 16. Width: 48*6 + 16 = 304. Height: 16*12 + 16 + 50 = 258. Audio: 24 + 50 = 74.
  assert.deepEqual(windowSize('S', true), { width: 304, height: 258 });
  assert.deepEqual(windowSize('S', false), { width: 304, height: 74 });

  // M: cols 64, rows 22. Width: 64*6 + 16 = 400. Height: 22*12 + 16 + 50 = 330. Audio: 74.
  assert.deepEqual(windowSize('M', true), { width: 400, height: 330 });
  assert.deepEqual(windowSize('M', false), { width: 400, height: 74 });

  // L: cols 80, rows 27. Width: 80*6 + 16 = 496. Height: 27*12 + 16 + 50 = 390. Audio: 74.
  assert.deepEqual(windowSize('L', true), { width: 496, height: 390 });
  assert.deepEqual(windowSize('L', false), { width: 496, height: 74 });
});

test('放得下照常換', () => {
  const vp = { width: 1920, height: 1032 };
  const pos = { x: 100, y: 100 };

  // S -> M
  const fitM = nextFitSize('S', pos, true, vp);
  assert.deepEqual(fitM, { sizeKey: 'M', skipped: null, changed: true });

  // M -> L
  const fitL = nextFitSize('M', pos, true, vp);
  assert.deepEqual(fitL, { sizeKey: 'L', skipped: null, changed: true });

  // L -> S
  const fitS = nextFitSize('L', pos, true, vp);
  assert.deepEqual(fitS, { sizeKey: 'S', skipped: null, changed: true });

  // pos 為 null（從沒拖過、置中）時照常換大小
  const fitNullPos = nextFitSize('S', null, true, vp);
  assert.deepEqual(fitNullPos, { sizeKey: 'M', skipped: null, changed: true });
});

test('M 放不下跳到下一個放得下的', () => {
  const vp = { width: 1920, height: 1032 };
  // 右下角：pos = (1485, 736)
  // S: 1485+304=1789<=1920, 736+258=994<=1032 (放得下)
  // M: 1485+400=1885<=1920, 736+330=1066>1032 (放不下，高度超出 34px)
  // L: 1485+496=1981>1920, 736+390=1126>1032 (寬度高度均超出)
  const posBottomRight = { x: 1485, y: 736 };

  // 目前在 S，按循環應到 M；但 M 和 L 都放不下，跳過 M 與 L，回到 S；跳過目標為 M
  const fitFromS = nextFitSize('S', posBottomRight, true, vp);
  assert.equal(fitFromS.sizeKey, 'S');
  assert.equal(fitFromS.skipped, 'M');
  assert.equal(fitFromS.changed, false);

  // 若視窗在 (1000, 680)：S 放得下，M 放得下（680+330=1010<=1032），但 L 放不下（680+390=1070>1032）
  const posMid = { x: 1000, y: 680 };
  // 從 M 按循環應到 L；但 L 放不下，跳過 L 換回 S
  const fitFromM = nextFitSize('M', posMid, true, vp);
  assert.equal(fitFromM.sizeKey, 'S');
  assert.equal(fitFromM.skipped, 'L');
  assert.equal(fitFromM.changed, true);
});

test('全都放不下不變', () => {
  const vp = { width: 1920, height: 1032 };
  // 視窗拖到極度靠邊：pos = (1800, 950)
  // 連 S (304x258) 的寬度 1800+304=2104>1920、高度 950+258=1208>1032 都放不下
  const posExt = { x: 1800, y: 950 };

  const fit = nextFitSize('S', posExt, true, vp);
  assert.equal(fit.sizeKey, 'S');
  assert.equal(fit.skipped, 'M');
  assert.equal(fit.changed, false);
});

test('開畫面放不下維持只聽聲音', () => {
  const vp = { width: 1920, height: 1032 };

  // 在右下角 pos = (1485, 736)，S 尺寸
  // 聲音模式：736 + 74 = 810 <= 1032 (放得下)
  // 畫面模式：736 + 258 = 994 <= 1032 (S 畫面放得下)
  assert.equal(canOpenVideo('S', { x: 1485, y: 736 }, vp), true);

  // 若 pos = (1485, 800)，S 尺寸
  // 聲音模式：800 + 74 = 874 <= 1032 (放得下)
  // 畫面模式：800 + 258 = 1058 > 1032 (S 畫面放不下)
  assert.equal(canOpenVideo('S', { x: 1485, y: 800 }, vp), false);

  // M 尺寸在 pos = (1485, 736)
  // 聲音模式：736 + 74 = 810 <= 1032 (放得下)
  // 畫面模式：736 + 330 = 1066 > 1032 (M 畫面放不下)
  assert.equal(canOpenVideo('M', { x: 1485, y: 736 }, vp), false);
});

test('開啟時超出改成放得下的最大尺寸', () => {
  const vp = { width: 1600, height: 800 };
  // 原本記憶在 (1200, 500)
  // L (496x390): 1200+496=1696>1600 (放不下)
  // M (400x330): 500+330=830>800 (放不下)
  // S (304x258): 1200+304=1504<=1600, 500+258=758<=800 (放得下)
  const pos = { x: 1200, y: 500 };
  assert.equal(bestFitSize(pos, true, vp), 'S');

  // 若在 (1000, 400)，vp = (1600, 800)
  // L: 1000+496=1496<=1600, 400+390=790<=800 (放得下最大為 L)
  assert.equal(bestFitSize({ x: 1000, y: 400 }, true, vp), 'L');

  // 若連 S 都放不下（例如 pos = (1500, 700)）
  // 回傳 null（維持原樣）
  assert.equal(bestFitSize({ x: 1500, y: 700 }, true, vp), null);
});
