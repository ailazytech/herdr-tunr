import { normalizeLastSource } from "./config.js";

/**
 * 遞增引擎連線世代編號。
 * @param {number} currentGen
 * @returns {number}
 */
export function nextGeneration(currentGen) {
  const base = Number.isInteger(currentGen) && currentGen >= 0 ? currentGen : 0;
  return base + 1;
}

/**
 * 檢查某次引擎連線任務是否仍是最新世代。
 * @param {number} gen
 * @param {number} activeGen
 * @returns {boolean}
 */
export function isCurrentGeneration(gen, activeGen) {
  return typeof gen === "number" && Number.isInteger(gen) && gen === activeGen;
}

/**
 * 連線或等待過程是否應中止並保持靜默（視窗已關閉或已有更新的世代）。
 * @param {number} gen
 * @param {number} activeGen
 * @param {boolean} closed
 * @returns {boolean}
 */
export function shouldAbortConnect(gen, activeGen, closed) {
  return Boolean(closed) || !isCurrentGeneration(gen, activeGen);
}

/**
 * 發生連線例外時，是否應更新畫面錯誤狀態並寫入 log（僅最新世代且未關閉才處理）。
 * @param {number} gen
 * @param {number} activeGen
 * @param {boolean} closed
 * @returns {boolean}
 */
export function shouldApplyEngineFailure(gen, activeGen, closed) {
  return !closed && isCurrentGeneration(gen, activeGen);
}

/**
 * 讀取迴圈結束時，是否應回報 engineEnded（必須是當前 socket、最新世代、非 handoff、未關閉）。
 * @param {number} gen
 * @param {number} activeGen
 * @param {boolean} isCurrentSock
 * @param {boolean} closed
 * @param {boolean} handoff
 * @returns {boolean}
 */
export function shouldHandleSocketClose(gen, activeGen, isCurrentSock, closed, handoff) {
  return !closed && !handoff && Boolean(isCurrentSock) && isCurrentGeneration(gen, activeGen);
}

/**
 * 更新來源與 lastSource：
 * - 切到非 system（檔案或網址）時，同時更新 source 與 lastSource。
 * - 切到 system 時，保留原本的 lastSource（若原本尚未記錄且當前來源為檔案／網址，先補記它）。
 * - 清除為 null 時，僅清掉 source，保留 lastSource。
 * @param {{ source?: string | null, lastSource?: string | null }} state
 * @param {string | null | undefined} nextSource
 * @returns {{ source: string | null, lastSource: string | null }}
 */
export function rememberSourceState(state, nextSource) {
  const curSource = typeof state?.source === "string" && state.source.trim() ? state.source : null;
  let lastSource = normalizeLastSource(state?.lastSource);
  if (!lastSource && curSource && curSource !== "system") {
    lastSource = normalizeLastSource(curSource);
  }
  if (!nextSource || typeof nextSource !== "string" || !nextSource.trim()) {
    return { source: null, lastSource };
  }
  if (nextSource === "system") {
    return { source: "system", lastSource };
  }
  return { source: nextSource, lastSource: nextSource };
}

/**
 * 計算 📻（系統音訊）開關切換結果。
 * @param {{ source?: string | null, lastSource?: string | null }} state
 * @param {boolean | null} [targetOn=null] null 代表來回切換；true=開；false=關
 * @returns {{ changed: boolean, action: "noop" | "connect" | "clear", source: string | null, lastSource: string | null }}
 */
export function toggleSystemMode(state, targetOn = null) {
  const isSystem = state?.source === "system";
  const wantOn = targetOn === null ? !isSystem : Boolean(targetOn);
  const existingLast = normalizeLastSource(state?.lastSource);
  const currentNonSystem = normalizeLastSource(state?.source);

  if (wantOn) {
    const nextLast = currentNonSystem ?? existingLast;
    if (isSystem) {
      return { changed: false, action: "noop", source: "system", lastSource: nextLast };
    }
    return { changed: true, action: "connect", source: "system", lastSource: nextLast };
  }

  if (!isSystem) {
    return { changed: false, action: "noop", source: state?.source ?? null, lastSource: currentNonSystem ?? existingLast };
  }

  if (existingLast) {
    return { changed: true, action: "connect", source: existingLast, lastSource: existingLast };
  }
  return { changed: true, action: "clear", source: null, lastSource: null };
}

/**
 * 只回傳來源種類名稱，避免將網址或本機路徑寫入 log。
 * @param {string | null | undefined} source
 * @returns {"none" | "system" | "url" | "file"}
 */
