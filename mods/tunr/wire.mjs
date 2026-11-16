/**
 * 把引擎送來的 ASCII 位元組轉成字串（每個位元組直接對應一個字元）。
 * 影像幀是高頻路徑且可能跨 chunk，維持單字節解析不解 UTF-8。
 * @param {Uint8Array} u8
 * @returns {string}
 */
export const ascii = (u8) => {
  let s = "";
  for (let i = 0; i < u8.length; i += 8192) {
    s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 8192)));
  }
  return s;
};

/**
 * 把字串中所有非 ASCII 字元轉成 `\uXXXX`（每個 UTF-16 code unit 各轉一個），
 * 保留代理對結構並確保透過 ASCII TCP 協定傳輸後，`JSON.parse` 可完整還原。
 * @param {string} text
 * @returns {string}
 */
export function escapeAsciiJson(text) {
  return String(text).replace(/[^\x00-\x7f]/g, (ch) => {
    return "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
  });
}
