import { SPEED_STEPS, DEFAULT_SPEED, normalizeSpeed, nextSpeedStep, formatSpeedLabel } from "./speed.mjs";

export { SPEED_STEPS, DEFAULT_SPEED, normalizeSpeed, nextSpeedStep, formatSpeedLabel };
export const SAVED_KEYS = ["volume", "mode", "size", "video", "source", "lastSource", "opacity", "eq", "speed"];
export const MIN_OPACITY = 5;
export const MAX_OPACITY = 100;
export const OPACITY_STEPS = [100, 75, 50, 25, 10, 5];

/**
 * 將背景透明度規範化為 MIN_OPACITY..MAX_OPACITY 的整數百分比。
 * @param {unknown} value
 * @param {number} [fallback=100]
 * @returns {number}
 */
export function clampOpacity(value, fallback = MAX_OPACITY) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_OPACITY, Math.min(MAX_OPACITY, Math.round(n)));
}

/**
 * 依固定步階往下調整背景透明度（100 → 75 → 50 → 25 → 10 → 5 → 回到 100）。
 * @param {unknown} current
 * @returns {number}
 */
export function nextOpacityStep(current) {
  const cur = clampOpacity(current, MAX_OPACITY);
  const lower = OPACITY_STEPS.find((step) => step < cur);
  return lower !== undefined ? lower : OPACITY_STEPS[0];
}

/**
 * 規範化「上一個自己播的來源」：只保留非空字串且不能是 "system"。
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeLastSource(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "system") return null;
  return value;
}

export const DEFAULT_CONFIG = {
  source: null,
  lastSource: null,
  size: "S",
  mode: "mono",
  video: true,
  volume: 80,
  opacity: MAX_OPACITY,
  eq: true,
  speed: DEFAULT_SPEED,
  debug: false,
};

/**
 * 安全解析 JSON 設定文字（支援 UTF-8 BOM）。
 * 若不存在、空白、非合法 JSON 或非物件，回傳 `{}` 而不拋出例外。
 * @param {string | null | undefined} text
 * @returns {Record<string, unknown>}
 */
export function parseConfigText(text) {
  const cleaned = typeof text === "string" ? text.replace(/^\uFEFF/, "") : text;
  if (typeof cleaned !== "string" || cleaned.trim() === "") return {};
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

/**
 * 三層合併啟動設定：程式預設值 → config.json → data/tunr/settings.json。
 * settings.json 只會覆蓋 SAVED_KEYS。
 * @param {Record<string, unknown> | null | undefined} configObj
 * @param {Record<string, unknown> | null | undefined} settingsObj
 * @returns {Record<string, unknown>}
 */
export function resolveStartupConfig(configObj, settingsObj) {
  const out = { ...DEFAULT_CONFIG };
  if (configObj && typeof configObj === "object" && !Array.isArray(configObj)) {
    for (const [k, v] of Object.entries(configObj)) {
      if (v !== undefined) out[k] = v;
    }
  }
  if (settingsObj && typeof settingsObj === "object" && !Array.isArray(settingsObj)) {
    for (const k of SAVED_KEYS) {
      if (Object.prototype.hasOwnProperty.call(settingsObj, k) && settingsObj[k] !== undefined) {
        out[k] = settingsObj[k];
      }
    }
  }
  out.opacity = clampOpacity(out.opacity, DEFAULT_CONFIG.opacity);
  out.eq = out.eq !== false;
  out.speed = normalizeSpeed(out.speed, DEFAULT_CONFIG.speed);
  out.lastSource = normalizeLastSource(out.lastSource);
  if (!out.lastSource && typeof out.source === "string" && out.source !== "system") {
    out.lastSource = normalizeLastSource(out.source);
  }
  return out;
}

/**
 * 讀取既有 config.json 文字內容並只更新指定欄位，回傳 2 格縮排且結尾含換行的 JSON 字串。
 * - 若 existingText 為 null/undefined 或純空白（檔案不存在或空檔），以空物件為基底。
 * - 若 existingText 非合法 JSON 或非一般物件，回傳 null（不拋出例外，也不覆寫壞內容）。
 * - 既有檔案中的 debug 與其他不認得的鍵會原樣保留。
 * @param {string | null | undefined} existingText
 * @param {{ volume?: number, mode?: string, size?: string, video?: boolean, source?: string | null, lastSource?: string | null, opacity?: number, eq?: boolean, speed?: number }} updates
 * @returns {string | null}
 */
export function mergeConfigText(existingText, updates) {
  let base = {};
  const cleaned = typeof existingText === "string" ? existingText.replace(/^\uFEFF/, "") : existingText;
  if (typeof cleaned === "string" && cleaned.trim() !== "") {
    try {
      const parsed = JSON.parse(cleaned);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      base = { ...parsed };
    } catch {
      return null;
    }
  }

  for (const key of SAVED_KEYS) {
    if (updates && Object.prototype.hasOwnProperty.call(updates, key) && updates[key] !== undefined) {
      base[key] = updates[key];
    }
  }

  return JSON.stringify(base, null, 2) + "\n";
}