export function classifySourceKind(source) {
  if (!source || typeof source !== "string" || !source.trim()) return "none";
  if (source === "system") return "system";
  if (/^https?:\/\//i.test(source.trim())) return "url";
  return "file";
}

/**
 * 清除錯誤訊息中可能夾帶的網址、本機路徑、--source 參數與換行，只保留錯誤摘要。
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeErrorMessage(raw) {
  let msg = typeof raw === "string" ? raw : String(raw ?? "");
  msg = msg.replace(/[\r\n\t]+/g, " ");
  msg = msg.replace(/--source(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, "--source <redacted>");
  msg = msg.replace(/https?:\/\/[^\s"'<>)]+/gi, "<url>");
  msg = msg.replace(/[A-Za-z]:[\\/][^\s"',;)]+/g, "<path>");
  msg = msg.replace(/\\\\[^\s"',;)]+/g, "<path>");
  msg = msg.replace(/(?:^|\s)\/(?:[^\s/"',;)]+\/)+[^\s"',;)]*/g, " <path>");
  msg = msg.replace(/\s+/g, " ").trim();
  if (msg.length > 160) msg = msg.slice(0, 157) + "...";
  return msg || "unknown";
}

/**
 * 格式化單行視窗錯誤紀錄（只記時間、步驟、來源種類、錯誤類型與去敏訊息）。
 * @param {{ time?: string, step?: string, error?: unknown, source?: string | null }} entry
 * @returns {string}
 */
export function formatWindowLogLine({ time, step, error, source }) {
  const ts = time || new Date().toISOString();
  const safeStep = String(step || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const errObj = error && typeof error === "object" ? error : null;
  const errName = String(errObj?.name || (typeof error === "string" ? "Error" : typeof error) || "Error").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const rawMsg = errObj?.message ?? error ?? "unknown";
  const safeMsg = sanitizeErrorMessage(rawMsg);
  return `${ts} step=${safeStep} source=${classifySourceKind(source)} err=${errName} msg=${safeMsg}`;
}

/**
 * 將新的一行加入既有 log 內容並限制最多保留 maxLines 行（預設 200 行）。
 * @param {string | null | undefined} existingText
 * @param {string} newLine
 * @param {number} [maxLines=200]
 * @returns {string}
 */
export function appendWindowLog(existingText, newLine, maxLines = 200) {
  const limit = Math.max(1, Number(maxLines) || 200);
  const lines = typeof existingText === "string" && existingText
    ? existingText.split(/\r?\n/).filter((l) => l.length > 0)
    : [];
  const cleanNew = String(newLine ?? "").replace(/[\r\n]+/g, " ").trim();
  if (cleanNew) lines.push(cleanNew);
  return lines.slice(-limit).join("\n") + "\n";
}

/**
 * 連線例外時畫面要顯示的訊息：已經連上、在讀取迴圈裡出錯，代表引擎播到一半結束了
 * （Windows 上引擎被關掉時 read 會丟 10054），不是連不上。
 * @param {string} step
 * @returns {"engineEnded" | "connectFailed"}
 */
export function engineFailureMessage(step) {
  return step === "read_loop" ? "engineEnded" : "connectFailed";
}

/**
 * 讀取時的「暫時沒有資料」錯誤：herdr-app 的 sock.read 有讀取逾時，連線閒置一陣子（暫停時引擎不送資料）
 * 就丟錯誤，而不是一直等資料進來。遇到要稍等再讀，不是引擎結束。
 * Linux 11、macOS 35、Windows 10035（EAGAIN／EWOULDBLOCK）；Windows 的讀取逾時是 10060（WSAETIMEDOUT）。
 * 引擎真的結束時，本機連線會收到 EOF 或 10054，不會是這幾個。
 * @param {unknown} err
 * @returns {boolean}
 */
export function isWouldBlockError(err) {
  const msg = String((err && typeof err === "object" && "message" in err ? err.message : err) ?? "");
  return /os error (11|35|10035|10060)\b|temporarily unavailable|would block/i.test(msg);
}

/**
 * hc run 因為同名終端還活著而失敗（另一個 tunr 視窗剛開了引擎，例如 App 更新時 mod 被重載兩次）。
 * @param {unknown} out hc run 的 stderr／stdout
 * @returns {boolean}
 */
export function isNameTakenError(out) {
  return /name_taken|already named/i.test(String(out ?? ""));
}
