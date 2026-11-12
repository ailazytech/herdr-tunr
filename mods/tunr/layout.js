export const SIZES = {
  S: { cols: 48, rows: 16 },
  M: { cols: 64, rows: 22 },
  L: { cols: 80, rows: 27 },
};
export const SIZE_ORDER = ["S", "M", "L"];

// 字：JetBrains Mono 10px（寬約 6px），行高 12px
export const CHAR_W = 6;
export const LINE_H = 12;
export const PAD = 8;
export const CONTROLS_H = 50;
export const AUDIO_ONLY_H = 24;

/**
 * 視窗大小：畫面開著是字格加控制列；關畫面只剩控制列
 * @param {"S" | "M" | "L"} sizeKey
 * @param {boolean} video
 * @returns {{ width: number, height: number }}
 */
export function windowSize(sizeKey, video = true) {
  const { cols, rows } = SIZES[sizeKey] ?? SIZES.S;
  const width = cols * CHAR_W + PAD * 2;
  const height = video ? rows * LINE_H + PAD * 2 + CONTROLS_H : AUDIO_ONLY_H + CONTROLS_H;
  return { width, height };
}

/**
 * 檢查給定的視窗尺寸在目前座標下是否能完整容納於 App 視窗內
 * @param {{ x: number, y: number } | null} pos 目前左上角座標
 * @param {{ width: number, height: number }} size 視窗尺寸
 * @param {{ width: number, height: number } | null} viewportSize App 視窗 drawable 範圍
 * @returns {boolean}
 */
export function doesFit(pos, size, viewportSize) {
  if (!pos || !viewportSize) return true;
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return true;
  if (!Number.isFinite(viewportSize.width) || !Number.isFinite(viewportSize.height)) return true;
  if (viewportSize.width <= 0 || viewportSize.height <= 0) return true;
  const w = size?.width ?? 0;
  const h = size?.height ?? 0;
  return pos.x >= 0 && pos.y >= 0 && (pos.x + w <= viewportSize.width) && (pos.y + h <= viewportSize.height);
}

/**
 * 尺寸切換計算：
 * S -> M -> L -> S 循環。
 * 若下一個尺寸放不下，跳過它改選下一個放得下的尺寸；若全放不下則維持原樣。
 * @param {"S" | "M" | "L"} currentSizeKey
 * @param {{ x: number, y: number } | null} pos
 * @param {boolean} video
 * @param {{ width: number, height: number } | null} viewportSize
 * @returns {{ sizeKey: "S" | "M" | "L", skipped: string | null, changed: boolean }}
 */
export function nextFitSize(currentSizeKey, pos, video, viewportSize) {
  const curIdx = SIZE_ORDER.indexOf(currentSizeKey);
  const startIdx = curIdx >= 0 ? curIdx : 0;
  const numSizes = SIZE_ORDER.length;

  let immediateNext = null;
  for (let step = 1; step <= numSizes; step++) {
    const candidate = SIZE_ORDER[(startIdx + step) % numSizes];
    if (step === 1) {
      immediateNext = candidate;
    }
    const size = windowSize(candidate, video);
    if (doesFit(pos, size, viewportSize)) {
      const skipped = (candidate === immediateNext) ? null : immediateNext;
      return {
        sizeKey: candidate,
        skipped,
        changed: candidate !== currentSizeKey,
      };
    }
  }

  return {
    sizeKey: currentSizeKey,
    skipped: immediateNext,
    changed: false,
  };
}

/**
 * 檢查切換回畫面（video: true）時是否放得下
 * @param {"S" | "M" | "L"} sizeKey
 * @param {{ x: number, y: number } | null} pos
 * @param {{ width: number, height: number } | null} viewportSize
 * @returns {boolean}
 */
export function canOpenVideo(sizeKey, pos, viewportSize) {
  const size = windowSize(sizeKey, true);
  return doesFit(pos, size, viewportSize);
}

/**
 * 開啟或重開 App 復原時，若目前尺寸超出，找出放得下的最大尺寸（L -> M -> S）
 * 連 S 都放不下時回傳 null（代表維持原樣）
 * @param {{ x: number, y: number } | null} pos
 * @param {boolean} video
 * @param {{ width: number, height: number } | null} viewportSize
 * @returns {"S" | "M" | "L" | null}
 */
export function bestFitSize(pos, video, viewportSize) {
  const candidates = [...SIZE_ORDER].reverse();
  for (const key of candidates) {
    const size = windowSize(key, video);
    if (doesFit(pos, size, viewportSize)) {
      return key;
    }
  }
  return null;
}
