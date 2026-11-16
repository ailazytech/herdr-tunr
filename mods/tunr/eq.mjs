export const EQ_PREFIX = "\x02";
export const EQ_LEVEL_MAX = 9;
export const EQ_FPS = 14;
export const EQ_SAMPLE_RATE = 22050;

/**
 * 將各頻帶的正規化高度（0..1）編碼為 ASCII 協定訊息（"\x02" 開頭，每個頻帶 1 個 '0'..'9'）。
 * @param {ArrayLike<number>} levels
 * @returns {string}
 */
export function encodeEqBands(levels) {
  if (!levels || typeof levels.length !== "number") return EQ_PREFIX;
  let out = EQ_PREFIX;
  for (let i = 0; i < levels.length; i++) {
    const v = Number(levels[i]);
    const clamped = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    out += String(Math.round(clamped * EQ_LEVEL_MAX));
  }
  return out;
}

/**
 * 解碼視窗端收到的等化器頻帶訊息（"\x02" 開頭，後接 '0'..'9'）。
 * 若提供長度相符的 target，會原地覆寫以重用緩衝區；格式不合法時回傳 null。
 * @param {string} msg
 * @param {Uint8Array | number[] | null} [target=null]
 * @returns {Uint8Array | number[] | null}
 */
export function decodeEqBands(msg, target = null) {
  if (typeof msg !== "string" || msg.length < 2 || msg.charCodeAt(0) !== 2) return null;
  const count = msg.length - 1;
  const out = target && target.length === count ? target : new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const code = msg.charCodeAt(i + 1);
    if (code < 48 || code > 57) return null;
    out[i] = code - 48;
  }
  return out;
}

/**
 * 讓正規化頻帶高度往 0 漸減（暫停或結束時使用）。
 * @param {Float32Array | number[]} levels
 * @param {number} [factor=0.75]
 * @param {number} [cutoff=0.05]
 * @returns {{ changed: boolean, allZero: boolean }}
 */
export function stepDecayLevels(levels, factor = 0.75, cutoff = 0.05) {
  let changed = false;
  let allZero = true;
  for (let i = 0; i < levels.length; i++) {
    const prev = levels[i];
    if (prev <= 0) {
      levels[i] = 0;
      continue;
    }
    const next = prev * factor;
    const clamped = next < cutoff ? 0 : next;
    if (clamped !== prev) changed = true;
    levels[i] = clamped;
    if (clamped > 0) allZero = false;
  }
  return { changed, allZero };
}
