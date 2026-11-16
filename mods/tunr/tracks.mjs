export const PREV_RESTART_SEC = 3;

export const MEDIA_EXTENSIONS = new Set([
  ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".flv", ".wmv",
  ".mpg", ".mpeg", ".ts", ".mts", ".m2ts", ".3gp", ".ogv", ".vob",
  ".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus", ".wma",
  ".aiff", ".aif", ".alac", ".ape", ".wv", ".mka", ".weba", ".oga",
]);

/**
 * 取得檔名的副檔名（小寫、含點號）；無副檔名或以點號開頭的隱藏檔回傳空字串。
 * @param {string} name
 * @returns {string}
 */
export function getMediaExtension(name) {
  if (typeof name !== "string") return "";
  const base = pathBaseName(name);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot).toLowerCase();
}

/**
 * 判斷檔名是否為支援的影音副檔名。
 * @param {string} name
 * @returns {boolean}
 */
export function isMediaFilename(name) {
  return MEDIA_EXTENSIONS.has(getMediaExtension(name));
}

/**
 * 取得路徑最後一段檔名（同時支援 / 與 \）。
 * @param {string} p
 * @returns {string}
 */
export function pathBaseName(p) {
  if (typeof p !== "string") return "";
  const trimmed = p.replace(/[\\/]+$/, "");
  const sep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return sep >= 0 ? trimmed.slice(sep + 1) : trimmed;
}

/**
 * 取得檔案所在資料夾路徑（同時支援 / 與 \）。
 * @param {string} p
 * @returns {string}
 */
export function pathDirName(p) {
  if (typeof p !== "string") return "";
  const sep = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (sep < 0) return "";
  if (sep === 0) return p.slice(0, 1);
  if (sep === 2 && /^[A-Za-z]:/.test(p)) return p.slice(0, 3);
  return p.slice(0, sep);
}

/**
 * 將資料夾與檔名組合成路徑（沿用資料夾原本的斜線風格）。
 * @param {string} dirPath
 * @param {string} name
 * @returns {string}
 */
export function joinDirPath(dirPath, name) {
  if (!dirPath) return name;
  const sep = dirPath.includes("\\") && !dirPath.includes("/") ? "\\" : "/";
  const cleanDir = dirPath.endsWith("/") || dirPath.endsWith("\\") ? dirPath : dirPath + sep;
  return cleanDir + name;
}

function splitStemAndExt(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

const isDigitChar = (ch) => ch >= "0" && ch <= "9";

function readDigits(str, start) {
  let end = start;
  while (end < str.length && isDigitChar(str[end])) end++;
  return [str.slice(start, end), end];
}

function compareDigitTokens(a, b) {
  const sa = a.replace(/^0+/, "") || "0";
  const sb = b.replace(/^0+/, "") || "0";
  if (sa.length !== sb.length) return sa.length - sb.length;
  if (sa !== sb) return sa < sb ? -1 : 1;
  return 0;
}

function compareNaturalSegment(a, b) {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a[i];
    const cb = b[j];
    if (isDigitChar(ca) && isDigitChar(cb)) {
      const [da, nextI] = readDigits(a, i);
      const [db, nextJ] = readDigits(b, j);
      const cmp = compareDigitTokens(da, db);
      if (cmp !== 0) return cmp;
      i = nextI;
      j = nextJ;
      continue;
    }
    const la = ca.toLowerCase();
    const lb = cb.toLowerCase();
    if (la !== lb) return la < lb ? -1 : 1;
    i++;
    j++;
  }
  return (a.length - i) - (b.length - j);
}

/**
 * 自然排序比較器（例如 a2 排在 a10 前面，主檔名優先於副檔名）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareNaturalNames(a, b) {
  if (a === b) return 0;
  const [stemA, extA] = splitStemAndExt(a);
  const [stemB, extB] = splitStemAndExt(b);
  const stemCmp = compareNaturalSegment(stemA, stemB);
  if (stemCmp !== 0) return stemCmp;
  const extCmp = compareNaturalSegment(extA, extB);
  if (extCmp !== 0) return extCmp;
  return a < b ? -1 : 1;
}

/**
 * 依資料夾同一層的目錄項目建立自然排序影音清單並找出目前檔案位置。
 * @param {Array<string | { name: string, isDirectory?: () => boolean }>} entries
 * @param {string} currentPath
 * @param {string} [dirPath]
 * @returns {{ kind: "folder", dir: string, tracks: string[], index: number }}
 */
