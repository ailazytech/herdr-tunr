export const EARLY_END_MARGIN_SEC = 2;
export const MAX_STREAM_RETRIES = 3;
export const SUCCESS_PLAY_RESET_MS = 10_000;
export const RECONNECT_INPUT_ARGS = [
  "-reconnect", "1",
  "-reconnect_streamed", "1",
  "-reconnect_on_network_error", "1",
  "-reconnect_delay_max", "5",
];

/**
 * 判斷來源字串是否為 http(s) 網路網址（本機檔案回傳 false）。
 * @param {unknown} source
 * @returns {boolean}
 */
export function isHttpSource(source) {
  return typeof source === "string" && /^https?:\/\//i.test(source.trim());
}

/**
 * 判斷 ffplay 結束時是真的播完、需要從目前位置接著重試，還是重試次數用盡失敗。
 * - 有時長（dur > 0）且 clock 離 dur 還有 2 秒以上，或 exit code 非 0：視為中斷／失敗。
 * - 若有正常播放達 10 秒以上（hasClk 且經過 >= 10 秒），先將重試次數歸零再算本次。
 * - 同一位置附近連續失敗達 3 次，回傳 playFailed 並停止，不觸發自動接續。
 * - 無時長（dur <= 0，例如直播）維持原本 exit code / clk 判斷。
 *
 * @param {{
 *   clock: number,
 *   dur: number,
 *   code: number | null,
 *   retries?: number,
 *   lastSuccessAtMs?: number | null,
 *   nowMs?: number,
 *   hasClk?: boolean,
 *   extracted?: boolean,
 *   startAt?: number,
 * }} params
 * @returns {{ action: "ended", nextRetries: 0 }
 *   | { action: "retry", resumeAt: number, nextRetries: number, refreshUrl: boolean }
 *   | { action: "fail", error: "playFailed", nextRetries: number }}
 */
export function evaluateAudioExit({
  clock,
  dur,
  code,
  retries = 0,
  lastSuccessAtMs = null,
  nowMs = Date.now(),
  hasClk = true,
  extracted = false,
  startAt = 0,
}) {
  const pos = Number.isFinite(clock) ? Math.max(0, clock) : 0;
  const totalDur = Number.isFinite(dur) && dur > 0 ? dur : 0;
  const exitCode = code === 0 ? 0 : (code ?? 1);
  const startPos = Number.isFinite(startAt) ? Math.max(0, startAt) : 0;

  const playedLongEnough =
    Boolean(hasClk) &&
    Number.isFinite(lastSuccessAtMs) &&
    lastSuccessAtMs > 0 &&
    (nowMs - lastSuccessAtMs) >= SUCCESS_PLAY_RESET_MS;
  const effectiveRetries = playedLongEnough ? 0 : Math.max(0, Number(retries) || 0);

  if (totalDur > 0) {
    const remaining = totalDur - pos;
    if (
      exitCode === 0 &&
      remaining < EARLY_END_MARGIN_SEC &&
      (!extracted || hasClk || startPos >= totalDur - 1)
    ) {
      return { action: "ended", nextRetries: 0 };
    }
  } else {
    if (exitCode === 0 && (!extracted || hasClk)) {
      return { action: "ended", nextRetries: 0 };
    }
  }

  if (effectiveRetries >= MAX_STREAM_RETRIES) {
    return { action: "fail", error: "playFailed", nextRetries: effectiveRetries };
  }

  const nextRetries = effectiveRetries + 1;
  const resumeAt = totalDur > 0 ? Math.min(pos, totalDur) : pos;
  const refreshUrl = Boolean(extracted && (exitCode !== 0 || !hasClk || effectiveRetries >= 1));
  return { action: "retry", resumeAt, nextRetries, refreshUrl };
}
