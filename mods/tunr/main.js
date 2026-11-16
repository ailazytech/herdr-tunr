// tunr：小小的懸浮播放器。影像在背景引擎（tunr.mjs：ffmpeg 轉 ASCII、ffplay 放聲音）裡算好，
// 用本機 TCP 一幀一幀送來，這裡只負責畫（黑白或低彩度）和控制列。可以關畫面只留聲音。
//
// 開法：herdr-app do mod.open --name tunr（或 herdr-quota 狀態列的 tunr 按鈕）。這個實例只是啟動器：它開出真正的懸浮視窗
// （kind window、key tunr、keep：記住位置，App 重開後回來），然後把自己關掉。視窗開著時再 mod.open 一次會關掉視窗。
// 設定放同一個資料夾的 config.json（沒有也行）：
//   { "source": "C:/Videos/a.mp4" | "system", "size": "S|M|L", "mode": "mono|low", "video": true, "eq": true, "volume": 80, "speed": 1, "opacity": 100, "debug": false }
// 把影音檔拖進視窗也能換來源。debug: true 會多一顆 FPS 鈕，並每 2 秒把量到的數字寫到 ~/.config/herdr-app/data/tunr-stats.json。
//
// 指令：herdr-app do tunr.toggle（播放／暫停）、tunr.prev（上一首）、tunr.next（下一首）、tunr.video、tunr.eq、tunr.mode、tunr.size、tunr.bigger、tunr.smaller、tunr.opacity、tunr.volume-up、tunr.volume-down、tunr.speed、tunr.system、tunr.system-on、tunr.system-off、tunr.close（只到視窗那份）
import { View, div, svg, PathBuilder, Background } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, SliderState, Slider, SliderTrack, SliderIndicator, SliderThumb } from "gpui-base";
import { props, openOverlay, closeOverlay, appHome, hc, shared, setShared, nextCommand, theme, exec } from "herdr";
import { t as translate, language, initLanguage } from "./i18n.js";
import { windowSize, doesFit, nextFitSize, biggerFitSize, smallerSize, canOpenVideo, bestFitSize, compactHeaderFitsTime, eqBandCount, SIZES, CHAR_W, LINE_H, PAD, HEADER_H, CONTROLS_H, COMPACT_H } from "./layout.js";
import { mergeConfigText, parseConfigText, resolveStartupConfig, clampOpacity, MIN_OPACITY, MAX_OPACITY, nextOpacityStep, normalizeLastSource } from "./config.js";
import { DEFAULT_SPEED, normalizeSpeed, nextSpeedStep, formatSpeedLabel } from "./speed.mjs";
import { VOLUME_THROTTLE_MS, clampVolume, createThrottle } from "./volume.mjs";
import { nextGeneration, shouldAbortConnect, shouldApplyEngineFailure, shouldHandleSocketClose, rememberSourceState, toggleSystemMode, formatWindowLogLine, appendWindowLog, engineFailureMessage, isWouldBlockError, isNameTakenError } from "./engine-state.mjs";
import { parseYouTubeSource, buildYouTubeTrackUrl, buildYouTubePlaylistFetchUrl, extractPlaylistVideoIds, buildYouTubeTrackList, buildFolderTrackList, failedTrackState, trackNavTipKey, pathDirName, pathBaseName, emptyTrackState, getTrackNavState, decidePrevAction, decideNextAction, shouldAutoAdvance } from "./tracks.mjs";
import { formatMediaLabel, mediaButtonStates } from "./media.mjs";
import { ascii } from "./wire.mjs";
import { decodeEqBands } from "./eq.mjs";
import { fps_monitor } from "gpui-fps";
import net from "net";
import { readFile, writeFile, mkdir } from "fs/promises";

const MOD = "tunr";
const ENGINE_NAME = "tunr-engine";
// 低彩度的 8 個顏色：0 中性、1 紅、2 黃、3 綠、4 青、5 藍、6 洋紅、7 亮中性（飽和度都壓在 0.2–0.3）
const PALETTE = ["#b4b4b4", "#c49a9a", "#c4b896", "#9ec4a0", "#96bcc4", "#9aa4c8", "#c49ac0", "#e2e2e2"];
const MONO_COLOR = "#d4d4d4";
const tr = (key, vars = {}) => translate(key, vars, language(shared));
const iconPath = (name) => `mods/${MOD}/icons/${name}.svg`;

const parseHexRgb = (hex) => {
  if (typeof hex !== "string" || !hex.startsWith("#")) return null;
  const raw = hex.slice(1);
  if (raw.length === 3 || raw.length === 4) {
    const r = parseInt(raw[0] + raw[0], 16);
    const g = parseInt(raw[1] + raw[1], 16);
    const b = parseInt(raw[2] + raw[2], 16);
    const a = raw.length === 4 ? parseInt(raw[3] + raw[3], 16) : 255;
    if ([r, g, b, a].some(Number.isNaN)) return null;
    return { r, g, b, a };
  }
  if (raw.length === 6 || raw.length === 8) {
    const r = parseInt(raw.slice(0, 2), 16);
    const g = parseInt(raw.slice(2, 4), 16);
    const b = parseInt(raw.slice(4, 6), 16);
    const a = raw.length === 8 ? parseInt(raw.slice(6, 8), 16) : 255;
    if ([r, g, b, a].some(Number.isNaN)) return null;
    return { r, g, b, a };
  }
  return null;
};

