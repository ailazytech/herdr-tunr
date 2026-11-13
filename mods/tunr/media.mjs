/**
 * 解析 media.ps1 輸出的一行 JSON。
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

/**
 * 依媒體資訊組合「歌名 — 演出者」，無工作階段或無資訊時回傳 fallbackLabel；
 * 超過 maxChars 時截斷並加上「…」。
 * @param {{ status?: string, title?: string, artist?: string } | null | undefined} media
 * @param {string} fallbackLabel
 * @param {number} maxChars
 * @returns {string}
 */
export function formatMediaLabel(media, fallbackLabel, maxChars = 36) {
  if (!media || media.status === "none") return fallbackLabel;
  const title = typeof media.title === "string" ? media.title.trim() : "";
  const artist = typeof media.artist === "string" ? media.artist.trim() : "";
  let label = "";
  if (title && artist) label = `${title} — ${artist}`;
  else if (title) label = title;
  else if (artist) label = artist;
  else return fallbackLabel;

  if (maxChars > 1 && label.length > maxChars) {
    return label.slice(0, maxChars - 1) + "…";
  }
  return label;
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
