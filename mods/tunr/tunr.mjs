#!/usr/bin/env node
// tunr 引擎：ffmpeg 把影像縮成字元格、ffplay 放聲音，畫面用本機 TCP 一幀一幀推給 mod。
//   node tunr.mjs --source <檔案或網址> --port <埠> [--cols 48 --rows 16 --mode mono|low --video 1 --eq 1 --volume 80 --speed 1 --fps 24 --log <檔>]
// 協定（127.0.0.1，一次一個連線，新連線會取代舊的）：
//   引擎 → mod：訊息一律以 "\f" 結尾，內容只有 ASCII。"\x01" 開頭是狀態 JSON，"\x02" 開頭是縮小模式等化器高度（'0'..'9'），否則是一幀畫面。
//     畫面：列用 "\n" 隔開。mono 的一列就是文字；low 的一列是用 "|" 隔開的段落，每段第一個字是顏色編號 0-7，後面是文字。
//   mod → 引擎：一行一個 JSON：{cmd:"play"|"pause"|"toggle"|"seek"|"video"|"eq"|"mode"|"size"|"volume"|"speed"|"quit", ...}
// 聲音是主時鐘（ffplay 的 stderr 會印目前播放位置）；影像照這個時鐘丟掉過期的幀，所以畫面不會落後聲音。
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { needsYtDlp } from "./source.mjs";
import { SpectrumAnalyzer, FFT_SIZE } from "./spectrum.mjs";
import { escapeAsciiJson } from "./wire.mjs";
import { createSystemStreamParser } from "./system-stream.mjs";
import { eqBandCount } from "./layout.js";
import { encodeEqBands, EQ_FPS, EQ_SAMPLE_RATE } from "./eq.mjs";
import { PcmTimeline } from "./pcm-sync.mjs";
import { DEFAULT_SPEED, normalizeSpeed, advanceMediaClock, audioTimestampToMediaPos, computePlaybackClock } from "./speed.mjs";
import { RECONNECT_INPUT_ARGS, SUCCESS_PLAY_RESET_MS, isHttpSource, evaluateAudioExit } from "./playback-exit.mjs";
import { ZmtpReqClient, findFreePort } from "./zmtp.mjs";
import { VOLUME_THROTTLE_MS, clampVolume, buildAzmqCommand, buildFfplayAudioArgs, hasAzmqFilter, createThrottle } from "./volume.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
// --path：視窗從使用者登入環境拿到的 PATH（Linux、macOS）。hc 開的終端可能讀不到登入 shell 的設定，
// 不換的話 pipx、Homebrew 裝的 yt-dlp 會找不到
const PATH_ARG = arg("path", null);
if (PATH_ARG) process.env.PATH = PATH_ARG;
const SOURCE = arg("source");
const PORT = Number(arg("port", 0));
const FPS = Math.min(30, Math.max(1, Number(arg("fps", 24))));
const LOG = arg("log", null);
if (!SOURCE || !PORT) {
  console.error("usage: node tunr.mjs --source <file|url> --port <port> [--cols --rows --mode --video --volume --speed --fps --log]");
  process.exit(2);
}

const RAMP = " .:-=+*#%@";
const CELL_ASPECT = 0.5; // 字寬 / 字高（JetBrains Mono 10px 搭 12px 行高約 6:12）
const S = {
  cols: Number(arg("cols", 48)),
  rows: Number(arg("rows", 16)),
  mode: arg("mode", "mono"),
  video: arg("video", "1") !== "0",
  eq: arg("eq", "1") !== "0",
  volume: clampVolume(arg("volume", 80), 80),
  speed: normalizeSpeed(arg("speed", DEFAULT_SPEED), DEFAULT_SPEED),
  pos: 0, // 暫停或剛啟動時的位置（秒）
  playing: false,
  ended: false,
  dur: 0,
};