export function buildFolderTrackList(entries, currentPath, dirPath = pathDirName(currentPath)) {
  const names = [];
  for (const entry of entries ?? []) {
    if (typeof entry === "string") {
      if (isMediaFilename(entry)) names.push(entry);
    } else if (entry && typeof entry.name === "string") {
      if (typeof entry.isDirectory === "function" && entry.isDirectory()) continue;
      if (isMediaFilename(entry.name)) names.push(entry.name);
    }
  }
  names.sort(compareNaturalNames);
  const tracks = names.map((name) => joinDirPath(dirPath, name));
  const targetBase = pathBaseName(currentPath);
  let index = names.indexOf(targetBase);
  if (index < 0 && targetBase) {
    const lowerTarget = targetBase.toLowerCase();
    index = names.findIndex((n) => n.toLowerCase() === lowerTarget);
  }
  return { kind: "folder", dir: dirPath, tracks, index };
}

/**
 * 解析 YouTube 網址中的影片 ID（v）與播放清單 ID（list）。
 * 非 YouTube 或非 HTTP(S) 網址回傳 null。
 * @param {string} source
 * @returns {{ listId: string | null, videoId: string | null, isMix: boolean, isPlaylistPath: boolean } | null}
 */
export function parseYouTubeSource(source) {
  if (typeof source !== "string") return null;
  let url;
  try {
    url = new URL(source.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const isYtHost =
    host === "youtu.be" ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com");
  if (!isYtHost) return null;

  const listId = url.searchParams.get("list")?.trim() || null;
  let videoId = null;
  if (host === "youtu.be") {
    videoId = url.pathname.replace(/^\/+/, "").split("/")[0]?.trim() || null;
  } else {
    videoId = url.searchParams.get("v")?.trim() || null;
    if (!videoId) {
      const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname);
      if (m) videoId = m[1];
    }
  }
  return {
    listId,
    videoId,
    isMix: Boolean(listId && /^RD/i.test(listId)),
    isPlaylistPath: url.pathname === "/playlist",
  };
}

/**
 * 組成可還原清單狀態的 YouTube 曲目網址（watch?v=<id>&list=<listId>）。
 * @param {string} videoId
 * @param {string} listId
 * @returns {string}
 */
export function buildYouTubeTrackUrl(videoId, listId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&list=${encodeURIComponent(listId)}`;
}

/**
 * 決定 yt-dlp --flat-playlist 要查詢的網址（保留 v= 以支援 RD 合輯）。
 * @param {{ listId: string | null, videoId: string | null }} parsed
 * @param {string} fallbackSource
 * @returns {string}
 */
export function buildYouTubePlaylistFetchUrl(parsed, fallbackSource) {
  if (parsed?.videoId && parsed?.listId) {
    return buildYouTubeTrackUrl(parsed.videoId, parsed.listId);
  }
  if (parsed?.listId) {
    return `https://www.youtube.com/playlist?list=${encodeURIComponent(parsed.listId)}`;
  }
  return fallbackSource;
}

/**
 * 從 yt-dlp --flat-playlist --dump-single-json 輸出中擷取曲目影片 ID 陣列。
 * @param {string | Record<string, any> | null | undefined} jsonInput
 * @returns {string[]}
 */
export function extractPlaylistVideoIds(jsonInput) {
  let data = jsonInput;
  if (typeof jsonInput === "string") {
    try {
      data = JSON.parse(jsonInput);
    } catch {
      return [];
    }
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.entries)) return [];
  const ids = [];
  for (const entry of data.entries) {
    if (!entry || typeof entry !== "object") continue;
    let id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id && typeof entry.url === "string") {
      id = parseYouTubeSource(entry.url)?.videoId ?? "";
    }
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * 由清單影片 ID 陣列與目前影片 ID 建立 YouTube 清單狀態。
 * @param {string[]} videoIds
 * @param {string | null} currentVideoId
 * @param {string} listId
 * @returns {{ kind: "youtube", listId: string, videoIds: string[], tracks: string[], index: number }}
 */
export function buildYouTubeTrackList(videoIds, currentVideoId, listId) {
  const cleanIds = Array.isArray(videoIds)
    ? videoIds.filter((id) => typeof id === "string" && id.trim().length > 0)
    : [];
  const tracks = cleanIds.map((id) => buildYouTubeTrackUrl(id, listId));
  const index = currentVideoId ? cleanIds.indexOf(currentVideoId) : -1;
  return { kind: "youtube", listId, videoIds: cleanIds, tracks, index };
}

