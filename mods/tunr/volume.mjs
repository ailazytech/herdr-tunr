export const VOLUME_THROTTLE_MS = 50;

/**
 * 將音量百分比規範化到 0–100；無效值回傳 fallback。
 * @param {unknown} value
 * @param {number} [fallback=80]
 * @param {{ round?: boolean }} [opts]
 * @returns {number}
 */
export function clampVolume(value, fallback = 80, { round = false } = {}) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return fallback;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.max(0, Math.min(100, n));
  return round ? Math.round(clamped) : clamped;
}

/**
 * 把 0–100 音量百分比轉成 ffmpeg volume 濾鏡的線性振幅倍率（0.0–1.0）。
 * ffplay 原本的 -volume (0–100) 是依 SDL_MixAudioFormat 做線性振幅縮放，
 * 故以 -volume 100 固定並套用 v / 100，可讓各檔位響度與原本曲線一致。
 * @param {unknown} volume
 * @returns {number}
 */
export function volumeToGain(volume) {
  const v = clampVolume(volume, 80);
  return Number((v / 100).toFixed(4));
}

/**
 * 格式化給 ffmpeg volume 濾鏡或 azmq 指令使用的倍率字串。
 * @param {unknown} volume
 * @returns {string}
 */
export function formatVolumeGain(volume) {
  return String(volumeToGain(volume));
}

/**
 * 組成透過 azmq 送給 volume 濾鏡的即時調音指令。
 * @param {unknown} volume
 * @returns {string}
 */
export function buildAzmqCommand(volume) {
  return `volume volume ${formatVolumeGain(volume)}`;
}

/**
 * 逸出 ffmpeg 濾鏡圖兩層解析（filtergraph + option）中的反斜線與冒號。
 * @param {string} value
 * @returns {string}
 */
export function escapeFilterValue(value) {
  return String(value).replace(/\\/g, "\\\\\\\\").replace(/:/g, "\\\\:");
}

/**
 * 依是否啟用 azmq 埠與倍速組出 ffplay 的 -af 濾鏡字串；不需要任何濾鏡時回傳 null。
 * @param {{ port?: number, volume?: number, speed?: number }} params
 * @returns {string | null}
 */
export function buildAudioFilterChain({ port = 0, volume = 80, speed = 1 } = {}) {
  const filters = [];
  const hasPort = Number.isInteger(port) && port > 0;
  if (hasPort) {
    filters.push(`azmq=bind_address=${escapeFilterValue(`tcp://127.0.0.1:${port}`)}`);
  }
  if (Number.isFinite(speed) && speed > 0 && speed !== 1) {
    filters.push(`atempo=${speed}`);
  }
  if (hasPort) {
    filters.push(`volume=${formatVolumeGain(volume)}`);
  }
  return filters.length > 0 ? filters.join(",") : null;
}

/**
 * 組出 ffplay 啟動參數：有 azmq 埠時固定 -volume 100 並交由濾鏡控制；無 azmq 時退回原本 -volume 啟動重開路徑。
 * @param {{ source: string, at?: number, volume?: number, speed?: number, port?: number, reconnectArgs?: string[] }} params
 * @returns {string[]}
 */
export function buildFfplayAudioArgs({
  source,
  at = 0,
  volume = 80,
  speed = 1,
  port = 0,
  reconnectArgs = [],
}) {
  const hasPort = Number.isInteger(port) && port > 0;
  const vol = clampVolume(volume, 80);
  const args = [
    "-nodisp", "-autoexit", "-hide_banner",
    ...reconnectArgs,
    "-ss", String(at),
    "-volume", hasPort ? "100" : String(Math.round(vol)),
  ];
  const af = buildAudioFilterChain({ port, volume: vol, speed });
  if (af) args.push("-af", af);
  args.push(source);
  return args;
}

/**
 * 從 `ffmpeg -filters`（或 `ffplay -filters`）輸出判斷是否編譯了 azmq 濾鏡。
 * @param {unknown} filtersOutput
 * @returns {boolean}
 */
export function hasAzmqFilter(filtersOutput) {
  if (typeof filtersOutput !== "string" || !filtersOutput) return false;
  return /^\s*\S*\s+azmq(?:\s|$)/m.test(filtersOutput);
}

/**
 * 建立「首發立即送、間隔內合併更新並保證送出最後一個值」的節流器（預設 50ms）。
 * @template T
 * @param {{
 *   intervalMs?: number,
 *   onSend: (value: T) => void,
 *   nowFn?: () => number,
 *   scheduleFn?: (fn: () => void, ms: number) => unknown,
 *   cancelFn?: (handle: unknown) => void,
 * }} opts
 * @returns {{ push: (value: T) => void, flush: () => void, cancel: () => void, isPending: () => boolean }}
 */
export function createThrottle({
  intervalMs = VOLUME_THROTTLE_MS,
  onSend,
  nowFn = () => Date.now(),
  scheduleFn = (fn, ms) => setTimeout(fn, ms),
  cancelFn = (handle) => clearTimeout(handle),
}) {
  const waitMs = Math.max(0, Number(intervalMs) || 0);
  let lastSentAt = -Infinity;
  let hasTimer = false;
  let timerHandle = null;
  let hasPending = false;
  let pendingValue;

  const fire = () => {
    hasTimer = false;
    timerHandle = null;
    if (!hasPending) return;
    const val = pendingValue;
    hasPending = false;
    pendingValue = undefined;
    lastSentAt = nowFn();
    onSend(val);
  };

  return {
    push(value) {
      const t = nowFn();
      const elapsed = t - lastSentAt;
      if (!hasTimer && elapsed >= waitMs) {
        hasPending = false;
        pendingValue = undefined;
        lastSentAt = t;
        onSend(value);
        return;
      }
      pendingValue = value;
      hasPending = true;
      if (!hasTimer) {
        const delay = Math.max(0, waitMs - Math.max(0, elapsed));
        hasTimer = true;
        timerHandle = scheduleFn(fire, delay);
      }
    },
    flush() {
      if (hasTimer) {
        hasTimer = false;
        const h = timerHandle;
        timerHandle = null;
        cancelFn(h);
      }
      if (!hasPending) return;
      const val = pendingValue;
      hasPending = false;
      pendingValue = undefined;
      lastSentAt = nowFn();
      onSend(val);
    },
    cancel() {
      if (hasTimer) {
        hasTimer = false;
        const h = timerHandle;
        timerHandle = null;
        cancelFn(h);
      }
      hasPending = false;
      pendingValue = undefined;
    },
    isPending() {
      return hasPending || hasTimer;
    },
  };
}