// ---- 來源資訊 ----
const isSystem = SOURCE === "system";
const DISABLE_AZMQ = argv.includes("--no-azmq") || process.env.TUNR_DISABLE_AZMQ === "1";
function detectAzmqSupport() {
  if (isSystem || DISABLE_AZMQ) return false;
  try {
    const r = spawnSync("ffmpeg", ["-v", "quiet", "-filters"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    if (r.error || r.status !== 0) return false;
    return hasAzmqFilter(r.stdout);
  } catch {
    return false;
  }
}
const HAS_AZMQ = detectAzmqSupport();
const extracted = !isSystem && needsYtDlp(SOURCE);
let videoSource = SOURCE, audioSource = SOURCE, sourceError = null;
function resolveSource() {
  if (!extracted) return null;
  const result = spawnSync("yt-dlp", ["--dump-single-json", "--no-playlist", "-f", "bv*[height<=360]+ba/b[height<=360]/b", "--", SOURCE], { encoding: "utf8", windowsHide: true, timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error?.code === "ENOENT") { sourceError = "missingYtDlp"; return null; }
  if (result.status !== 0) { sourceError = "resolveFailed"; return null; }
  try {
    const info = JSON.parse(result.stdout);
    const formats = info.requested_formats ?? [info];
    const v = formats.find(f => f.vcodec && f.vcodec !== "none") ?? formats[0];
    const a = formats.find(f => f.acodec && f.acodec !== "none") ?? v;
    if (!v?.url || !a?.url) throw new Error("missing stream URL");
    videoSource = v.url; audioSource = a.url; sourceError = null;
    return { dur: Number(info.duration) || 0, hasAudio: Boolean(a.acodec && a.acodec !== "none"), hasVideo: Boolean(v.vcodec && v.vcodec !== "none"), w: v.width || info.width || 16, h: v.height || info.height || 9 };
  } catch { sourceError = "resolveFailed"; return null; }
}
function probe() {
  if (isSystem) {
    if (process.platform !== "win32") {
      sourceError = "windowsOnly";
      return { dur: 0, hasAudio: false, hasVideo: false, w: S.cols, h: S.rows, isSystem: true };
    }
    return { dur: 0, hasAudio: false, hasVideo: true, w: S.cols, h: S.rows, isSystem: true };
  }
  if (extracted) return resolveSource() ?? { dur: 0, hasAudio: false, hasVideo: false, w: 16, h: 9 };
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", SOURCE], { encoding: "utf8", windowsHide: true });
  if (r.error || r.status !== 0) {
    sourceError = "playFailed";
    return { dur: 0, hasAudio: false, hasVideo: false, w: 16, h: 9 };
  }
  let info = {};
  try { info = JSON.parse(r.stdout || "{}"); } catch {}
  const streams = info.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && s.width);
  const hasAudio = streams.some((s) => s.codec_type === "audio");
  const hasVideo = Boolean(v);
  if (!hasAudio && !hasVideo) {
    sourceError = "playFailed";
  }
  return {
    dur: Number(info.format?.duration) || 0,
    hasAudio,
    hasVideo,
    w: v?.width ?? 16,
    h: v?.height ?? 9,
  };
}
const SRC = probe();
S.dur = SRC.dur;
if (!SRC.hasVideo && !sourceError) S.video = false;

// 在 cols×rows 裡保持比例：回傳實際的字數
function fit() {
  if (isSystem) return { c: S.cols, r: S.rows };
  const aspect = SRC.w / SRC.h / CELL_ASPECT; // 以字為單位的寬高比
  let c = S.cols;
  let r = Math.round(c / aspect);
  if (r > S.rows) { r = S.rows; c = Math.round(r * aspect); }
  return { c: Math.max(2, c), r: Math.max(2, r) };
}

// ---- 狀態 ----
let client = null;
let audio = null; // { proc }
let audioEq = null; // { proc, timeline, dead }
let video = null; // { proc, gen }
let systemProc = null;
let currentMedia = null;
let analyzer = null;
let eqAnalyzer = null;
let captureRate = 48000;
let spectrumTimer = null;
let eqTimer = null;
let lastSentEq = null;
let lastPCMTime = 0;
let genCounter = 0;
let queue = []; // { pts, text }
let startWall = 0; // 這一輪 play 開始的時間（沒有聲音時的時鐘）
let clk = null; // { pos, wall } 最後一次從 ffplay 讀到的位置
let audioStartedAt = 0;
let audioLatency = null;
const stats = { sent: 0, dropped: 0, decoded: 0, syncN: 0, syncSum: 0, syncMax: 0, syncSigned: 0, maxQueue: 0 };
let lastFrameWall = 0;

const now = () => Date.now();
const kill = (p) => { try { p?.kill(); } catch {} };
const httpInputArgs = (src) => (isHttpSource(src) ? RECONNECT_INPUT_ARGS : []);
let streamRetries = 0;
let audioSuccessWall = 0;
let videoRetries = 0;
let videoSuccessWall = 0;

function clock() {
  if (isSystem) return 0;
  return computePlaybackClock({
    playing: S.playing,
    pos: S.pos,
    speed: S.speed,
    hasAudio: SRC.hasAudio,
    clk,
    startWall,
    nowMs: now(),
  });
}

function send(text) {
  if (client && !client.destroyed) client.write(text + "\f");
}
function sendStatus(extra = {}) {
  const pos = Math.min(clock(), S.dur || clock());
  const json = JSON.stringify({ pos: +pos.toFixed(2), dur: +S.dur.toFixed(2), playing: S.playing, ended: S.ended, video: S.video, eq: S.eq, mode: S.mode, speed: S.speed, cols: S.cols, rows: S.rows, volume: S.volume, fps: FPS, error: sourceError, isSystem, ...(isSystem && currentMedia ? { media: currentMedia } : {}), ...extra });
  send("\x01" + escapeAsciiJson(json));
}

// ---- 影像 ----
function toText(buf, c, r) {
  const lines = [];
  if (S.mode === "mono") {
    for (let y = 0; y < r; y++) {
      let s = "";
      for (let x = 0; x < c; x++) s += RAMP[Math.min(9, (buf[y * c + x] * 10) >> 8)];
      lines.push(s);
    }
    return lines.join("\n");
  }
  for (let y = 0; y < r; y++) {
    const segs = [];
    let cur = -1;
    let text = "";
    for (let x = 0; x < c; x++) {
      const i = (y * c + x) * 3;
      const R = buf[i], G = buf[i + 1], B = buf[i + 2];
      const lum = 0.299 * R + 0.587 * G + 0.114 * B;
      const ch = RAMP[Math.min(9, (lum * 10) >> 8)];
      let col;
      if (ch === " ") col = cur < 0 ? 0 : cur; // 暗到看不見的字不另外起一段
      else col = colorOf(R, G, B, lum);
      if (cur < 0) cur = col;
      if (col !== cur) { segs.push(cur + text); text = ""; cur = col; }
      text += ch;
    }
    segs.push(cur + text);
    lines.push(segs.join("|"));
  }
  return lines.join("\n");
}
// 0 中性、1 紅、2 黃、3 綠、4 青、5 藍、6 洋紅、7 亮中性（顏色本身在 mod 裡，都是低彩度）
function colorOf(R, G, B, lum) {
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const sat = max ? (max - min) / max : 0;
  if (sat < 0.22 || max - min < 28) return lum > 190 ? 7 : 0;
  let h;
  const d = max - min;
  if (max === R) h = ((G - B) / d + 6) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return 1 + (Math.floor(h + 0.5) % 6 === 0 ? 0 : Math.floor(h + 0.5) % 6); // 1..6：紅黃綠青藍洋紅
}

function stopVideo() {
  if (video) { video.dead = true; kill(video.proc); video = null; }
  queue = [];
}
function startVideo(at) {
  stopVideo();
  if (!S.video || !SRC.hasVideo) return;
  const { c, r } = fit();
  const gray = S.mode === "mono";
  const bpp = gray ? 1 : 3;
  const size = c * r * bpp;
  videoSuccessWall = 0;
  const proc = spawn("ffmpeg", [
    "-v", "error", "-nostdin",
    ...httpInputArgs(videoSource),
    "-ss", String(at), "-i", videoSource,
    "-an", "-vf", `scale=${c}:${r}:flags=area,format=${gray ? "gray" : "rgb24"}`, "-r", String(FPS),
    "-f", "rawvideo", "-",
  ], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const me = { proc, gen: ++genCounter, dead: false };
  video = me;
  let pending = [];
  let have = 0;
  let n = 0;
  proc.stdout.on("data", (chunk) => {
    if (me.dead) return;
    if (!videoSuccessWall) videoSuccessWall = now();
    pending.push(chunk);
    have += chunk.length;
    if (have >= size) {
      const all = Buffer.concat(pending);
      let off = 0;
      while (all.length - off >= size) {
        queue.push({ pts: at + n / FPS, text: toText(all.subarray(off, off + size), c, r) });
        off += size;
        n++;
        stats.decoded++;
      }
      pending = off < all.length ? [all.subarray(off)] : [];
      have = all.length - off;
    }
    stats.maxQueue = Math.max(stats.maxQueue, queue.length);
    if (queue.length > 48) proc.stdout.pause();
  });
  proc.on("error", () => {});
  proc.on("exit", (code) => {
    if (video !== me) return;
    video = null;
    if (!code || !S.playing) return;
    const curClock = clock();
    if (SRC.hasAudio) {
      const playedLong = Boolean(videoSuccessWall) && (now() - videoSuccessWall) >= SUCCESS_PLAY_RESET_MS;
      if (playedLong) videoRetries = 0;
      if (videoRetries < 3) {
        videoRetries++;
        if (extracted && videoRetries >= 2) {
          retryStream(curClock, true);
        } else {
          startVideo(curClock);
        }
      }
      return;
    }
    const decision = evaluateAudioExit({
      clock: curClock,
      dur: S.dur,
      code,
      retries: streamRetries,
      lastSuccessAtMs: videoSuccessWall,
      nowMs: now(),
      hasClk: Boolean(videoSuccessWall),
      extracted,
      startAt: at,
    });
    if (decision.action === "retry") {
      streamRetries = decision.nextRetries;
      retryStream(decision.resumeAt, decision.refreshUrl);
    } else if (decision.action === "fail") {
      streamRetries = decision.nextRetries;
      S.playing = false;
      S.ended = false;
      sourceError = decision.error;
      stopAudioEq();
      sendStatus();
    }
  });
}

// 每 8 毫秒看一次：該顯示的幀（pts ≤ 時鐘）只送最新的一張，其餘算丟幀
setInterval(() => {
  if (!S.playing || (!video && queue.length === 0)) return;
  const t = clock();
  let pick = null;
  let took = 0;
  while (queue.length && queue[0].pts <= t) { pick = queue.shift(); took++; }
  if (queue.length < 24 && video?.proc.stdout.isPaused()) video.proc.stdout.resume();
  if (!pick) return;
  if (took > 1) stats.dropped += took - 1;
  send(pick.text);
  stats.sent++;
  lastFrameWall = now();
  // 畫面位置對聲音位置的差：聲音位置用 ffplay 最後一次回報的位置加上經過的時間
  if (SRC.hasAudio && clk) {
    const diff = pick.pts - advanceMediaClock(clk.pos, now() - clk.wall, S.speed);
    stats.syncN++;
    stats.syncSum += Math.abs(diff);
    stats.syncSigned += diff;
    stats.syncMax = Math.max(stats.syncMax, Math.abs(diff));
  }
}, 8);

// ---- 聲音 ----
let audioGen = 0;

function closeAudioZmtp(me) {
  if (me?.zmtp) {
    try { me.zmtp.close(); } catch {}
    me.zmtp = null;
  }
}

function sendLiveVolumeToAudio(me, volume) {
  if (!me || me.dead || audio !== me || !me.zmtp || shuttingDown) return;
  me.zmtp.request(buildAzmqCommand(volume)).catch(() => {});
}

const volumeThrottle = createThrottle({
  intervalMs: VOLUME_THROTTLE_MS,
  nowFn: now,
  onSend: (vol) => {
    if (!S.playing || isSystem || !SRC.hasAudio || !audio || audio.dead) return;
    if (!audio.hasClk) {
      audio.syncVolumeOnClk = true;
      return;
    }
    sendLiveVolumeToAudio(audio, vol);
  },
});

function stopAudio() {
  volumeThrottle.cancel();
  if (audio) {
    audio.dead = true;
    closeAudioZmtp(audio);
    kill(audio.proc);
    audio = null;
  }
  clk = null;
}

function launchAudioProc(me, at, zmtpPort) {
  if (me.dead || audio !== me || shuttingDown) return;
  const spawnVolume = S.volume;
  me.spawnVolume = spawnVolume;
  me.syncVolumeOnClk = false;
  me.zmtpPort = zmtpPort;
  if (zmtpPort > 0) {
    me.zmtp = new ZmtpReqClient(zmtpPort, {
      shouldAbort: () => me.dead || audio !== me || shuttingDown,
    });
  }
  const args = buildFfplayAudioArgs({
    source: audioSource,
    at,
    volume: spawnVolume,
    speed: me.speed,
    port: zmtpPort,
    reconnectArgs: httpInputArgs(audioSource),
  });
  const proc = spawn("ffplay", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  me.proc = proc;
  let buf = "";
  proc.stderr.on("data", (d) => {
    if (me.dead) return;
    buf += d.toString("latin1");
    const parts = buf.split(/[\r\n]/);
    buf = parts.pop();
    for (const line of parts) {
      const m = /^\s*(\d+(?:\.\d+)?)\s+(?:A-V|M-A|M-V|A)\b/.exec(line);
      if (m) {
        if (!clk) {
          audioLatency ??= now() - audioStartedAt;
          audioSuccessWall = now();
          me.hasClk = true;
          if (me.zmtp && (me.syncVolumeOnClk || S.volume !== me.spawnVolume)) {
            me.syncVolumeOnClk = false;
            sendLiveVolumeToAudio(me, S.volume);
          }
        }
        // ffplay 加了 -ss 之後報的數字起點不固定（實測 -ss 20 從 10.32 開始），但之後走得準：只取「第一次報的數字」當起點
        // 實測加了 -af atempo=<speed> 之後 ffplay 印出的時間仍以牆上 1x 推進，因此乘以 speed 才是原片媒體時間
        const v = Number(m[1]);
        if (me.base === undefined) me.base = v;
        clk = { pos: audioTimestampToMediaPos({ at, rawTime: v, baseTime: me.base, speed: me.speed }), wall: now() };
      }
    }
    if (buf.length > 4096) buf = "";
  });
  proc.on("error", () => {});
  proc.on("exit", (code) => {
    closeAudioZmtp(me);
    if (me.dead) return;
    const hadClk = Boolean(clk);
    const curClock = clock();
    if (audio === me) audio = null;
    if (!S.playing) return;
    const decision = evaluateAudioExit({
      clock: curClock,
      dur: S.dur,
      code,
      retries: streamRetries,
      lastSuccessAtMs: audioSuccessWall,
      nowMs: now(),
      hasClk: hadClk,
      extracted,
      startAt: at,
    });
    if (decision.action === "retry") {
      streamRetries = decision.nextRetries;
      retryStream(decision.resumeAt, decision.refreshUrl);
      return;
    }
    if (decision.action === "fail") {
      streamRetries = decision.nextRetries;
      S.playing = false;
      S.ended = false;
      sourceError = decision.error;
      stopVideo();
      stopAudioEq();
      sendStatus();
      return;
    }
    // 自然播完
    streamRetries = 0;
    S.playing = false;
    S.ended = true;
    S.pos = S.dur > 0 ? S.dur : curClock;
    stopVideo();
    stopAudioEq();
    sendStatus();
  });
}

function startAudio(at) {
  stopAudio();
  if (!SRC.hasAudio) return;
  audioSuccessWall = 0;
  const speed = S.speed;
  const me = {
    proc: null,
    zmtp: null,
    zmtpPort: 0,
    dead: false,
    speed,
    gen: ++audioGen,
    hasClk: false,
    spawnVolume: S.volume,
    syncVolumeOnClk: false,
  };
  audio = me;
  audioStartedAt = now();
  if (!HAS_AZMQ) {
    launchAudioProc(me, at, 0);
    return;
  }
  findFreePort().then((port) => {
    if (me.dead || audio !== me || shuttingDown) return;
    launchAudioProc(me, at, port);
  }).catch(() => {
    if (me.dead || audio !== me || shuttingDown) return;
    launchAudioProc(me, at, 0);
  });
}

// ---- 縮小模式等化器（檔案／網址 PCM 解碼與送訊）----
function currentEqBands() {
  return eqBandCount(S.cols);
}

function shouldRunAudioEq() {
  return !isSystem && !sourceError && S.playing && !S.video && S.eq && SRC.hasAudio;
}

function stopAudioEq() {
  if (audioEq) {
    audioEq.dead = true;
    kill(audioEq.proc);
    audioEq = null;
  }
}

function startAudioEq(at) {
  stopAudioEq();
  if (!shouldRunAudioEq()) return;
  const bands = currentEqBands();
  if (!eqAnalyzer) {
    eqAnalyzer = new SpectrumAnalyzer(EQ_SAMPLE_RATE, bands, 10);
  } else {
    eqAnalyzer.setSampleRate(EQ_SAMPLE_RATE);
    eqAnalyzer.setDimensions(bands, 10);
    eqAnalyzer.resetNormalizedHeights();
  }
  const timeline = new PcmTimeline({
    startTime: at,
    sampleRate: EQ_SAMPLE_RATE,
    maxLeadSec: 2.0,
    resumeLeadSec: 1.0,
    keepBehindSec: 0.5,
  });
  const proc = spawn("ffmpeg", [
    "-v", "error", "-nostdin",
    ...httpInputArgs(audioSource),
    "-ss", String(at), "-i", audioSource,
    "-vn", "-sn", "-dn", "-ac", "1", "-ar", String(EQ_SAMPLE_RATE),
    "-f", "s16le", "-",
  ], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const me = { proc, timeline, dead: false };
  audioEq = me;
  proc.stdout.on("data", (chunk) => {
    if (me.dead) return;
    timeline.pushPcm16(chunk);
    if (timeline.backpressure(clock()).shouldPause && !proc.stdout.isPaused()) {
      proc.stdout.pause();
    }
  });
  proc.on("error", () => {});
  proc.on("exit", () => {
    me.timeline.eof = true;
    if (me.proc === proc) me.proc = null;
  });
}

function stopEqLoop() {
  if (eqTimer) {
    clearInterval(eqTimer);
    eqTimer = null;
  }
}

function startEqLoop() {
  if (eqTimer) return;
  if (S.video || !S.eq || sourceError || (!isSystem && !SRC.hasAudio)) return;
  eqTimer = setInterval(() => {
    if (S.video || !S.eq || sourceError || (!isSystem && !SRC.hasAudio)) {
      stopEqLoop();
      return;
    }
    let norm;
    let allZero = false;
    if (isSystem) {
      if (!analyzer) return;
      if (S.playing) {
        if (now() - lastPCMTime > 150) {
          ({ heights: norm, allZero } = analyzer.decayNormalizedHeights());
        } else {
          norm = analyzer.computeNormalizedHeights();
        }
      } else {
        ({ heights: norm, allZero } = analyzer.decayNormalizedHeights());
      }
    } else {
      if (!eqAnalyzer) {
        eqAnalyzer = new SpectrumAnalyzer(EQ_SAMPLE_RATE, currentEqBands(), 10);
      }
      if (S.playing) {
        const t = clock();
        const win = audioEq?.timeline?.getWindowForClock(t, FFT_SIZE);
        if (audioEq?.proc && !audioEq.dead && audioEq.timeline.backpressure(t).shouldResume && audioEq.proc.stdout.isPaused()) {
          audioEq.proc.stdout.resume();
        }
        if (win) {
          norm = eqAnalyzer.computeNormalizedHeightsFromSamples(win);
        } else {
          ({ heights: norm, allZero } = eqAnalyzer.decayNormalizedHeights());
        }
      } else {
        ({ heights: norm, allZero } = eqAnalyzer.decayNormalizedHeights());
      }
    }
    const encoded = encodeEqBands(norm);
    if (encoded !== lastSentEq) {
      send(encoded);
      lastSentEq = encoded;
    }
    if (!S.playing && allZero && encoded === lastSentEq) {
      stopEqLoop();
    }
  }, Math.round(1000 / EQ_FPS));
}

// ---- 擷取系統音訊與 SMTC（合併為單一 PowerShell 程序 system.ps1）----
function startCapture() {
  if (!isSystem || systemProc || process.platform !== "win32") return;
  analyzer = new SpectrumAnalyzer(captureRate, S.video ? S.cols : currentEqBands(), S.rows);
  const script = path.join(here, "system.ps1");
  const proc = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-ParentPid",
    String(process.pid),
  ], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });

  systemProc = proc;
  const parser = createSystemStreamParser();

  proc.stdout.on("data", (chunk) => {
    const events = parser.push(chunk);
    for (const ev of events) {
      if (ev.type === "rate") {
        captureRate = ev.sampleRate || 48000;
        analyzer.setSampleRate(captureRate);
      } else if (ev.type === "pcm") {
        if (S.video || S.eq) {
          analyzer.pushPCM16(ev.data);
          lastPCMTime = now();
        }
      } else if (ev.type === "media") {
        currentMedia = ev.media;
        sendStatus();
      }
    }
  });

  proc.on("error", () => {});
  proc.on("exit", () => {
    if (systemProc === proc) systemProc = null;
  });
}

function sendMediaCommand(cmd) {
  if (!systemProc || !systemProc.stdin || systemProc.stdin.destroyed) return;
  try { systemProc.stdin.write(cmd + "\n"); } catch {}
}

function stopCapture() {
  if (systemProc) {
    try { systemProc.stdin?.end(); } catch {}
    try { systemProc.kill(); } catch {}
    systemProc = null;
  }
  currentMedia = null;
  if (spectrumTimer) {
    clearInterval(spectrumTimer);
    spectrumTimer = null;
  }
  stopEqLoop();
}

function startSpectrumLoop() {
  if (spectrumTimer) clearInterval(spectrumTimer);
  spectrumTimer = setInterval(() => {
    if (!isSystem || !S.playing || !S.video || !analyzer) return;
    if (now() - lastPCMTime > 150) {
      analyzer.pushPCM16(Buffer.alloc(1024));
    }
    const frame = analyzer.render(S.mode);
    send(frame);
    stats.sent++;
  }, Math.round(1000 / FPS));
}

// ---- 指令 ----
function retryStream(at, refreshUrl = false) {
  at = Math.max(0, Math.max(Number.isFinite(at) ? at : 0, clock()));
  S.pos = at;
  startWall = now();
  clk = null;
  stopAudio(); stopVideo(); stopAudioEq();
  if (extracted && refreshUrl && !resolveSource()) {
    S.playing = false;
    S.ended = false;
    sendStatus();
    return;
  }
  play(at, true);
}
function play(at = S.pos, retry = false) {
  if (sourceError) { sendStatus(); return; }
  if (isSystem) {
    S.playing = true;
    lastSentEq = null;
    startCapture();
    if (S.video) startSpectrumLoop();
    else if (S.eq) startEqLoop();
    sendStatus();
    return;
  }
  clearTimeout(volumeTimer);
  volumeThrottle.cancel();
  if (!retry) {
    streamRetries = 0;
    videoRetries = 0;
  }
  if (S.ended || (S.dur && at >= S.dur - 0.2)) { at = 0; }
  S.ended = false;
  S.pos = at;
  S.playing = true;
  startWall = now();
  clk = null;
  lastSentEq = null;
  startAudio(at);
  startVideo(at);
  if (shouldRunAudioEq()) {
    startAudioEq(at);
    startEqLoop();
  } else {
    stopAudioEq();
  }
  sendStatus();
}
function pause() {
  if (!S.playing) return;
  if (isSystem) {
    S.playing = false;
    if (!S.video && S.eq) startEqLoop();
    sendStatus();
    return;
  }
  clearTimeout(volumeTimer);
  volumeThrottle.cancel();
  S.pos = Math.min(clock(), S.dur || Infinity);
  S.playing = false;
  stopAudio();
  stopVideo();
  stopAudioEq();
  if (!S.video && S.eq && SRC.hasAudio) startEqLoop();
  sendStatus();
}
function seek(to) {
  if (isSystem) return;
  to = Math.max(0, Math.min(S.dur || to, to));
  if (S.playing) play(to);
  else { S.pos = to; S.ended = false; sendStatus(); }
}
let volumeTimer = null;
function restartAudioAtClock() {
  if (!S.playing || isSystem) return;
  if (audioSuccessWall && (now() - audioSuccessWall) >= SUCCESS_PLAY_RESET_MS) {
    streamRetries = 0;
  }
  const cur = Math.min(clock(), S.dur || Infinity);
  S.pos = cur;
  startWall = now();
  if (SRC.hasAudio) startAudio(cur);
}
function handle(m) {
  switch (m.cmd) {
    case "play": play(); break;
    case "pause": pause(); break;
    case "toggle":
      if (isSystem && currentMedia && currentMedia.status !== "none") {
        sendMediaCommand("toggle");
      } else {
        S.playing ? pause() : play();
      }
      break;
    case "mediaToggle": sendMediaCommand("toggle"); break;
    case "mediaPlay": sendMediaCommand("play"); break;
    case "mediaPause": sendMediaCommand("pause"); break;
    case "mediaNext": sendMediaCommand("next"); break;
    case "mediaPrev": sendMediaCommand("prev"); break;
    case "seek": seek(Number(m.to) || 0); break;
    case "video":
      S.video = Boolean(m.on) && SRC.hasVideo;
      lastSentEq = null;
      if (S.video) {
        stopAudioEq();
        stopEqLoop();
        if (isSystem) {
          analyzer?.setDimensions(S.cols, S.rows);
          if (S.playing) startSpectrumLoop();
        } else if (S.playing) {
          startVideo(clock());
        }
      } else {
        if (isSystem) {
          if (spectrumTimer) { clearInterval(spectrumTimer); spectrumTimer = null; }
          analyzer?.setDimensions(currentEqBands(), S.rows);
          analyzer?.resetNormalizedHeights();
          if (S.playing && S.eq) startEqLoop();
        } else {
          stopVideo();
          if (shouldRunAudioEq()) {
            startAudioEq(clock());
            startEqLoop();
          }
        }
      }
      sendStatus();
      break;
    case "eq":
      S.eq = Boolean(m.on);
      lastSentEq = null;
      if (!S.eq) {
        stopAudioEq();
        stopEqLoop();
        analyzer?.resetNormalizedHeights();
        eqAnalyzer?.resetNormalizedHeights();
      } else if (!S.video && !sourceError) {
        if (isSystem) {
          analyzer?.setDimensions(currentEqBands(), S.rows);
          if (S.playing) startEqLoop();
        } else if (S.playing && SRC.hasAudio) {
          startAudioEq(clock());
          startEqLoop();
        }
      }
      sendStatus();
      break;
    case "mode":
      if (m.mode === "mono" || m.mode === "low") {
        S.mode = m.mode;
        if (S.playing && S.video && !isSystem) startVideo(clock());
      }
      sendStatus();
      break;
    case "size":
      if (m.cols > 0 && m.rows > 0) {
        S.cols = m.cols | 0;
        S.rows = m.rows | 0;
        lastSentEq = null;
        const bands = currentEqBands();
        if (isSystem && analyzer) analyzer.setDimensions(S.video ? S.cols : bands, S.rows);
        if (!isSystem && eqAnalyzer) eqAnalyzer.setDimensions(bands, 10);
        if (S.playing && S.video && !isSystem) startVideo(clock());
      }
      sendStatus();
      break;
    case "volume":
      if (isSystem) return;
      S.volume = clampVolume(m.value, 0);
      clearTimeout(volumeTimer);
      if (S.playing && SRC.hasAudio) {
        if (HAS_AZMQ) {
          volumeThrottle.push(S.volume);
        } else {
          // 沒有 azmq 時退回原本做法：停 300ms 才從目前位置重開 ffplay
          volumeTimer = setTimeout(() => { restartAudioAtClock(); }, 300);
        }
      }
      sendStatus();
      break;
    case "speed": {
      if (isSystem) return;
      const nextSpeed = normalizeSpeed(m.value, S.speed);
      if (nextSpeed === S.speed) { sendStatus(); return; }
      clearTimeout(volumeTimer);
      volumeThrottle.cancel();
      if (S.playing) {
        const cur = Math.min(clock(), S.dur || Infinity);
        S.pos = cur;
        startWall = now();
        S.speed = nextSpeed;
        if (SRC.hasAudio) startAudio(cur);
      } else {
        S.speed = nextSpeed;
      }
      sendStatus();
      break;
    }
    case "stats": send("\x01" + escapeAsciiJson(JSON.stringify({ stats: report() }))); break;
    case "quit": shutdown(0); break;
  }
}

// ---- 連線 ----
const INITIAL_IDLE_MS = 60000;
const DISCONNECT_IDLE_MS = 15000;
let idleTimer = null;
const server = net.createServer((sock) => {
  if (client && client !== sock) client.destroy();
  client = sock;
  lastSentEq = null;
  clearTimeout(idleTimer);
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString("latin1");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { handle(JSON.parse(line)); } catch (e) { console.error("bad command:", line, e.message); }
    }
  });
  sock.on("error", () => {});
  sock.on("close", () => {
    if (client !== sock) return;
    client = null;
    // 沒人連著超過 15 秒（mod 當掉或視窗關了）就自己收掉，不留背景程序
    idleTimer = setTimeout(() => shutdown(0), DISCONNECT_IDLE_MS);
  });
  sock.setNoDelay(true);
  sendStatus({ hello: true, aspect: [SRC.w, SRC.h], hasAudio: SRC.hasAudio, hasVideo: SRC.hasVideo, liveVolume: HAS_AZMQ });
});
server.on("error", () => shutdown(1));
server.listen(PORT, "127.0.0.1", () => {
  console.log(`tunr engine on 127.0.0.1:${PORT} source=${SOURCE} dur=${S.dur}`);
  // 開始聽之後 60 秒內都沒有 client 連上就自己結束，不留在背景
  if (!client) idleTimer = setTimeout(() => shutdown(0), INITIAL_IDLE_MS);
});