/**
 * 空的曲目清單狀態（單曲、無來源、系統音訊或載入前預設）。
 * @param {boolean} [loading=false]
 * @returns {{ kind: "none", tracks: string[], index: number, loading: boolean }}
 */
export function emptyTrackState(loading = false) {
  return { kind: "none", tracks: [], index: -1, loading: Boolean(loading) };
}

/**
 * 抓不到 YouTube 清單時的狀態（例如私人清單、已刪除）：按鈕變灰，滑鼠提示說明原因。
 * @returns {{ kind: "none", tracks: string[], index: number, loading: boolean, failed: true }}
 */
export function failedTrackState() {
  return { ...emptyTrackState(false), failed: true };
}

/**
 * 上一首／下一首按鈕的滑鼠提示字串 key。
 * @param {{ failed?: boolean } | null | undefined} trackState
 * @param {"prev" | "next"} dir
 * @returns {"listUnavailable" | "prevTrack" | "nextTrack"}
 */
export function trackNavTipKey(trackState, dir) {
  if (trackState?.failed) return "listUnavailable";
  return dir === "prev" ? "prevTrack" : "nextTrack";
}

/**
 * 計算上一首／下一首按鈕是否可用。
 * @param {{ tracks?: string[], index?: number, loading?: boolean } | null | undefined} trackState
 * @returns {{ hasPrev: boolean, hasNext: boolean, canPrev: boolean, canNext: boolean }}
 */
export function getTrackNavState(trackState) {
  if (
    !trackState ||
    trackState.loading ||
    !Array.isArray(trackState.tracks) ||
    trackState.tracks.length <= 1 ||
    typeof trackState.index !== "number" ||
    trackState.index < 0 ||
    trackState.index >= trackState.tracks.length
  ) {
    return { hasPrev: false, hasNext: false, canPrev: false, canNext: false };
  }
  const hasPrev = trackState.index > 0;
  const hasNext = trackState.index < trackState.tracks.length - 1;
  return { hasPrev, hasNext, canPrev: hasPrev, canNext: hasNext };
}

/**
 * 上一首規則：播放位置超過 3 秒先回到開頭；3 秒內才跳到前一首。
 * @param {{ tracks?: string[], index?: number, loading?: boolean } | null | undefined} trackState
 * @param {number} posSec
 * @returns {{ action: "none" } | { action: "seek0" } | { action: "load", source: string, index: number }}
 */
export function decidePrevAction(trackState, posSec) {
  const nav = getTrackNavState(trackState);
  if (!nav.canPrev) return { action: "none" };
  const pos = Number.isFinite(posSec) ? posSec : 0;
  if (pos > PREV_RESTART_SEC) {
    return { action: "seek0" };
  }
  const index = trackState.index - 1;
  return { action: "load", source: trackState.tracks[index], index };
}

/**
 * 下一首規則：有下一首時切到下一首。
 * @param {{ tracks?: string[], index?: number, loading?: boolean } | null | undefined} trackState
 * @returns {{ action: "none" } | { action: "load", source: string, index: number }}
 */
export function decideNextAction(trackState) {
  const nav = getTrackNavState(trackState);
  if (!nav.canNext) return { action: "none" };
  const index = trackState.index + 1;
  return { action: "load", source: trackState.tracks[index], index };
}

/**
 * 判斷一首播完時是否應該自動接續下一首：
 * 必須非系統音訊、無錯誤、已停止且為 ended（手動暫停 ended=false 不會觸發）、尚未接續過、且仍有下一首。
 * @param {{
 *   isSystem?: boolean,
 *   prevEnded?: boolean,
 *   status?: { playing?: boolean, ended?: boolean, error?: string | null } | null,
 *   trackState?: { tracks?: string[], index?: number, loading?: boolean } | null,
 *   alreadyAdvanced?: boolean,
 * }} params
 * @returns {{ advance: false } | { advance: true, source: string, index: number }}
 */
export function shouldAutoAdvance({ isSystem, prevEnded, status, trackState, alreadyAdvanced }) {
  if (isSystem || alreadyAdvanced || prevEnded) return { advance: false };
  if (!status || status.error || status.playing || !status.ended) return { advance: false };
  const next = decideNextAction(trackState);
  if (next.action !== "load") return { advance: false };
  return { advance: true, source: next.source, index: next.index };
}
