export const SAVED_KEYS = ["volume", "mode", "size", "video", "source"];

export const DEFAULT_CONFIG = {
  source: null,
  size: "S",
  mode: "mono",
  video: true,
  volume: 80,
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
 * settings.json 只會覆蓋 SAVED_KEYS（volume、mode、size、video、source）。
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
  return out;
}

/**
 * 讀取既有 config.json 文字內容並只更新指定欄位，回傳 2 格縮排且結尾含換行的 JSON 字串。
 * - 若 existingText 為 null/undefined 或純空白（檔案不存在或空檔），以空物件為基底。
 * - 若 existingText 非合法 JSON 或非一般物件，回傳 null（不拋出例外，也不覆寫壞內容）。
 * - 既有檔案中的 debug 與其他不認得的鍵會原樣保留。
 * @param {string | null | undefined} existingText
 * @param {{ volume?: number, mode?: string, size?: string, video?: boolean, source?: string | null }} updates
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