function report() {
  return {
    t: new Date().toISOString(),
    pos: +clock().toFixed(2),
    speed: S.speed,
    liveVolume: HAS_AZMQ,
    audioPid: audio?.proc?.pid ?? null,
    zmtpPort: audio?.zmtpPort ?? 0,
    sent: stats.sent, decoded: stats.decoded, dropped: stats.dropped, maxQueue: stats.maxQueue,
    syncMeanAbs: stats.syncN ? +(stats.syncSum / stats.syncN).toFixed(3) : null,
    syncMaxAbs: +stats.syncMax.toFixed(3),
    syncMeanSigned: stats.syncN ? +(stats.syncSigned / stats.syncN).toFixed(3) : null,
    audioLatencyMs: audioLatency,
  };
}
const logTimer = LOG ? setInterval(() => { try { fs.appendFileSync(LOG, JSON.stringify(report()) + "\n"); } catch {} }, 1000) : null;
const statusTimer = setInterval(() => {
  if (!S.playing) return;
  if (!isSystem && !SRC.hasAudio && S.dur > 0 && clock() >= S.dur) {
    S.playing = false;
    S.ended = true;
    S.pos = S.dur;
    stopVideo();
    stopAudioEq();
    sendStatus();
    return;
  }
  sendStatus();
}, 250);

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(idleTimer);
  clearTimeout(volumeTimer);
  volumeThrottle.cancel();
  if (logTimer) clearInterval(logTimer);
  if (statusTimer) clearInterval(statusTimer);
  stopAudio();
  stopVideo();
  stopAudioEq();
  stopEqLoop();
  stopCapture();
  try { server.close(); } catch {}
  try { client?.destroy(); } catch {}
  setTimeout(() => process.exit(code), 50);
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));
process.on("exit", () => {
  closeAudioZmtp(audio);
  kill(audio?.proc);
  kill(video?.proc);
  kill(audioEq?.proc);
  if (systemProc) { try { systemProc.kill(); } catch {} }
});
