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
export const HEADER_H = 30;
export const CONTROLS_H = 56;
export const COMPACT_H = 64;
export const HEADER_BTN_AREA_W = 76;
export const MIN_COMPACT_TITLE_W = 96;
export const EQ_PITCH = 8;

/**
 * 依視窗字元欄數決定縮小模式背景等化器的頻帶數（每約 8px 一條：S=36、M=48、L=60）。
 * @param {number} cols
 * @returns {number}
 */
export function eqBandCount(cols) {
  const contentW = Math.max(EQ_PITCH, (Number(cols) || SIZES.S.cols) * CHAR_W);
  return Math.max(8, Math.floor(contentW / EQ_PITCH));
}

/**
 * 視窗大小：有畫面時為標題列＋字格＋底部控制列；只聽聲音時為精簡兩列高度（64px）
 * @param {"S" | "M" | "L"} sizeKey
 * @param {boolean} [video=true]
 * @returns {{ width: number, height: number }}
 */
export function windowSize(sizeKey, video = true) {
  const { cols, rows } = SIZES[sizeKey] ?? SIZES.S;
  const width = cols * CHAR_W + PAD * 2;
  const height = video ? HEADER_H + rows * LINE_H + PAD * 2 + CONTROLS_H : COMPACT_H;
  return { width, height };
}

/**
 * 判斷只聽聲音的標題列右側是否放得下時間字串（例如 "0:09/5:00"）。
 * @param {number} windowWidth
 * @param {string} timeText
 * @param {boolean} [hasOverlayMessage=false]
 * @returns {boolean}
 */
export function compactHeaderFitsTime(windowWidth, timeText, hasOverlayMessage = false) {
  if (hasOverlayMessage || !timeText) return false;
  const innerW = windowWidth - 2 - PAD * 2;
  const timeW = timeText.length * CHAR_W + 6;
  return (innerW - HEADER_BTN_AREA_W - timeW) >= MIN_COMPACT_TITLE_W;
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
 * 尺寸與模式切換計算（順序：只聽聲音 < S < M < L）：
 * 只聽聲音 -> S(有畫面) -> M(有畫面) -> L(有畫面) -> 只聽聲音 循環。
 * 若下一個尺寸放不下，跳過它改選下一個放得下的；若全放不下則維持原樣。
 * @param {"S" | "M" | "L"} currentSizeKey
 * @param {{ x: number, y: number } | null} pos
 * @param {boolean} video
 * @param {{ width: number, height: number } | null} viewportSize
 * @returns {{ sizeKey: "S" | "M" | "L", video: boolean, skipped: string | null, changed: boolean }}
 */
export function nextFitSize(currentSizeKey, pos, video, viewportSize) {
  const curKey = SIZES[currentSizeKey] ? currentSizeKey : "S";
  const curVideo = Boolean(video);

  let candidates;
  if (!curVideo) {
    const others = SIZE_ORDER.filter((k) => k !== curKey);
    candidates = [
      { sizeKey: curKey, video: true },
      ...others.map((k) => ({ sizeKey: k, video: true })),
      { sizeKey: curKey, video: false },
    ];
  } else if (curKey === "S") {
    candidates = [
      { sizeKey: "M", video: true },
      { sizeKey: "L", video: true },
      { sizeKey: "S", video: false },
      { sizeKey: "S", video: true },
    ];
  } else if (curKey === "M") {
    candidates = [
      { sizeKey: "L", video: true },
      { sizeKey: "S", video: false },
      { sizeKey: "S", video: true },
      { sizeKey: "M", video: true },
    ];
  } else {
    candidates = [
      { sizeKey: "S", video: false },
      { sizeKey: "S", video: true },
      { sizeKey: "M", video: true },
      { sizeKey: "L", video: true },
    ];
  }

  const immediateNext = candidates[0];
  for (const cand of candidates) {
    if (doesFit(pos, windowSize(cand.sizeKey, cand.video), viewportSize)) {
      const skipped = (cand.sizeKey === immediateNext.sizeKey && cand.video === immediateNext.video)
        ? null
        : immediateNext.sizeKey;
      const changed = cand.sizeKey !== curKey || cand.video !== curVideo;
      return {
        sizeKey: cand.sizeKey,
        video: cand.video,
        skipped,
        changed,
      };
    }
  }

  return {
    sizeKey: curKey,
    video: curVideo,
    skipped: immediateNext.sizeKey,
    changed: false,
  };
}

/**
 * 往放大方向切換（只聽聲音 < S < M < L）：
 * - 只聽聲音時：嘗試打開目前尺寸的畫面；放不下就維持只聽聲音並回傳 skipped 供提示。
 * - 有畫面時：選擇下一個更大且在目前位置放得下的尺寸；已經是 L 時不變。
 * @param {"S" | "M" | "L"} currentSizeKey
 * @param {{ x: number, y: number } | null} pos
 * @param {boolean} video
 * @param {{ width: number, height: number } | null} viewportSize
 * @returns {{ sizeKey: "S" | "M" | "L", video: boolean, skipped: string | null, changed: boolean }}
 */
export function biggerFitSize(currentSizeKey, pos, video, viewportSize) {
  const curKey = SIZES[currentSizeKey] ? currentSizeKey : "S";
  if (!video) {
    if (doesFit(pos, windowSize(curKey, true), viewportSize)) {
      return { sizeKey: curKey, video: true, skipped: null, changed: true };
    }
    return { sizeKey: curKey, video: false, skipped: curKey, changed: false };
  }

  const startIdx = SIZE_ORDER.indexOf(curKey);
  if (startIdx >= SIZE_ORDER.length - 1) {
    return { sizeKey: curKey, video: true, skipped: null, changed: false };
  }
  let immediateNext = null;
  for (let i = startIdx + 1; i < SIZE_ORDER.length; i++) {
    const candidate = SIZE_ORDER[i];
    if (immediateNext === null) immediateNext = candidate;
    if (doesFit(pos, windowSize(candidate, true), viewportSize)) {
      return {
        sizeKey: candidate,
        video: true,
        skipped: candidate === immediateNext ? null : immediateNext,
        changed: true,
      };
    }
  }
  return { sizeKey: curKey, video: true, skipped: immediateNext, changed: false };
}

/**
 * 往縮小方向切換一級（L -> M -> S -> 只聽聲音）；已經是只聽聲音時回傳不變。
 * @param {"S" | "M" | "L"} currentSizeKey
 * @param {boolean} [video=true]
 * @returns {{ sizeKey: "S" | "M" | "L", video: boolean, changed: boolean }}
 */
export function smallerSize(currentSizeKey, video = true) {
  const curKey = SIZES[currentSizeKey] ? currentSizeKey : "S";
  if (!video) {
    return { sizeKey: curKey, video: false, changed: false };
  }
  const curIdx = SIZE_ORDER.indexOf(curKey);
  if (curIdx <= 0) {
    return { sizeKey: "S", video: false, changed: true };
  }
  return { sizeKey: SIZE_ORDER[curIdx - 1], video: true, changed: true };
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
