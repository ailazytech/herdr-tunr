export const SPEED_STEPS = [0.75, 1, 1.25, 1.5, 2];
export const DEFAULT_SPEED = 1;

/**
 * 將倍速規範化為允許的檔位（0.75、1、1.25、1.5、2），不合法時回傳預設值。
 * @param {unknown} value
 * @param {number} [fallback=DEFAULT_SPEED]
 * @returns {number}
 */
export function normalizeSpeed(value, fallback = DEFAULT_SPEED) {
  const safeFallback = SPEED_STEPS.includes(fallback) ? fallback : DEFAULT_SPEED;
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return safeFallback;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return safeFallback;
  let best = SPEED_STEPS[0];
  let bestDiff = Math.abs(n - best);
  for (let i = 1; i < SPEED_STEPS.length; i++) {
    const diff = Math.abs(n - SPEED_STEPS[i]);
    if (diff < bestDiff) {
      best = SPEED_STEPS[i];
      bestDiff = diff;
    }
  }
  return best;
}

/**
 * 依方向循環切換倍速（1 → 1.25 → 1.5 → 2 → 0.75 → 1；delta < 0 往回）。
 * @param {unknown} current
 * @param {number} [delta=1]
 * @returns {number}
 */
export function nextSpeedStep(current, delta = 1) {
  const cur = normalizeSpeed(current, DEFAULT_SPEED);
  const idx = SPEED_STEPS.indexOf(cur);
  const step = delta < 0 ? -1 : 1;
  const nextIdx = (idx + step + SPEED_STEPS.length) % SPEED_STEPS.length;
  return SPEED_STEPS[nextIdx];
}

/**
 * 格式化按鈕上的倍速文字（例如 1×、1.25×）。
 * @param {unknown} speed
 * @returns {string}
 */
export function formatSpeedLabel(speed) {
  return `${normalizeSpeed(speed, DEFAULT_SPEED)}×`;
}

/**
 * 依起點媒體時間、經過的牆上毫秒數與倍速換算媒體時間（秒）。
 * @param {number} basePos
 * @param {number} elapsedWallMs
 * @param {number} [speed=DEFAULT_SPEED]
 * @returns {number}
 */
export function advanceMediaClock(basePos, elapsedWallMs, speed = DEFAULT_SPEED) {
  const start = Number.isFinite(basePos) ? basePos : 0;
  const wallSec = Math.max(0, Number.isFinite(elapsedWallMs) ? elapsedWallMs : 0) / 1000;
  const rate = Number.isFinite(speed) && speed > 0 ? speed : DEFAULT_SPEED;
  return start + wallSec * rate;
}

/**
 * 將 ffplay（含 atempo）回報的輸出時間戳換算為原片媒體時間（秒）。
 * @param {{ at: number, rawTime: number, baseTime: number, speed?: number }} params
 * @returns {number}
 */
export function audioTimestampToMediaPos({ at, rawTime, baseTime, speed = DEFAULT_SPEED }) {
  const start = Number.isFinite(at) ? at : 0;
  const deltaSec = Number.isFinite(rawTime) && Number.isFinite(baseTime) ? Math.max(0, rawTime - baseTime) : 0;
  return advanceMediaClock(start, deltaSec * 1000, speed);
}

/**
 * 計算目前播放時鐘（一律為原片媒體秒數）。
 * @param {{
 *   playing: boolean,
 *   pos: number,
 *   speed?: number,
 *   hasAudio: boolean,
 *   clk: { pos: number, wall: number } | null,
 *   startWall: number,
 *   nowMs: number,
 * }} params
 * @returns {number}
 */
export function computePlaybackClock({ playing, pos, speed = DEFAULT_SPEED, hasAudio, clk, startWall, nowMs }) {
  if (!playing) return pos;
  if (hasAudio && clk) {
    return advanceMediaClock(clk.pos, nowMs - clk.wall, speed);
  }
  if (hasAudio && nowMs - startWall < 4000) return pos;
  return advanceMediaClock(pos, nowMs - startWall, speed);
}
