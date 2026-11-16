/**
 * 解析 system.ps1 輸出的一行 SMTC JSON。
 * 不完整或損毀的 JSON 回傳 null。
 * @param {string} line
 * @returns {{ status: "playing"|"paused"|"stopped"|"none", title: string, artist: string, app: string, canPlay: boolean, canPause: boolean, canNext: boolean, canPrev: boolean } | null}
 */
export function parseMediaLine(line) {
  if (typeof line !== "string") return null;
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const raw = JSON.parse(trimmed);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const status = raw.status === "playing" || raw.status === "paused" || raw.status === "stopped" ? raw.status : "none";
    return {
      status,
      title: typeof raw.title === "string" ? raw.title.trim() : "",
      artist: typeof raw.artist === "string" ? raw.artist.trim() : "",
      app: typeof raw.app === "string" ? raw.app.trim() : "",
      canPlay: Boolean(raw.canPlay),
      canPause: Boolean(raw.canPause),
      canNext: Boolean(raw.canNext),
      canPrev: Boolean(raw.canPrev),
    };
  } catch {
    return null;
  }
}

const graphemeSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

/**
 * 判斷單一 Unicode code point 在等寬字型中是否為寬字元（佔 2 格）。
 * @param {number} cp
 * @returns {boolean}
 */
function isWideCodePoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x231a || cp === 0x231b ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x23e9 && cp <= 0x23f3) ||
    (cp >= 0x23f8 && cp <= 0x23fa) ||
    cp === 0x25fd || cp === 0x25fe ||
    cp === 0x2614 || cp === 0x2615 ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f || cp === 0x2693 || cp === 0x26a1 ||
    cp === 0x26aa || cp === 0x26ab || cp === 0x26bd || cp === 0x26be ||
    cp === 0x26c4 || cp === 0x26c5 || cp === 0x26ce || cp === 0x26d4 ||
    cp === 0x26ea || cp === 0x26f2 || cp === 0x26f3 || cp === 0x26f5 ||
    cp === 0x26fa || cp === 0x26fd ||
    cp === 0x2705 || cp === 0x270a || cp === 0x270b || cp === 0x2728 ||
    cp === 0x274c || cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) || cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) || cp === 0x27b0 || cp === 0x27bf ||
    cp === 0x2b1b || cp === 0x2b1c || cp === 0x2b50 || cp === 0x2b55 ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f004 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * 判斷 Unicode code point 是否為不佔寬度的組合字元或控制字元。
 * @param {number} cp
 * @returns {boolean}
 */
function isZeroWidthCodePoint(cp) {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

/**
 * 將字串切分成不拆開代理對或 emoji 序列的字素簇陣列。
 * @param {string} text
 * @returns {string[]}
 */
function splitGraphemes(text) {
  if (!text) return [];
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/**
 * 計算單一字素簇在等寬字型中的顯示寬度（全形／CJK／emoji 算 2，其餘一般字元算 1）。
 * @param {string} grapheme
 * @returns {number}
 */
function graphemeWidth(grapheme) {
  if (!grapheme) return 0;
  if (grapheme.includes("\ufe0f") || grapheme.includes("\u20e3") || grapheme.includes("\u200d")) {
    return 2;
  }
  let maxW = 0;
  for (const ch of grapheme) {
    const cp = ch.codePointAt(0);
    if (isZeroWidthCodePoint(cp)) continue;
    const w = isWideCodePoint(cp) ? 2 : 1;
    if (w > maxW) maxW = w;
  }
  return maxW;
}

/**
 * 計算字串的等寬顯示寬度（全形／CJK／emoji 算 2，其餘可見字元算 1）。
 * @param {string} text
 * @returns {number}
 */
export function displayWidth(text) {
  let width = 0;
  for (const g of splitGraphemes(String(text ?? ""))) {
    width += graphemeWidth(g);
  }
  return width;
}

/**
 * 依等寬顯示寬度截斷字串：超過 maxCols 時只在字素邊界切斷，並補上「…」，
 * 確保結果寬度不超過 maxCols 且不會切破代理對。
 * @param {string} text
 * @param {number} maxCols
 * @returns {string}
 */
export function truncateByWidth(text, maxCols) {
  const s = String(text ?? "");
  if (!(maxCols > 1)) return s;
  const graphemes = splitGraphemes(s);
  let total = 0;
  const widths = graphemes.map((g) => {
    const w = graphemeWidth(g);
    total += w;
    return w;
  });
  if (total <= maxCols) return s;

  const limit = maxCols - 1;
  let out = "";
  let used = 0;
  for (let i = 0; i < graphemes.length; i++) {
    const w = widths[i];
    if (used + w > limit) break;
    out += graphemes[i];
    used += w;
  }
  return out + "…";
}

/**
 * 依媒體資訊組合「歌名 — 演出者」，無工作階段或無資訊時回傳 fallbackLabel；
 * 超過 maxCols（顯示格數）時在字元邊界截斷並加上「…」。
 * @param {{ status?: string, title?: string, artist?: string } | null | undefined} media
 * @param {string} fallbackLabel
 * @param {number} maxCols
 * @returns {string}
 */
export function formatMediaLabel(media, fallbackLabel, maxCols = 36) {
  if (!media || media.status === "none") return fallbackLabel;
  const title = typeof media.title === "string" ? media.title.trim() : "";
  const artist = typeof media.artist === "string" ? media.artist.trim() : "";
  let label = "";
  if (title && artist) label = `${title} — ${artist}`;
  else if (title) label = title;
  else if (artist) label = artist;
  else return fallbackLabel;

  return truncateByWidth(label, maxCols);
}

/**
 * 計算系統音訊模式下各媒體控制鈕的狀態。
 * @param {{ status?: string, canPlay?: boolean, canPause?: boolean, canNext?: boolean, canPrev?: boolean } | null | undefined} media
 * @returns {{ hasSession: boolean, isPlaying: boolean, canToggle: boolean, canPrev: boolean, canNext: boolean }}
 */
export function mediaButtonStates(media) {
  const hasSession = Boolean(media && media.status && media.status !== "none");
  if (!hasSession) {
    return {
      hasSession: false,
      isPlaying: false,
      canToggle: true, // 無工作階段時播放／暫停鈕負責凍結／恢復頻譜
      canPrev: false,
      canNext: false,
    };
  }
  const isPlaying = media.status === "playing";
  return {
    hasSession: true,
    isPlaying,
    canToggle: isPlaying ? Boolean(media.canPause) : Boolean(media.canPlay),
    canPrev: Boolean(media.canPrev),
    canNext: Boolean(media.canNext),
  };
}