const withAlpha = (hex, factor) => {
  const rgb = parseHexRgb(hex);
  if (!rgb) return hex;
  const f = Math.max(0, Math.min(1, factor));
  const alphaByte = Math.round((rgb.a / 255) * f * 255).toString(16).padStart(2, "0");
  const hexByte = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${hexByte(rgb.r)}${hexByte(rgb.g)}${hexByte(rgb.b)}${alphaByte}`;
};

const isDarkColor = (hex) => {
  const rgb = parseHexRgb(hex);
  if (!rgb) return true;
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) < 128;
};

const formatSourceTitle = (source, fallback) => {
  if (!source) return fallback;
  if (/^https?:\/\//i.test(source)) {
    return source.replace(/^https?:\/\//i, "");
  }
  return source.split(/[\\/]/).pop() || fallback;
};

const dir = () => `${appHome()}/mods/${MOD}`;
const settingsPath = () => `${appHome()}/data/${MOD}/settings.json`;
const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
const mmss = (t) => {
  t = Math.max(0, Math.floor(t || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

async function readJsonSafe(path) {
  try {
    return parseConfigText(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

async function readWindowPlace(key) {
  try {
    const raw = JSON.parse(await readFile(`${appHome()}/windows.json`, "utf8"));
    const pl = raw.places?.[key];
    if (Array.isArray(pl) && pl.length >= 2 && Number.isFinite(pl[0]) && Number.isFinite(pl[1])) {
      return { x: pl[0], y: pl[1] };
    }
  } catch {}
  return null;
}

const EQ_STATES = new Map();
let nextEqKeySeq = 1;

class CompactEqView extends View {
  init(p) {
    this.eqKey = p?.key ?? "";
  }

  render() {
    const st = EQ_STATES.get(this.eqKey);
    if (!st || !st.visible || !st.levels || st.count <= 0) {
      return div();
    }
    const t0 = st.debug ? now() : 0;
    const innerW = Math.max(16, (st.width || 304) - 2);
    const innerH = Math.max(16, (st.height || COMPACT_H) - 2);
    const count = st.count;
    const pitch = 8;
    const barW = 6;
    const totalSpan = count * pitch - (pitch - barW);
    const startX = Math.max(0, Math.floor((innerW - totalSpan) / 2));
    const maxBarH = Math.max(8, innerH - 4);
    const canPaintPath = typeof window !== "undefined" && typeof window?.paint_path === "function" && typeof PathBuilder !== "undefined";

    let drawn = 0;
    let outEl;

    const toXPct = (px) => `${((px / innerW) * 100).toFixed(3)}%`;
    const toYPct = (py) => `${((py / innerH) * 100).toFixed(3)}%`;

    if (canPaintPath) {
      if (st.mode !== "low") {
        const pb = PathBuilder.fill();
        for (let i = 0; i < count; i++) {
          const lvl = st.levels[i];
          if (lvl <= 0) continue;
          const barH = Math.max(4, Math.round((lvl / 9) * maxBarH));
          const x0 = toXPct(startX + i * pitch);
          const x1 = toXPct(startX + i * pitch + barW);
          const y0 = toYPct(innerH - barH);
          pb.move_to(x0, y0).line_to(x1, y0).line_to(x1, "100%").line_to(x0, "100%").close();
          drawn++;
        }
        outEl = drawn > 0
          ? div().relative().w(innerW).h(innerH).overflow_hidden().child(
              window.paint_path(pb.build(), Background.solid(st.monoColor)).absolute().top(0).left(0).w(innerW).h(innerH)
            )
          : div().w(innerW).h(innerH);
      } else {
        const builders = [null, null, null, null];
        for (let i = 0; i < count; i++) {
          const lvl = st.levels[i];
          if (lvl <= 0) continue;
          const bucket = lvl <= 3 ? 0 : lvl <= 6 ? 1 : lvl <= 8 ? 2 : 3;
          const pb = (builders[bucket] ??= PathBuilder.fill());
          const barH = Math.max(4, Math.round((lvl / 9) * maxBarH));
          const x0 = toXPct(startX + i * pitch);
          const x1 = toXPct(startX + i * pitch + barW);
          const y0 = toYPct(innerH - barH);
          pb.move_to(x0, y0).line_to(x1, y0).line_to(x1, "100%").line_to(x0, "100%").close();
          drawn++;
        }
        if (drawn === 0) {
          outEl = div().w(innerW).h(innerH);
        } else {
          const layers = [];
          for (let b = 0; b < builders.length; b++) {
            if (builders[b]) {
              const color = st.bucketColors[b] ?? st.monoColor;
              layers.push(window.paint_path(builders[b].build(), Background.solid(color)).absolute().top(0).left(0).w(innerW).h(innerH));
            }
          }
          outEl = div().relative().w(innerW).h(innerH).overflow_hidden().children(layers);
        }
      }
    } else {
      const bars = [];
      for (let i = 0; i < count; i++) {
        const lvl = st.levels[i];
        const barH = lvl > 0 ? Math.max(4, Math.round((lvl / 9) * maxBarH)) : 0;
        const color = st.mode === "low"
          ? (st.bucketColors[lvl <= 3 ? 0 : lvl <= 6 ? 1 : lvl <= 8 ? 2 : 3] ?? st.monoColor)
          : st.monoColor;
        if (lvl > 0) drawn++;
        bars.push(div().w(barW).h(barH).bg(lvl > 0 ? color : "#00000000").rounded_t(2));
      }
      outEl = h_flex().w(innerW).h(innerH).items_end().px(startX).gap(pitch - barW).children(bars);
    }

    if (st.debug && st.stats) {
      const dt = now() - t0;
      st.stats.st.eqRenders++;
      st.stats.st.eqJsMs += dt;
      st.stats.win.eqRenders++;
      st.stats.win.eqJsMs += dt;
      st.stats.win.eqBarsDrawn += drawn;
    }
    return outEl;
  }
}

export default class Tunr extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.isWindow = Boolean(p.window);
    if (!this.isWindow) {
      cx.spawn(async (acx) => {
        try { await this.launch(acx, p); } catch (e) { await writeFile(`${appHome()}/data/tunr-launch-error.txt`, String(e?.stack ?? e)); }
      });
      return;
    }
    this.cfg = p.cfg ?? {};
    this.source = p.source ?? null;
    this.lastSource = normalizeLastSource(p.lastSource ?? this.cfg?.lastSource ?? (this.source && this.source !== "system" ? this.source : null));
    this.sizeKey = p.size ?? "S";
    this.mode = p.mode ?? "mono";
    this.video = p.video !== false;
    this.eq = p.eq !== false;
    this.volume = clampVolume(p.volume ?? 80, 80, { round: true });
    this.speed = normalizeSpeed(p.speed ?? this.cfg?.speed, DEFAULT_SPEED);
    this.opacity = clampOpacity(p.opacity ?? this.cfg?.opacity, MAX_OPACITY);
    this.debug = Boolean(p.debug);
    this.notice = null;
    this.noticeToken = 0;
    this.saveToken = 0;
    this.savePending = false;
    this.pos = p.at ? { x: p.at.x, y: p.at.y } : null;
    this.bounds = p.bounds ? { ...p.bounds } : null;
    if (!this.pos) {
      readWindowPlace(MOD).then((pl) => {
        if (pl && !this.pos) this.pos = pl;
      }).catch(() => {});
    }
    this.showFps = false;
    this.showOpacity = false;
    this.opacitySlider = SliderState.new({ min: MIN_OPACITY, max: MAX_OPACITY, step: 1, value: this.opacity });
    this.opacitySlider.on("change", (val, sliderCx) => {
      this.setOpacity(sliderCx, val, false, false);
    });
    this.opacitySlider.on("release", (val, sliderCx) => {
      this.setOpacity(sliderCx, val, true, false);
    });
    this.showVolume = false;
    let volTimerToken = 0;
    this.volumeThrottle = createThrottle({
      intervalMs: VOLUME_THROTTLE_MS,
      nowFn: now,
      scheduleFn: (fn, ms) => {
        const token = ++volTimerToken;
        cx.spawn(async (acx) => {
          if (ms > 0) await acx.sleep(ms);
          if (volTimerToken === token && !this.closed) fn();
        });
        return token;
      },
      cancelFn: (token) => {
        if (volTimerToken === token) volTimerToken++;
      },
      onSend: (val) => {
        if (!this.closed) this.send({ cmd: "volume", value: val });
      },
    });
    this.volumeSlider = SliderState.new({ min: 0, max: 100, step: 5, value: this.volume });
    this.volumeSlider.on("change", (val, sliderCx) => {
      this.setVolume(sliderCx, val, false, false);
    });
    this.volumeSlider.on("release", (val, sliderCx) => {
      this.setVolume(sliderCx, val, true, false);
    });
    this.seeking = false;
    this.seekDragFrac = 0;
    this.seekLockUntil = 0;
    this.seekTargetPos = 0;
    this.seekSlider = SliderState.new({ min: 0, max: 1000, step: 1, value: 0 });
    this.seekSlider.on("change", (val, sliderCx) => {
      if (!this.status?.dur) return;
      this.seeking = true;
      this.seekDragFrac = Math.max(0, Math.min(1, Number(val) / 1000));
      sliderCx.notify();
    });
    this.seekSlider.on("release", (val, sliderCx) => {
      this.commitSeekSlider(sliderCx, val);
    });
    this.frame = "";
    this.status = { pos: 0, dur: 0, playing: false };
    this.shownSecond = -1;
    this.message = this.source ? "connecting" : "drop";
    this.installCommand = "winget install yt-dlp.yt-dlp";
    this.showUrl = false;
    this.urlInput = null;
    cx.spawn(async (acx) => {
      await initLanguage(shared, setShared, exec);
      try {
        const r = await exec("node", ["-p", "process.platform"]);
        const plat = r.stdout.trim();
        this.platform = plat;
        if (plat === "darwin") this.installCommand = "brew install yt-dlp";
        else if (plat === "linux") this.installCommand = "pipx install yt-dlp";
      } catch {}
      acx.notify();
    });
    this.sock = null;
    this.engineGen = 0;
    this.engineStartQueue = Promise.resolve();
    this.handoff = false;
    this.closed = false;
    this.pendingFrame = false;
    this.pendingEq = false;
    this.playlistCache = new Map(Array.isArray(p.playlistCache) ? p.playlistCache : []);
    this.trackState = emptyTrackState(false);
    this.autoAdvancedGen = 0;
    this.resumedConnect = Boolean(p.resume?.port);
    if (this.debug) {
      const t = now();
      this.st = { t0: t, received: 0, shown: 0, dropped: 0, renders: 0, jsMs: 0, segs: 0, rowsDrawn: 0, eqRenders: 0, eqJsMs: 0 };
      this.win = { received: 0, shown: 0, dropped: 0, renders: 0, jsMs: 0, segs: 0, eqRenders: 0, eqJsMs: 0, eqBarsDrawn: 0, since: t };
    }
    const initBands = eqBandCount(SIZES[this.sizeKey]?.cols ?? SIZES.S.cols);
    const initCompactSize = windowSize(this.sizeKey, false);
    this.eqKey = `eq-${nextEqKeySeq++}`;
    this.eqState = {
      visible: false,
      mode: this.mode,
      levels: new Uint8Array(initBands),
      count: initBands,
      hasBars: false,
      width: initCompactSize.width,
      height: initCompactSize.height,
      monoColor: withAlpha(MONO_COLOR, 0.24),
      bucketColors: [
        withAlpha(PALETTE[3], 0.24),
        withAlpha(PALETTE[2], 0.26),
        withAlpha(PALETTE[1], 0.28),
        withAlpha(PALETTE[6], 0.28),
      ],
      debug: this.debug,
      stats: this.debug ? this : null,
    };
    EQ_STATES.set(this.eqKey, this.eqState);
    this.eqView = cx.new(CompactEqView, { key: this.eqKey });
    if (this.source) {
      const gen = this.bumpGeneration();
      const yt = this.source !== "system" ? parseYouTubeSource(this.source) : null;
      if (yt?.listId && !yt.videoId) {
        cx.spawn(async (acx) => this.resolvePurePlaylist(acx, this.source, yt, gen));
      } else {
        cx.spawn(async (acx) => this.connectEngine(acx, p.resume ?? null, gen));
        if (this.source !== "system") {
          this.startTrackDiscovery(cx, this.source, gen);
        }
      }
    }
    cx.spawn(async (acx) => {
      await acx.sleep(50);
      await this.ensureFit(acx);
    });
    cx.spawn(async (acx) => {
      for (;;) {
        const c = await nextCommand();
        if (this.closed) return;
        if (c === "toggle") this.send({ cmd: "toggle" });
        if (c === "next") this.nextTrack(acx);
        if (c === "prev") this.prevTrack(acx);
        if (c === "video") await this.setVideo(acx, !this.video);
        if (c === "eq") this.setEq(acx, !this.eq);
        if (c === "mode") this.setMode(acx, !this.mode || this.mode === "mono" ? "low" : "mono");
        if (c === "size") await this.cycleSize(acx);
        if (c === "bigger") await this.stepBigger(acx);
        if (c === "smaller") await this.stepSmaller(acx);
        if (c === "opacity") this.cycleOpacity(acx);
        if (c === "volume-up") this.setVolume(acx, this.volume + 10);
        if (c === "volume-down") this.setVolume(acx, this.volume - 10);
        if (c === "speed") this.stepSpeed(acx, 1);
        if (c === "system") acx.spawn(async (taskCx) => this.toggleSystem(taskCx, null));
        if (c === "system-on") acx.spawn(async (taskCx) => this.toggleSystem(taskCx, true));
        if (c === "system-off") acx.spawn(async (taskCx) => this.toggleSystem(taskCx, false));
        if (c === "close") closeOverlay(props().overlay);
        if (c === "language-auto") setShared("ui.language", "auto");
        if (c === "language-zh") setShared("ui.language", "zh-TW");
        if (c === "language-en") setShared("ui.language", "en");
        acx.notify();
      }
    });
    if (this.debug) cx.timer.every(2000, () => this.dumpStats());
  }

  // ---- 啟動器 ----
  async launch(_acx, p) {
    const rawCfg = await readJsonSafe(`${dir()}/config.json`);
    const rawSettings = await readJsonSafe(settingsPath());
    const cfg = resolveStartupConfig(rawCfg, rawSettings);
    // 視窗已經開著：這次 mod.open 當作關掉它
    const open = shared("tunr.window");
    if (open && open !== p.overlay) {
      try {
        closeOverlay(open);
        setShared("tunr.window", null);
        closeOverlay(p.overlay);
        return;
      } catch {
        setShared("tunr.window", null);
      }
    }
    let sizeKey = SIZES[cfg.size] ? cfg.size : "S";
    const video = cfg.video !== false;
    const place = await readWindowPlace(MOD);
    const vp = typeof window !== "undefined" && window?.viewport_size ? window.viewport_size() : null;

    if (place && vp && !doesFit(place, windowSize(sizeKey, video), vp)) {
      const best = bestFitSize(place, video, vp);
      if (best) sizeKey = best;
    }

    const { width, height } = windowSize(sizeKey, video);
    const spec = {
      mod: MOD, kind: "window", key: "tunr", keep: true, frame: "none", width, height,
      props: {
        window: true, source: cfg.source ?? null, lastSource: cfg.lastSource ?? null,
        size: sizeKey, mode: cfg.mode === "low" ? "low" : "mono",
        video, eq: cfg.eq !== false, volume: cfg.volume ?? 80, speed: normalizeSpeed(cfg.speed, DEFAULT_SPEED), opacity: clampOpacity(cfg.opacity, MAX_OPACITY), debug: Boolean(cfg.debug), cfg,
      },
    };
    const id = openOverlay(spec);
    setShared("tunr.window", id);
    closeOverlay(p.overlay);
  }

  // ---- 引擎 ----
  bumpGeneration() {
    this.engineGen = nextGeneration(this.engineGen);
    return this.engineGen;
  }

  // 引擎的開、關一次只做一件。佇列空著就直接執行，不經過 .then：
  // 在 cx.spawn 剛開始、還沒等過任何 host 工作時，排進 .then 的接續要等到下一個 host 事件才會跑，
  // 實測卡過 20 秒到好幾分鐘（視窗一直「連線中」、引擎沒開）。
  enqueueEngineOp(fn) {
    const run = async () => {
      try { return await fn(); } finally { this.engineOpsInFlight--; }
    };
    this.engineOpsInFlight = (this.engineOpsInFlight || 0) + 1;
    const next = this.engineOpsInFlight === 1 ? run() : this.engineStartQueue.then(run, run);
    this.engineStartQueue = next.catch(() => {});
    return next;
  }

  send(obj) {
    try {
      this.sock?.write(JSON.stringify(obj) + "\n");
    } catch {}
  }

  async logWindowError(step, error) {
    try {
      const dataDir = `${appHome()}/data`;
      const logFile = `${dataDir}/tunr-window.log`;
      await mkdir(dataDir, { recursive: true });
      let existing = "";
      try { existing = await readFile(logFile, "utf8"); } catch {}
      const line = formatWindowLogLine({ step, error, source: this.source });
      await writeFile(logFile, appendWindowLog(existing, line, 200), "utf8");
    } catch {}
  }

  // hc 開的終端（Linux、macOS）不一定讀到登入 shell 的設定：nvm 的 node、pipx 的 yt-dlp 都會找不到。
  // App 的 exec 用的是使用者真正的環境，從那裡拿 node 的絕對路徑和 PATH 交給引擎。Windows 照舊。
  async engineNode() {
    if (this.engineNodeInfo !== undefined) return this.engineNodeInfo;
    let info = null;
    // Windows 的 appHome 是 C:\... 這種路徑；在 Windows 上不要去叫 bash（可能是 WSL）
    const isWindows = this.platform === "win32" || /^[A-Za-z]:[\\/]/.test(appHome());
    if (!isWindows) {
      const script = "[process.platform,process.execPath,process.env.PATH].join(String.fromCharCode(10))";
      const probes = [
        ["node", ["-p", script]],
        // node 不在 App 的 PATH（例如 nvm 寫在登入 shell 的設定裡）：用登入 shell 找
        ["bash", ["-lc", `node -p "${script}"`]],
        ["zsh", ["-lc", `node -p "${script}"`]],
      ];
      for (const [cmd, args] of probes) {
        try {
          const r = await exec(cmd, args);
          if (r.code !== 0) continue;
          const [plat, execPath, envPath] = r.stdout.trim().split(/\r?\n/);
          if (!plat || plat === "win32" || !execPath) continue;
          info = { execPath, envPath: envPath || "" };
          break;
        } catch {}
      }
    }
    this.engineNodeInfo = info;
    return info;
  }

  async startEngine(acx, source, gen) {
    return this.enqueueEngineOp(async () => {
      if (shouldAbortConnect(gen, this.engineGen, this.closed)) return false;
      this.port = 30000 + Math.floor(Math.random() * 20000);
      // 前一個沒收乾淨的先收掉（名字不能重複）
      try { await hc(["kill", ENGINE_NAME]); } catch {}
      if (shouldAbortConnect(gen, this.engineGen, this.closed)) return false;
      const node = await this.engineNode();
      if (shouldAbortConnect(gen, this.engineGen, this.closed)) return false;
      const args = [
        "run", "--bg", "--no-parent", "--no-notify", "--name", ENGINE_NAME, "--",
        node?.execPath || "node", `${dir()}/tunr.mjs`, "--source", source, "--port", String(this.port),
        "--cols", String(SIZES[this.sizeKey].cols), "--rows", String(SIZES[this.sizeKey].rows),
        "--mode", this.mode, "--video", this.video ? "1" : "0", "--eq", this.eq ? "1" : "0", "--volume", String(this.volume), "--speed", String(this.speed),
        "--log", `${appHome()}/data/tunr-engine.jsonl`,
        ...(node?.envPath ? ["--path", node.envPath] : []),
      ];
      // 另一個 tunr 視窗可能剛好在同時開了同名引擎（App 更新時 mod 會被重載兩次）：
      // 收掉它再開，最多試 3 秒
      const deadline = now() + 3000;
      for (;;) {
        const r = await hc(args);
        if (r.code === 0) return true;
        const out = (r.stderr || r.stdout || "hc run failed").trim();
        if (!isNameTakenError(out) || now() >= deadline) throw new Error(out);
        try { await hc(["kill", ENGINE_NAME]); } catch {}
        await acx.sleep(200);
        if (shouldAbortConnect(gen, this.engineGen, this.closed)) return false;
      }
    });
  }

  async stopEngine() {
    return this.enqueueEngineOp(async () => {
      try { await hc(["kill", ENGINE_NAME]); } catch {}
    });
  }

  async connectEngine(acx, resume, gen = null) {
    if (gen === null) gen = this.bumpGeneration();
    let step = "init";
    try {
      if (shouldAbortConnect(gen, this.engineGen, this.closed)) return;
      if (this.source === "system") {
        step = "platform_check";
        let plat = this.platform;
        if (!plat) {
          try {
            const r = await exec("node", ["-p", "process.platform"]);
            plat = r.stdout.trim();
            this.platform = plat;
          } catch {
            plat = typeof process !== "undefined" ? process.platform : "win32";
          }
        }
        if (shouldAbortConnect(gen, this.engineGen, this.closed)) return;
        if (plat && plat !== "win32") {
          this.message = "windowsOnly";
          acx.notify();
          return;
        }
      }
      let sock = null;
      let lastConnectErr = null;
      // 接手換大小前的引擎：視窗重新載入或 App 重開時，props 裡的 resume 可能指向已經不在的引擎，
      // 約 3 秒連不上就當作沒有，改開新的引擎。
      // 用時間當上限、不用次數：Windows 連已關閉的本機埠，每次要等約 2 秒才失敗
      if (resume?.port) {
        this.port = resume.port;
        step = "resume_connect";
        const deadline = now() + 3000;
        while (now() < deadline && !shouldAbortConnect(gen, this.engineGen, this.closed)) {
          try {
            sock = await net.connect("127.0.0.1", this.port);
            break;
          } catch (err) {
            lastConnectErr = err;
            await acx.sleep(150);
          }
        }
        if (shouldAbortConnect(gen, this.engineGen, this.closed)) {
          if (sock) { try { sock.close(); } catch {} }
          return;
        }
      }
      const resumed = Boolean(sock);
      this.resumedConnect = resumed;
      if (!resumed) {
        step = "start_engine";
        const started = await this.startEngine(acx, this.source, gen);
        if (!started || shouldAbortConnect(gen, this.engineGen, this.closed)) return;
        step = "tcp_connect";
        for (let i = 0; i < 650 && !shouldAbortConnect(gen, this.engineGen, this.closed); i++) {
          try {
            sock = await net.connect("127.0.0.1", this.port);
            break;
          } catch (err) {
            lastConnectErr = err;
            await acx.sleep(150);
          }
        }
        if (shouldAbortConnect(gen, this.engineGen, this.closed)) {
          if (sock) { try { sock.close(); } catch {} }
          return;
        }
      }
      if (!sock) throw (lastConnectErr || new Error("tcp connect timeout"));
      this.sock = sock;
      this.message = null;
      acx.notify();
      if (!resumed) this.send({ cmd: "play" });
      step = "read_loop";
      await this.readLoop(acx, sock, gen);
    } catch (e) {
      if (!shouldApplyEngineFailure(gen, this.engineGen, this.closed)) return;
      this.message = engineFailureMessage(step);
      if (step === "read_loop") this.sock = null;
      acx.notify();
      await this.logWindowError(step, e);
    }
  }

  async readLoop(acx, sock, gen) {
    let buf = "";
    for (;;) {
      let chunk;
      try {
        chunk = await sock.read(1 << 20);
      } catch (e) {
        // 連線閒置（暫停時引擎不送資料）read 會逾時丟錯誤（Linux os error 11、Windows 10060），稍等再讀
        if (!isWouldBlockError(e) || shouldAbortConnect(gen, this.engineGen, this.closed)) throw e;
        await acx.sleep(50);
        continue;
      }
      if (!chunk || shouldAbortConnect(gen, this.engineGen, this.closed)) break;
      buf += ascii(chunk);
      let i;
      while ((i = buf.indexOf("\f")) >= 0) {
        const msg = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const code = msg.charCodeAt(0);
        if (code === 1) this.onStatus(acx, JSON.parse(msg.slice(1)));
        else if (code === 2) this.onEq(msg);
        else this.onFrame(msg);
      }
      if (this.pendingFrame && this.video && !shouldAbortConnect(gen, this.engineGen, this.closed)) {
        acx.notify();
      }
      if (this.pendingEq && !this.video && this.eq && !shouldAbortConnect(gen, this.engineGen, this.closed)) {
        this.pendingEq = false;
        if (this.eqView) acx.notify(this.eqView);
      }
    }
    if (shouldHandleSocketClose(gen, this.engineGen, sock === this.sock, this.closed, this.handoff)) {
      this.sock = null;
      this.clearEq(acx);
      this.message = "engineEnded";
      acx.notify();
    }
  }

  onEq(msg) {
    if (this.video || !this.eq) return;
    const decoded = decodeEqBands(msg, this.eqState.levels);
    if (!decoded) return;
    this.eqState.levels = decoded;
    this.eqState.count = decoded.length;
    let any = false;
    for (let i = 0; i < decoded.length; i++) {
      if (decoded[i] > 0) { any = true; break; }
    }
    this.eqState.hasBars = any;
    this.eqState.visible = any;
    this.pendingEq = true;
  }

  clearEq(cx = null) {
    this.pendingEq = false;
    this.eqState.hasBars = false;
    this.eqState.visible = false;
    if (this.eqState.levels) this.eqState.levels.fill(0);
    if (cx && this.eqView) {
      try { cx.notify(this.eqView); } catch {}
    }
  }

  onFrame(text) {
    if (this.debug) {
      if (this.pendingFrame) { this.st.dropped++; this.win.dropped++; }
      this.st.received++;
      this.win.received++;
    }
    this.frame = text;
    this.pendingFrame = true;
  }

  onStatus(cx, s) {
    if (s.stats) return;
    const before = this.status;
    this.status = s;
    if (s.error) {
      this.message = s.error;
      this.clearEq(cx);
    }
    // 關畫面時只在畫面上看得到的東西變了才重畫：時間（每秒）、播放狀態等，不然每 250 毫秒一次沒有意義
    const sec = Math.floor(s.pos ?? 0);
    const mediaChanged = JSON.stringify(before.media ?? null) !== JSON.stringify(s.media ?? null);
    const changed = sec !== this.shownSecond || before.playing !== s.playing || before.video !== s.video || before.mode !== s.mode || before.volume !== s.volume || before.speed !== s.speed || before.ended !== s.ended || before.error !== s.error || before.dur !== s.dur || mediaChanged || s.hello;
    if (s.hello) {
      this.hello = s;
      // 引擎回報的設定為準（重新連上 handoff 的引擎時；無影像音訊檔不覆蓋視窗畫面模式）
      if (this.resumedConnect && s.hasVideo !== false) this.video = s.video;
      if (typeof s.eq === "boolean") this.eq = s.eq;
      this.mode = s.mode;
      this.volume = s.volume;
      try { this.volumeSlider?.set_value(this.volume); } catch {}
      if (typeof s.speed === "number") this.speed = normalizeSpeed(s.speed, this.speed);
    }
    if (!this.seeking && !(s.isSystem || this.source === "system")) {
      const locked = this.seekLockUntil && now() < this.seekLockUntil;
      if (locked && Math.abs((s.pos ?? 0) - this.seekTargetPos) < 1.5) {
        this.seekLockUntil = 0;
      }
      if (!this.seekLockUntil || now() >= this.seekLockUntil) {
        const f = s.dur ? Math.max(0, Math.min(1, (s.pos ?? 0) / s.dur)) : 0;
        try { this.seekSlider?.set_value(Math.round(f * 1000)); } catch {}
      }
    }
    this.maybeAutoAdvance(cx, Boolean(before.ended));
    if (changed) {
      this.shownSecond = sec;
      if (!this.video || !s.playing || before.playing !== s.playing || Boolean(s.error)) cx.notify();
    }
  }

  getViewport() {
    return typeof window !== "undefined" && window?.viewport_size ? window.viewport_size() : null;
  }

  async getCurrentPos() {
    if (this.bounds && Number.isFinite(this.bounds.x) && Number.isFinite(this.bounds.y)) {
      return { x: this.bounds.x, y: this.bounds.y };
    }
    if (this.pos && Number.isFinite(this.pos.x) && Number.isFinite(this.pos.y)) {
      return { x: this.pos.x, y: this.pos.y };
    }
    const place = await readWindowPlace(MOD);
    if (place) return place;
    return null;
  }

  showNotice(cx, text) {
    this.notice = text;
    const token = ++this.noticeToken;
    cx.notify();
    cx.spawn(async (acx) => {
      await acx.sleep(3000);
      if (this.noticeToken === token && !this.closed) {
        this.notice = null;
        acx.notify();
      }
    });
  }

  scheduleSave(cx) {
    if (!this.isWindow) return;
    this.savePending = true;
    const token = ++this.saveToken;
    cx.spawn(async (acx) => {
      await acx.sleep(500);
      if (this.saveToken === token && this.savePending && !this.closed) {
        await this.flushConfig();
      }
    });
  }

  async flushConfig() {
    if (!this.isWindow || !this.savePending) return;
    this.savePending = false;
    const updates = {
      volume: this.volume,
      speed: this.speed,
      mode: this.mode,
      size: this.sizeKey,
      video: this.video,
      eq: this.eq,
      opacity: this.opacity,
      source: this.source ?? null,
      lastSource: this.lastSource ?? null,
    };
    try {
      const path = settingsPath();
      let existing = null;
      try {
        existing = await readFile(path, "utf8");
      } catch (e) {
        const msg = String(e?.message ?? e ?? "");
        const isNotFound = e?.code === "ENOENT" || /ENOENT|no such file|cannot find|not found|os error 2\b/i.test(msg);
        if (!isNotFound) return;
      }
      const next = mergeConfigText(existing, updates);
      if (next !== null && next !== existing) {
        await mkdir(`${appHome()}/data/${MOD}`, { recursive: true });
        await writeFile(path, next, "utf8");
      }
    } catch {}
  }

  async applyViewMode(acx, nextSizeKey, nextVideo) {
    const sizeChanged = nextSizeKey !== this.sizeKey;
    const videoChanged = nextVideo !== this.video;
    if (!sizeChanged && !videoChanged) return;
    if (sizeChanged) {
      this.sizeKey = nextSizeKey;
      const { cols, rows } = SIZES[this.sizeKey];
      this.send({ cmd: "size", cols, rows });
    }
    if (videoChanged) {
      this.video = nextVideo;
      this.send({ cmd: "video", on: nextVideo });
      if (!nextVideo) { this.frame = ""; this.pendingFrame = false; }
    }
    this.scheduleSave(acx);
    await this.resize(acx);
  }

  async applySize(acx, nextKey) {
    await this.applyViewMode(acx, nextKey, this.video);
  }

  async ensureFit(acx) {
    if (this.closed || !this.isWindow) return;
    const curPos = await this.getCurrentPos();
    const vp = this.getViewport();
    if (!curPos || !vp) return;
    const currentSize = windowSize(this.sizeKey, this.video);
    if (!doesFit(curPos, currentSize, vp)) {
      const best = bestFitSize(curPos, this.video, vp);
      if (best && best !== this.sizeKey) {
        await this.applySize(acx, best);
      }
    }
  }

  // ---- 控制 ----
  async setVideo(acx, on) {
    if (on && !this.video) {
      const curPos = await this.getCurrentPos();
      const vp = this.getViewport();
      if (!canOpenVideo(this.sizeKey, curPos, vp)) {
        this.showNotice(acx, tr("noRoom", { size: this.sizeKey }));
        return;
      }
    }
    await this.applyViewMode(acx, this.sizeKey, on);
  }
  setMode(cx, m) {
    this.mode = m;
    this.eqState.mode = m;
    this.send({ cmd: "mode", mode: m });
    this.scheduleSave(cx);
    if (!this.video) {
      cx?.notify?.();
      if (this.eqView) { try { cx?.notify?.(this.eqView); } catch {} }
    }
  }
  setEq(cx, on) {
    const next = Boolean(on);
    if (this.eq === next) return;
    this.eq = next;
    if (!this.eq) this.clearEq(cx);
    this.send({ cmd: "eq", on: this.eq });
    this.scheduleSave(cx);
    cx?.notify?.();
  }
  async cycleSize(acx) {
    const curPos = await this.getCurrentPos();
    const vp = this.getViewport();
    const fit = nextFitSize(this.sizeKey, curPos, this.video, vp);
    if (fit.skipped) {
      this.showNotice(acx, tr("noRoom", { size: fit.skipped }));
    }
    if (fit.changed) {
      await this.applyViewMode(acx, fit.sizeKey, fit.video);
    }
  }
  async stepBigger(acx) {
    const curPos = await this.getCurrentPos();
    const vp = this.getViewport();
    const fit = biggerFitSize(this.sizeKey, curPos, this.video, vp);
    if (fit.skipped) {
      this.showNotice(acx, tr("noRoom", { size: fit.skipped }));
    }
    if (fit.changed) {
      await this.applyViewMode(acx, fit.sizeKey, fit.video);
    }
  }
  async stepSmaller(acx) {
    const fit = smallerSize(this.sizeKey, this.video);
    if (fit.changed) {
      await this.applyViewMode(acx, fit.sizeKey, fit.video);
    }
  }
  setOpacity(cx, value, save = true, syncSlider = true) {
    const next = clampOpacity(value, this.opacity);
    this.opacity = next;
    if (syncSlider) {
      try { this.opacitySlider?.set_value(next); } catch {}
    }
    if (save) this.scheduleSave(cx);
    cx?.notify?.();
  }
  cycleOpacity(cx) {
    const next = nextOpacityStep(this.opacity);
    this.setOpacity(cx, next, true, true);
  }
  // 同一個 key 再開一次 = 原地換成新大小；引擎留著，新視窗接回同一個埠
  async resize(_acx) {
    this.volumeThrottle?.flush?.();
    if (this.savePending) await this.flushConfig();
    const { width, height } = windowSize(this.sizeKey, this.video);
    this.handoff = true;
    const spec = {
      mod: MOD, kind: "window", key: "tunr", keep: true, frame: "none", width, height,
      props: {
        window: true, source: this.source, lastSource: this.lastSource ?? null,
        size: this.sizeKey, mode: this.mode, video: this.video, eq: this.eq,
        volume: this.volume, speed: this.speed, opacity: this.opacity, debug: this.debug, cfg: this.cfg,
        resume: this.source ? { port: this.port } : null,
        playlistCache: Array.from(this.playlistCache.entries()),
        bounds: this.bounds,
      },
    };
    const id = openOverlay(spec);
    setShared("tunr.window", id);
  }
  setVolume(cx, value, save = true, syncSlider = true) {
    const prev = this.volume;
    const next = clampVolume(value, prev, { round: true });
    this.volume = next;
    if (syncSlider) {
      try { this.volumeSlider?.set_value(next); } catch {}
    }
    if (next !== prev || (save && this.volumeThrottle?.isPending?.())) {
      this.volumeThrottle.push(next);
    }
    if (save) this.scheduleSave(cx);
    cx?.notify?.();
  }
  setSpeed(cx, value) {
    if (this.source === "system" || this.status?.isSystem) return;
    const next = normalizeSpeed(value, this.speed);
    if (next === this.speed) return;
    this.speed = next;
    this.send({ cmd: "speed", value: this.speed });
    this.scheduleSave(cx);
    cx?.notify?.();
  }
  stepSpeed(cx, delta = 1) {
    if (this.source === "system" || this.status?.isSystem) return;
    this.setSpeed(cx, nextSpeedStep(this.speed, delta));
  }
  commitSeekSlider(evCx, val = null) {
    const raw = val ?? this.seekSlider?.value?.() ?? 0;
    const f = Math.max(0, Math.min(1, Number(raw) / 1000));
    this.seeking = false;
    this.seekDragFrac = f;
    if (this.status?.dur) {
      const to = f * this.status.dur;
      this.seekTargetPos = to;
      this.seekLockUntil = now() + 450;
      this.send({ cmd: "seek", to });
    }
    evCx?.notify?.();
  }
  seekAt(e) {
    const w = e.bounds?.width ?? 0;
    if (!w || !this.status.dur) return;
    const f = Math.max(0, Math.min(1, (e.local_position?.x ?? 0) / w));
    this.send({ cmd: "seek", to: f * this.status.dur });
  }
  async resolvePurePlaylist(acx, source, yt, gen) {
    this.trackState = emptyTrackState(true);
    acx.notify();
    await this.stopEngine();
    if (shouldAbortConnect(gen, this.engineGen, this.closed) || this.source !== source) return;
    let videoIds = this.playlistCache.get(yt.listId) ?? null;
    let missingYtDlp = false;
    if (!videoIds) {
      const res = await this.fetchYouTubePlaylistIds(yt, source);
      if (shouldAbortConnect(gen, this.engineGen, this.closed) || this.source !== source) return;
      videoIds = res.videoIds;
      missingYtDlp = res.missingYtDlp;
      if (videoIds.length > 0) this.playlistCache.set(yt.listId, videoIds);
    }
    if (videoIds.length > 0) {
      await this.loadSource(acx, buildYouTubeTrackUrl(videoIds[0], yt.listId));
      return;
    }
    this.trackState = emptyTrackState(false);
    this.message = missingYtDlp ? "missingYtDlp" : "resolveFailed";
    acx.notify();
  }

  async fetchYouTubePlaylistIds(yt, source) {
    const fetchUrl = buildYouTubePlaylistFetchUrl(yt, source);
    const args = [
      "--flat-playlist",
      "--yes-playlist",
      "--dump-single-json",
      "--no-warnings",
      ...(yt.isMix ? ["--playlist-end", "50"] : []),
      "--",
      fetchUrl,
    ];
    try {
      const r = await exec("yt-dlp", args, { timeout: 60000 });
      if (r.code !== 0) {
        const errText = `${r.stderr || ""}\n${r.stdout || ""}`;
        const missing = /ENOENT|not recognized|not found|No such file/i.test(errText);
        return { videoIds: [], missingYtDlp: missing };
      }
      return { videoIds: extractPlaylistVideoIds(r.stdout), missingYtDlp: false };
    } catch (e) {
      const msg = String(e?.message ?? e ?? "");
      const missing = e?.code === "ENOENT" || /ENOENT|not found|cannot find|os error 2\b/i.test(msg);
      return { videoIds: [], missingYtDlp: missing };
    }
  }

  startTrackDiscovery(cx, source, gen, prevTrackState = null) {
    if (!source || source === "system") {
      this.trackState = emptyTrackState(false);
      return;
    }
    if (/^https?:\/\//i.test(source)) {
      const yt = parseYouTubeSource(source);
      if (!yt?.listId || !yt.videoId) {
        this.trackState = emptyTrackState(false);
        return;
      }
      if (this.playlistCache.has(yt.listId)) {
        const cached = this.playlistCache.get(yt.listId);
        this.trackState = { ...buildYouTubeTrackList(cached, yt.videoId, yt.listId), loading: false };
        return;
      }
      this.trackState = emptyTrackState(true);
      cx.spawn(async (acx) => {
        const { videoIds } = await this.fetchYouTubePlaylistIds(yt, source);
        if (shouldAbortConnect(gen, this.engineGen, this.closed) || this.source !== source) return;
        if (videoIds.length > 0) {
          this.playlistCache.set(yt.listId, videoIds);
          this.trackState = { ...buildYouTubeTrackList(videoIds, yt.videoId, yt.listId), loading: false };
        } else {
          this.trackState = failedTrackState();
        }
        this.maybeAutoAdvance(acx, false);
        acx.notify();
      });
      return;
    }

    const dirPath = pathDirName(source);
    if (!dirPath) {
      this.trackState = emptyTrackState(false);
      return;
    }
    if (prevTrackState?.kind === "folder" && prevTrackState.dir === dirPath && Array.isArray(prevTrackState.tracks)) {
      const quickNames = prevTrackState.tracks.map(pathBaseName);
      this.trackState = { ...buildFolderTrackList(quickNames, source, dirPath), loading: false };
    } else {
      this.trackState = emptyTrackState(true);
    }
    cx.spawn(async (acx) => {
      let entries = [];
      try {
        const node = await this.engineNode();
        const r = await exec(node?.execPath || "node", [`${dir()}/list-folder.mjs`, dirPath], { timeout: 10000 });
        if (r.code === 0 && r.stdout) {
          const parsed = JSON.parse(r.stdout);
          if (Array.isArray(parsed)) entries = parsed;
        }
      } catch {
        entries = [];
      }
      if (shouldAbortConnect(gen, this.engineGen, this.closed) || this.source !== source) return;
      this.trackState = { ...buildFolderTrackList(entries, source, dirPath), loading: false };
      this.maybeAutoAdvance(acx, false);
      acx.notify();
    });
  }

  maybeAutoAdvance(cx, prevEnded) {
    const isSystem = this.source === "system" || Boolean(this.status?.isSystem);
    const adv = shouldAutoAdvance({
      isSystem,
      prevEnded,
      status: this.status,
      trackState: this.trackState,
      alreadyAdvanced: this.autoAdvancedGen === this.engineGen,
    });
    if (!adv.advance) return;
    this.autoAdvancedGen = this.engineGen;
    cx.spawn(async (acx) => {
      if (this.closed) return;
      await this.loadSource(acx, adv.source);
    });
  }

  prevTrack(cx) {
    if (this.source === "system" || this.status?.isSystem) {
      this.send({ cmd: "mediaPrev" });
      return;
    }
    const effectivePos = (this.seekLockUntil && now() < this.seekLockUntil)
      ? this.seekTargetPos
      : (this.status?.pos ?? 0);
    const act = decidePrevAction(this.trackState, effectivePos);
    if (act.action === "seek0") {
      this.seekTargetPos = 0;
      this.seekLockUntil = now() + 450;
      this.seekDragFrac = 0;
      this.seeking = false;
      this.status = { ...this.status, pos: 0, ended: false };
      try { this.seekSlider?.set_value(0); } catch {}
      this.send({ cmd: "seek", to: 0 });
      cx?.notify?.();
      return;
    }
    if (act.action === "load") {
      cx.spawn(async (acx) => {
        if (this.closed) return;
        await this.loadSource(acx, act.source);
      });
    }
  }

  nextTrack(cx) {
    if (this.source === "system" || this.status?.isSystem) {
      this.send({ cmd: "mediaNext" });
      return;
    }
    const act = decideNextAction(this.trackState);
    if (act.action === "load") {
      cx.spawn(async (acx) => {
        if (this.closed) return;
        await this.loadSource(acx, act.source);
      });
    }
  }

  async loadSource(acx, path) {
    const gen = this.bumpGeneration();
    this.resumedConnect = false;
    const prevTrackState = this.trackState;
    const next = rememberSourceState({ source: this.source, lastSource: this.lastSource }, path);
    this.source = next.source;
    this.lastSource = next.lastSource;
    if (this.source === "system" || !this.source) {
      this.showVolume = false;
    }
    this.frame = "";
    this.pendingFrame = false;
    this.clearEq(acx);
    this.hello = null;
    this.message = this.source ? "connecting" : "drop";
    this.status = { pos: 0, dur: 0, playing: false };
    this.seeking = false;
    this.seekDragFrac = 0;
    this.seekLockUntil = 0;
    try { this.seekSlider?.set_value(0); } catch {}
    this.trackState = emptyTrackState(false);
    this.scheduleSave(acx);
    this.volumeThrottle?.cancel?.();
    try { this.send({ cmd: "quit" }); this.sock?.close(); } catch {}
    this.sock = null;
    if (!this.source) {
      acx.notify();
      await this.stopEngine();
      return;
    }
    if (this.source !== "system") {
      const yt = parseYouTubeSource(this.source);
      if (yt?.listId && !yt.videoId) {
        await this.resolvePurePlaylist(acx, this.source, yt, gen);
        return;
      }
      this.startTrackDiscovery(acx, this.source, gen, prevTrackState);
    }
    acx.notify();
    await this.connectEngine(acx, null, gen);
  }

  async toggleSystem(acx, targetOn = null) {
    const res = toggleSystemMode({ source: this.source, lastSource: this.lastSource }, targetOn);
    if (!res.changed) return;
    this.lastSource = res.lastSource;
    if (res.action === "connect" && res.source) {
      await this.loadSource(acx, res.source);
    } else {
      await this.loadSource(acx, null);
    }
  }

  async close(_cx) {
    this.closed = true;
    this.volumeThrottle?.cancel?.();
    this.bumpGeneration();
    try { this.opacitySlider?.release(); } catch {}
    try { this.volumeSlider?.release(); } catch {}
    try { this.seekSlider?.release(); } catch {}
    try { this.urlInput?.release(); } catch {}
    try { this.eqView?.release(); } catch {}
    if (this.eqKey) EQ_STATES.delete(this.eqKey);
    this.opacitySlider = null;
    this.volumeSlider = null;
    this.seekSlider = null;
    this.urlInput = null;
    this.eqView = null;
    if (!this.isWindow) return;
    if (this.handoff) return; // 換大小：引擎留給新視窗
    if (this.savePending) await this.flushConfig();
    try { this.send({ cmd: "quit" }); } catch {}
    try { this.sock?.close(); } catch {}
    try { setShared("tunr.window", null); } catch {}
    await this.stopEngine();
  }

  // ---- 量測（debug）----
  async dumpStats(cx) {
    const t = now();
    const w = this.win;
    const secs = (t - w.since) / 1000;
    const out = {
      at: new Date().toISOString(), seconds: +secs.toFixed(2), mode: this.mode, video: this.video, eq: this.eq, size: this.sizeKey,
      playing: Boolean(this.status.playing), pos: this.status.pos,
      receivedFps: +(w.received / secs).toFixed(1), shownFps: +(w.shown / secs).toFixed(1),
      dropped: w.dropped, droppedPct: w.received ? +((100 * w.dropped) / w.received).toFixed(1) : 0,
      rendersPerSec: +(w.renders / secs).toFixed(2), avgJsMs: +(w.jsMs / Math.max(1, w.renders)).toFixed(3),
      avgTextElementsPerFrame: w.renders ? +(w.segs / w.renders).toFixed(0) : 0,
      eqRendersPerSec: +(w.eqRenders / secs).toFixed(2),
      eqAvgJsMs: +(w.eqJsMs / Math.max(1, w.eqRenders)).toFixed(3),
      avgEqBarsDrawn: w.eqRenders ? +(w.eqBarsDrawn / w.eqRenders).toFixed(1) : 0,
    };
    this.win = { received: 0, shown: 0, dropped: 0, renders: 0, jsMs: 0, segs: 0, eqRenders: 0, eqJsMs: 0, eqBarsDrawn: 0, since: t };
    try {
      (this.hist ??= []).push(out);
      if (this.hist.length > 300) this.hist.shift();
      await writeFile(`${appHome()}/data/tunr-stats.json`, JSON.stringify({ latest: out, history: this.hist }, null, 1));
    } catch {}
  }

  // ---- 畫 ----
  btn(id, content, onClick, opts = {}) {
    const t = theme();
    const disabled = Boolean(opts.disabled);
    const activeOn = Boolean(opts.on) && !disabled;
    const danger = Boolean(opts.danger) && !disabled;
    const boxSize = opts.size ?? 24;
    const width = opts.width ?? null;
    const height = opts.height ?? boxSize;
    const iconColor = disabled
      ? withAlpha(t.dim ?? t.muted, 0.45)
      : (activeOn ? (t.accent ?? t.foreground) : t.muted);
    const dangerColor = t.blocked ?? t.ansi1 ?? "#e05252";
    const hoverBg = danger ? withAlpha(dangerColor, 0.2) : (t.hover ?? t.raised);
    const hoverFg = danger ? dangerColor : t.foreground;
    const activeBg = danger ? withAlpha(dangerColor, 0.34) : (t.selected ?? t.raised ?? t.hover);

    return div()
      .id(id)
      .flex_none()
      .flex().items_center().justify_center()
      .when(width !== null, (el) => el.w(width).h(height))
      .when(width === null, (el) => el.min_w(boxSize).h(height).px(opts.icon ? 0 : 6))
      .rounded(6)
      .text_color(iconColor)
      .when(activeOn, (el) => el.bg(withAlpha(t.accent ?? t.selected ?? t.raised ?? t.hover, 0.2)).border(1).border_color(withAlpha(t.accent ?? t.border, 0.45)))
      .when(!disabled, (el) =>
        el
          .cursor_pointer()
          .hover((s) => s.bg(hoverBg).text_color(hoverFg))
          .active((s) => s.bg(activeBg).text_color(hoverFg))
      )
      .when(Boolean(opts.tip), (el) => el.tooltip(opts.tip))
      .on_mouse_down("left", (_e, evCx) => evCx.stop_propagation())
      .when(!disabled && Boolean(opts.onRightClick), (el) =>
        el
          .on_mouse_down("right", (_e, evCx) => evCx.stop_propagation())
          .on_mouse_up("right", (_e, evCx) => {
            evCx.stop_propagation();
            opts.onRightClick(evCx);
            evCx.notify();
          })
      )
      .when(!disabled, (el) => el.on_click((_e, evCx) => { onClick(evCx); evCx.notify(); }))
      .child(
        opts.icon
          ? svg(iconPath(opts.icon)).size(opts.iconSize ?? 14).flex_none()
          : content
      );
  }

  iconBtn(id, icon, onClick, opts = {}) {
    return this.btn(id, null, onClick, { ...opts, icon });
  }

  frameRows(monoColor) {
    const rows = this.frame ? this.frame.split("\n") : [];
    const low = this.mode === "low";
    let segs = 0;
    const out = rows.map((r) => {
      if (!low) { if (this.debug) segs++; return div().whitespace_nowrap().child(r); }
      const parts = r.split("|");
      if (this.debug) segs += parts.length;
      return h_flex().whitespace_nowrap().children(parts.map((s) => div().text_color(PALETTE[s.charCodeAt(0) - 48] ?? monoColor).child(s.slice(1))));
    });
    if (this.debug) this.lastSegs = segs;
    return out;
  }

  toggleUrlEditor(evCx) {
    this.showUrl = !this.showUrl;
    if (this.showUrl) {
      this.showOpacity = false;
      this.showVolume = false;
      let text = "";
      try { text = (evCx.read_from_clipboard() ?? "").trim(); } catch {}
      const value = /^https?:\/\/[^\s/]+(?:[/?#][^\s]*)?$/i.test(text) ? text : "";
      this.urlInput?.release();
      this.urlInput = InputState.new({ value, placeholder: tr("urlPlaceholder") });
      this.urlInput.on("submit", (_e, inputCx) => {
        const url = this.urlInput.value().trim();
        this.showUrl = false;
        inputCx.notify();
        if (url) inputCx.spawn(async (acx) => this.loadSource(acx, url));
      });
      this.urlInput.set_selected_range({ start: 0, end: value.length });
      this.urlInput.focus();
    }
  }

  renderSliderBar(sliderState, t, borderBase) {
    return h_flex()
      .items_center().h(24)
      .on_mouse_down("left", (_e, evCx) => evCx.stop_propagation())
      .child(
        Slider.new(sliderState).w_full().child(
          SliderTrack.new(sliderState).flex().items_center().h(20).w_full().cursor_pointer().child(
            SliderIndicator.new(sliderState)
              .relative().w_full().h(5).rounded(3).bg(borderBase)
              .range_style((fill) => fill.rounded(3).bg(t.accent))
              .child(SliderThumb.new(sliderState).size(13).rounded(7).bg(t.foreground).border(1).border_color(t.accent).ml(-6))
          )
        )
      );
  }

  renderSliderPopover(id, iconName, sliderState, valueText, t, borderBase, chromeBase) {
    return h_flex()
      .id(id)
      .absolute().bottom(CONTROLS_H + 6).right(PAD).w(196).h(32).px(10).gap(8).items_center()
      .rounded(8).bg(t.popover ?? t.raised ?? chromeBase).border(1).border_color(borderBase).shadow_md()
      .on_mouse_down("left", (_e, evCx) => evCx.stop_propagation())
      .child(svg(iconPath(iconName)).size(13).flex_none().text_color(t.muted))
      .child(this.renderSliderBar(sliderState, t, borderBase).flex_1())
      .child(div().w(30).flex_none().text_right().text_size(10).text_color(t.foreground).child(valueText));
  }

  renderInlineSliderRow(toggleBtn, okId, onConfirm, sliderState, valueText, t, borderBase) {
    return h_flex()
      .id("tunr-controls")
      .flex_1().min_h(0)
      .px(PAD).gap(6).items_center()
      .text_size(11).text_color(t.muted)
      .child(toggleBtn)
      .child(this.renderSliderBar(sliderState, t, borderBase).flex_1().min_w(0))
      .child(div().w(32).flex_none().text_right().font_family("JetBrains Mono").text_size(10).text_color(t.foreground).child(valueText))
      .child(this.iconBtn(okId, "check", onConfirm, { size: 24, iconSize: 14, on: true, tip: tr("confirm") }));
  }

  renderPlayBtn(s, isSystem, ms) {
    return isSystem && ms.hasSession
      ? this.iconBtn("tunr-play", ms.isPlaying ? "pause" : "play", () => this.send({ cmd: "mediaToggle" }), { size: 24, iconSize: 14, tip: tr(ms.isPlaying ? "pause" : "play"), disabled: !ms.canToggle })
      : this.iconBtn("tunr-play", s.playing ? "pause" : "play", () => this.send({ cmd: "toggle" }), { size: 24, iconSize: 14, tip: tr(s.playing ? "pause" : "play") });
  }

  renderMediaNavBtns(ms) {
    return [
      this.iconBtn("tunr-prev", "prev", () => this.send({ cmd: "mediaPrev" }), { size: 24, iconSize: 14, tip: tr("prevTrack"), disabled: !ms.canPrev }),
      this.iconBtn("tunr-next", "next", () => this.send({ cmd: "mediaNext" }), { size: 24, iconSize: 14, tip: tr("nextTrack"), disabled: !ms.canNext }),
    ];
  }

  renderTrackNavBtns(nav) {
    return [
      this.iconBtn("tunr-prev", "prev", (evCx) => this.prevTrack(evCx), { size: 24, iconSize: 14, tip: tr(trackNavTipKey(this.trackState, "prev")), disabled: !nav.canPrev }),
      this.iconBtn("tunr-next", "next", (evCx) => this.nextTrack(evCx), { size: 24, iconSize: 14, tip: tr(trackNavTipKey(this.trackState, "next")), disabled: !nav.canNext }),
    ];
  }

  renderSpeedBtn() {
    return this.btn(
      "tunr-speed",
      div().font_family("JetBrains Mono").text_size(10).whitespace_nowrap().child(formatSpeedLabel(this.speed)),
      (evCx) => this.stepSpeed(evCx, 1),
      {
        width: 36,
        height: 22,
        on: this.speed !== DEFAULT_SPEED,
        tip: tr("speedValue", { value: this.speed }),
        onRightClick: (evCx) => this.stepSpeed(evCx, -1),
      }
    );
  }

  render(cx) {
    if (!this.isWindow) return div().p(8).child("tunr…");
    const t0 = this.debug ? now() : 0;
    const t = theme();
    if (this.debug) {
      if (this.pendingFrame) { this.st.shown++; this.win.shown++; }
      this.st.renders++;
      this.win.renders++;
    }
    this.pendingFrame = false;

    const { cols, rows } = SIZES[this.sizeKey];
    const s = this.status;
    const isSystem = this.source === "system" || Boolean(s.isSystem);
    const media = isSystem ? (s.media ?? null) : null;
    const ms = isSystem ? mediaButtonStates(media) : { hasSession: false, isPlaying: false, canToggle: true, canPrev: false, canNext: false };
    const trackNav = isSystem ? { hasPrev: false, hasNext: false, canPrev: false, canNext: false } : getTrackNavState(this.trackState);
    const maxMediaCols = this.sizeKey === "S" ? 24 : this.sizeKey === "M" ? 38 : 52;
    const headerTitle = isSystem
      ? formatMediaLabel(media, tr("systemAudio"), maxMediaCols)
      : formatSourceTitle(this.source, tr("drop"));
    const headerMuted = isSystem ? !ms.hasSession : !this.source;
    const isSeekLocked = Boolean(this.seekLockUntil && now() < this.seekLockUntil);
    const displayPos = (this.seeking || isSeekLocked) ? (this.seekDragFrac * (s.dur || 0)) : (s.pos ?? 0);
    const frac = s.dur ? Math.max(0, Math.min(1, displayPos / s.dur)) : 0;

    const bgFactor = clampOpacity(this.opacity, 100) / 100;
    const baseBg = t.background ?? "#0b0b0b";
    const chromeBase = t.chrome ?? t.surface ?? "#18181b";
    const borderBase = t.border ?? "#2e2e36";
    const bodyBg = withAlpha(baseBg, bgFactor);
    const chromeBg = withAlpha(chromeBase, bgFactor);
    const outerBorder = withAlpha(borderBase, Math.max(0.45, bgFactor));
    const hairline = withAlpha(borderBase, Math.max(0.28, bgFactor * 0.85));
    const darkBg = isDarkColor(baseBg);
    const monoInk = darkBg ? MONO_COLOR : (t.foreground ?? "#1f2328");

    const hasCompactError = Boolean(!this.video && this.message && this.message !== "connecting" && this.message !== "drop");
    const compactHeaderText = !this.video && this.notice
      ? this.notice
      : hasCompactError
        ? tr(this.message, { command: this.installCommand })
        : headerTitle;
    const compactHeaderColor = !this.video && this.notice
      ? (t.accent ?? "#e3814f")
      : hasCompactError
        ? t.muted
        : (headerMuted ? t.muted : t.foreground);
    // 標題放不下會被截成「…」：滑鼠停在標題上時用提示顯示完整文字（像網頁的 title）
    const headerFull = isSystem ? formatMediaLabel(media, tr("systemAudio"), Infinity) : headerTitle;
    const titleTip = (!this.video && (this.notice || hasCompactError))
      ? compactHeaderText
      : (headerMuted ? null : headerFull);
    const timeText = (!this.video && !isSystem && this.source && s.dur > 0) ? `${mmss(displayPos)}/${mmss(s.dur)}` : "";
    const winW = windowSize(this.sizeKey, this.video).width;
    const showCompactTime = !this.video && compactHeaderFitsTime(winW, timeText, Boolean(this.notice || hasCompactError));

    this.eqState.mode = this.mode;
    this.eqState.width = winW;
    this.eqState.height = COMPACT_H;
    this.eqState.visible = !this.video && this.eq && this.eqState.hasBars;
    this.eqState.monoColor = darkBg
      ? withAlpha(MONO_COLOR, 0.24)
      : withAlpha(t.foreground ?? "#1f2328", 0.18);
    this.eqState.bucketColors = darkBg
      ? [
          withAlpha(PALETTE[3], 0.24),
          withAlpha(PALETTE[2], 0.26),
          withAlpha(PALETTE[1], 0.28),
          withAlpha(PALETTE[6], 0.28),
        ]
      : [
          withAlpha("#3b7a44", 0.20),
          withAlpha("#8a7124", 0.22),
          withAlpha("#993f3f", 0.24),
          withAlpha("#853c7e", 0.24),
        ];

    const header = h_flex()
      .id("tunr-header")
      .h(HEADER_H).flex_none()
      .px(PAD).gap(6).items_center()
      .when(this.video, (el) => el.bg(chromeBg))
      .border_b(1).border_color(hairline)
      .child(
        div()
          .id("tunr-title")
          .flex_1().min_w(0).truncate()
          .text_size(11).font_weight(500)
          .text_color(this.video ? (headerMuted ? t.muted : t.foreground) : compactHeaderColor)
          .when(Boolean(titleTip), (el) => el.tooltip(titleTip))
          .child(this.video ? headerTitle : compactHeaderText)
      )
      .when(showCompactTime, (el) =>
        el.child(div().flex_none().font_family("JetBrains Mono").text_size(10).text_color(t.muted).child(timeText))
      )
      .child(
        h_flex().flex_none().gap(2).items_center()
          .child(this.iconBtn("tunr-smaller", "smaller", (evCx) => { evCx.spawn(async (acx) => this.stepSmaller(acx)); }, { size: 22, iconSize: 13, disabled: !this.video, tip: tr("smaller") }))
          .child(this.iconBtn("tunr-bigger", "bigger", (evCx) => { evCx.spawn(async (acx) => this.stepBigger(acx)); }, { size: 22, iconSize: 13, disabled: this.video && this.sizeKey === "L", tip: tr("bigger") }))
          .child(this.iconBtn("tunr-close", "close", () => closeOverlay(props().overlay), { size: 22, iconSize: 13, danger: true, tip: tr("close") }))
      );

    const screen = this.video
      ? v_flex()
          .w(cols * CHAR_W).h(rows * LINE_H).items_center().justify_center().overflow_hidden()
          .font_family("JetBrains Mono").text_size(10).line_height(`${LINE_H}px`)
          .text_color(monoInk)
          .when(Boolean(this.message), (el) => el.child(div().text_color(t.dim).child(tr(this.message, { command: this.installCommand }))))
          .child(v_flex().children(this.frameRows(monoInk)))
      : null;
    if (this.debug) this.win.segs += this.lastSegs ?? 0;

    const sessionBadge = isSystem
      ? (ms.hasSession ? (media?.app || tr(ms.isPlaying ? "play" : "pause")) : tr("systemAudio"))
      : "";

    const makeSystemBtn = () => this.iconBtn("tunr-system", "system", (evCx) => {
      evCx.spawn(async (acx) => this.toggleSystem(acx, null));
    }, { size: 24, iconSize: 14, on: isSystem, tip: tr(isSystem ? "systemAudioOff" : "systemAudioOn") });
    const makeUrlBtn = () => this.iconBtn("tunr-url", "url", (evCx) => this.toggleUrlEditor(evCx), { size: 24, iconSize: 14, on: this.showUrl, tip: tr("url") });
    const makeVideoBtn = () => this.iconBtn("tunr-video", this.video ? "video" : "video-off", (evCx) => {
      evCx.spawn(async (acx) => this.setVideo(acx, !this.video));
    }, { size: 24, iconSize: 14, on: this.video, tip: tr("videoHelp") });
    const makeVolumeBtn = () => this.iconBtn("tunr-volume", "volume", () => {
      this.showVolume = !this.showVolume;
      if (this.showVolume) {
        this.showUrl = false;
        this.showOpacity = false;
      }
    }, { size: 24, iconSize: 14, on: this.showVolume, tip: tr("volumeValue", { value: Math.round(this.volume) }) });
    const makeOpacityBtn = () => this.iconBtn("tunr-opacity", "opacity", () => {
      this.showOpacity = !this.showOpacity;
      if (this.showOpacity) {
        this.showUrl = false;
        this.showVolume = false;
      }
    }, { size: 24, iconSize: 14, on: this.showOpacity, tip: tr("opacityValue", { value: this.opacity }) });
    // 等化器只畫在縮小模式的背景，所以開關鈕只放在縮小模式的第二列
    const makeEqBtn = () => this.iconBtn("tunr-eq", "eq", (evCx) => this.setEq(evCx, !this.eq), { size: 24, iconSize: 14, on: this.eq, tip: tr(this.eq ? "eqOff" : "eqOn") });

    const renderVideoControls = () => {
      const seekBar = div()
        .id("tunr-seek")
        .flex_1().h(16).flex().items_center().cursor_pointer()
        .on_mouse_down("left", (e, evCx) => { evCx.stop_propagation(); this.seekAt(e); })
        .child(
          div().w_full().h(5).rounded_full().bg(withAlpha(borderBase, 0.85)).relative().overflow_hidden()
            .child(div().absolute().left(0).top(0).h(5).w(`${(frac * 100).toFixed(2)}%`).rounded_full().bg(t.accent))
        );

      return v_flex()
        .id("tunr-controls")
        .h(CONTROLS_H).flex_none()
        .justify_center().gap(2)
        .px(PAD).py(3)
        .bg(chromeBg)
        .border_t(1).border_color(hairline)
        .text_size(11).text_color(t.muted)
        .child(
          h_flex().h(24).gap(6).items_center()
            .child(this.renderPlayBtn(s, isSystem, ms))
            .when(isSystem && ms.hasSession, (el) => el.children(this.renderMediaNavBtns(ms)))
            .when(!isSystem, (el) => el.children(this.renderTrackNavBtns(trackNav)))
            .when(!isSystem, (el) =>
              el
                .child(seekBar)
                .child(div().flex_none().text_size(10).text_color(t.muted).child(`${mmss(displayPos)}/${mmss(s.dur)}`))
            )
            .when(isSystem, (el) =>
              el.child(div().flex_1().min_w(0).truncate().text_right().text_size(10).text_color(t.dim).child(sessionBadge))
            )
        )
        .child(
          h_flex().h(24).gap(3).items_center().whitespace_nowrap()
            .when(!isSystem, (el) => el.child(this.renderSpeedBtn()))
            .child(div().flex_1())
            .child(makeSystemBtn())
            .child(makeUrlBtn())
            .child(makeVideoBtn())
            .child(this.iconBtn("tunr-mode", "mode", (evCx) => this.setMode(evCx, this.mode === "low" ? "mono" : "low"), { size: 24, iconSize: 14, on: this.mode === "low", tip: `${tr("mode")} (${tr(this.mode === "low" ? "low" : "mono")})` }))
            .when(!isSystem, (el) => el.child(makeVolumeBtn()))
            .child(makeOpacityBtn())
            .when(this.debug, (el) => el.child(this.btn("tunr-fps", "FPS", () => { this.showFps = !this.showFps; }, { size: 22, on: this.showFps, tip: tr("fps") })))
        );
    };

    const renderCompactControls = () => {
      if (this.showUrl && Boolean(this.urlInput)) {
        return h_flex()
          .id("tunr-controls")
          .flex_1().min_h(0)
          .px(PAD).gap(6).items_center()
          .text_size(11).text_color(t.muted)
          .child(makeUrlBtn())
          .child(
            div()
              .id("tunr-url-inline")
              .flex_1().min_w(0).h(24).px(6).flex().items_center().rounded(6)
              .border(1).border_color(withAlpha(borderBase, 0.9))
              .bg(withAlpha(baseBg, Math.min(1, bgFactor + 0.15)))
              .cursor_text()
              .on_mouse_down("left", (_e, evCx) => evCx.stop_propagation())
              .child(Input.new(this.urlInput).w_full().text_size(11).text_color(t.foreground))
          )
          .child(
            this.iconBtn("tunr-url-ok", "check", (evCx) => {
              const url = this.urlInput?.value()?.trim();
              this.showUrl = false;
              if (url) evCx.spawn(async (acx) => this.loadSource(acx, url));
            }, { size: 24, iconSize: 14, on: true, tip: tr("confirm") })
          );
      }
      if (this.showVolume && !isSystem && Boolean(this.volumeSlider)) {
        return this.renderInlineSliderRow(
          makeVolumeBtn(),
          "tunr-volume-ok",
          () => { this.showVolume = false; },
          this.volumeSlider,
          `${Math.round(this.volume)}%`,
          t,
          borderBase
        );
      }
      if (this.showOpacity && Boolean(this.opacitySlider)) {
        return this.renderInlineSliderRow(
          makeOpacityBtn(),
          "tunr-opacity-ok",
          () => { this.showOpacity = false; },
          this.opacitySlider,
          `${Math.round(this.opacity)}%`,
          t,
          borderBase
        );
      }
      return h_flex()
        .id("tunr-controls")
        .flex_1().min_h(0)
        .px(PAD).gap(2).items_center().whitespace_nowrap()
        .text_size(11).text_color(t.muted)
        .child(this.renderPlayBtn(s, isSystem, ms))
        .when(isSystem && ms.hasSession, (el) => el.children(this.renderMediaNavBtns(ms)))
        .when(!isSystem, (el) => el.children([...this.renderTrackNavBtns(trackNav), this.renderSpeedBtn()]))
        .child(div().flex_1())
        .child(makeSystemBtn())
        .child(makeUrlBtn())
        .child(makeVideoBtn())
        .child(makeEqBtn())
        .when(!isSystem, (el) => el.child(makeVolumeBtn()))
        .child(makeOpacityBtn());
    };

    const compactSeekSeam = !this.video && !isSystem
      ? div()
          .id("tunr-compact-seek")
          .absolute().top(HEADER_H - 3).left(0).right(0).h(7)
          .flex().items_center().cursor_pointer()
          .on_mouse_down("left", (_e, evCx) => evCx.stop_propagation())
          .on_mouse_up("left", (_e, evCx) => {
            if (this.seeking) this.commitSeekSlider(evCx);
          })
          .child(
            Slider.new(this.seekSlider).w_full().child(
              SliderTrack.new(this.seekSlider).flex().items_center().h(7).w_full().cursor_pointer().child(
                SliderIndicator.new(this.seekSlider)
                  .relative().w_full().h(3).bg(withAlpha(borderBase, 0.85))
                  .range_style((fill) => fill.bg(t.accent))
                  .child(SliderThumb.new(this.seekSlider).w(0).h(0))
              )
            )
          )
      : null;

    const updateBounds = (e) => {
      const b = e?.bounds;
      if (b && Number.isFinite(b.x) && Number.isFinite(b.y)) {
        this.bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
        this.pos = { x: b.x, y: b.y };
      }
    };

    const card = v_flex()
      .id("tunr-root").relative().size_full()
      .rounded(10).overflow_hidden()
      .bg(this.video ? bodyBg : chromeBg)
      .border(1).border_color(outerBorder)
      .on_mouse_move((e) => updateBounds(e))
      .on_mouse_down("left", (e) => updateBounds(e))
      .on_mouse_up("left", (e) => updateBounds(e))
      .on_drop((e, evCx) => { const f = e.paths?.[0]; if (f) evCx.spawn(async (acx) => this.loadSource(acx, f)); })
      .when(!this.video && Boolean(this.eqView), (el) =>
        el.child(div().absolute().top(0).left(0).w(winW - 2).h(COMPACT_H - 2).child(this.eqView))
      )
      .child(header)
      .when(this.video, (el) =>
        el.child(v_flex().flex_1().min_h(0).items_center().justify_center().p(PAD - 1).child(screen))
      )
      .child(this.video ? renderVideoControls() : renderCompactControls())
      .when(Boolean(compactSeekSeam), (el) => el.child(compactSeekSeam))
      .when(Boolean(this.video && this.notice), (el) =>
        el.child(
          div()
            .absolute().top(HEADER_H + 6).left(PAD).right(PAD).px(8).py(4).rounded(6)
            .bg(t.popover ?? t.raised ?? chromeBase).border(1).border_color(t.accent ?? "#e3814f").shadow_md()
            .text_size(10).text_color(t.foreground).text_center().whitespace_nowrap().overflow_hidden()
            .child(this.notice)
        )
      )
      .when(Boolean(this.video && this.message === "missingYtDlp"), (el) =>
        el.child(
          div()
            .absolute().bottom(CONTROLS_H + 6).left(PAD).p(2).rounded(6)
            .bg(t.popover ?? chromeBase).border(1).border_color(borderBase).shadow_md()
            .on_mouse_down("left", (_e, evCx) => evCx.stop_propagation())
            .child(this.btn("tunr-copy", tr("copyCommand"), (evCx) => { evCx.write_to_clipboard(this.installCommand); this.copied = true; }, { size: 24, tip: tr(this.copied ? "copied" : "copyCommand") }))
        )
      )
      .when(this.video && !isSystem && this.showVolume && Boolean(this.volumeSlider), (el) =>
        el.child(this.renderSliderPopover("tunr-volume-popover", "volume", this.volumeSlider, `${Math.round(this.volume)}%`, t, borderBase, chromeBase))
      )
      .when(this.video && this.showOpacity && Boolean(this.opacitySlider), (el) =>
        el.child(this.renderSliderPopover("tunr-opacity-popover", "opacity", this.opacitySlider, `${Math.round(this.opacity)}%`, t, borderBase, chromeBase))
      )
      .when(this.video && this.showUrl && Boolean(this.urlInput), (el) =>
        el.child(
          div()
            .id("tunr-url-popover")
            .absolute().top(HEADER_H + 4).left(PAD).right(PAD).p(5).rounded(8)
            .bg(t.popover ?? chromeBase).border(1).border_color(borderBase).shadow_md()
            .on_mouse_down("left", (_e, evCx) => evCx.stop_propagation())
            .child(Input.new(this.urlInput).w_full().text_size(12).text_color(t.foreground))
        )
      )
      .when(this.video && this.debug && this.showFps, (el) => el.child(div().absolute().top(HEADER_H + 4).right(PAD).w(150).h(110).child(div().relative().size_full().child(fps_monitor()))));

    const root = div().id("tunr-frame").size_full().rounded(10).shadow_lg().child(card);
    if (this.debug) {
      const dt = now() - t0;
      this.st.jsMs += dt;
      this.win.jsMs += dt;
    }
    return root;
  }
}
