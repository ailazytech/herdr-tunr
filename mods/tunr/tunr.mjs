#!/usr/bin/env node
// tunr 引擎：ffmpeg 把影像縮成字元格、ffplay 放聲音，畫面用本機 TCP 一幀一幀推給 mod。
//   node tunr.mjs --source <檔案或網址> --port <埠> [--cols 48 --rows 16 --mode mono|low --video 1 --volume 80 --fps 24 --log <檔>]
// 協定（127.0.0.1，一次一個連線，新連線會取代舊的）：
//   引擎 → mod：訊息一律以 "\f" 結尾，內容只有 ASCII。"\x01" 開頭是狀態 JSON，否則是一幀畫面。
//     畫面：列用 "\n" 隔開。mono 的一列就是文字；low 的一列是用 "|" 隔開的段落，每段第一個字是顏色編號 0-7，後面是文字。
//   mod → 引擎：一行一個 JSON：{cmd:"play"|"pause"|"toggle"|"seek"|"video"|"mode"|"size"|"volume"|"quit", ...}
// 聲音是主時鐘（ffplay 的 stderr 會印目前播放位置）；影像照這個時鐘丟掉過期的幀，所以畫面不會落後聲音。
import net from "node:net";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const SOURCE = arg("source");
const PORT = Number(arg("port", 0));
const FPS = Math.min(30, Math.max(1, Number(arg("fps", 24))));
const LOG = arg("log", null);
if (!SOURCE || !PORT) {
  console.error("usage: node tunr.mjs --source <file|url> --port <port> [--cols --rows --mode --video --volume --fps --log]");
  process.exit(2);
}

const RAMP = " .:-=+*#%@";
const CELL_ASPECT = 0.5; // 字寬 / 字高（JetBrains Mono 10px 搭 12px 行高約 6:12）
const S = {
  cols: Number(arg("cols", 48)),
  rows: Number(arg("rows", 16)),
  mode: arg("mode", "mono"),
  video: arg("video", "1") !== "0",
  volume: Number(arg("volume", 80)),
  pos: 0, // 暫停或剛啟動時的位置（秒）
  playing: false,
  ended: false,
  dur: 0,
};

// ---- 來源資訊 ----
function probe() {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", SOURCE], { encoding: "utf8", windowsHide: true });
  let info = {};
  try { info = JSON.parse(r.stdout || "{}"); } catch {}
  const streams = info.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && s.width);
  return {
    dur: Number(info.format?.duration) || 0,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    hasVideo: Boolean(v),
    w: v?.width ?? 16,
    h: v?.height ?? 9,
  };
}
const SRC = probe();
S.dur = SRC.dur;
if (!SRC.hasVideo) S.video = false;

// 在 cols×rows 裡保持比例：回傳實際的字數
function fit() {
  const aspect = SRC.w / SRC.h / CELL_ASPECT; // 以字為單位的寬高比
  let c = S.cols;
  let r = Math.round(c / aspect);
  if (r > S.rows) { r = S.rows; c = Math.round(r * aspect); }
  return { c: Math.max(2, c), r: Math.max(2, r) };
}

// ---- 狀態 ----
let client = null;
let audio = null; // { proc }
let video = null; // { proc, gen }
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

function clock() {
  if (!S.playing) return S.pos;
  if (SRC.hasAudio && clk) return clk.pos + (now() - clk.wall) / 1000;
  // 聲音還沒開始報位置：畫面先停在起點等它（聲音 4 秒內都沒報就改用牆上時間，例如 ffplay 壞了）
  if (SRC.hasAudio && now() - startWall < 4000) return S.pos;
  return S.pos + (now() - startWall) / 1000;
}

function send(text) {
  if (client && !client.destroyed) client.write(text + "\f");
}
function sendStatus(extra = {}) {
  const pos = Math.min(clock(), S.dur || clock());
  send("\x01" + JSON.stringify({ pos: +pos.toFixed(2), dur: +S.dur.toFixed(2), playing: S.playing, ended: S.ended, video: S.video, mode: S.mode, cols: S.cols, rows: S.rows, volume: S.volume, fps: FPS, ...extra }));
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
  const proc = spawn("ffmpeg", [
    "-v", "error", "-nostdin", "-ss", String(at), "-i", SOURCE,
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
  proc.on("exit", () => { if (video === me) video = null; });
}

// 每 8 毫秒看一次：該顯示的幀（pts ≤ 時鐘）只送最新的一張，其餘算丟幀
setInterval(() => {
  if (!S.playing || !video) return;
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
    const diff = pick.pts - (clk.pos + (now() - clk.wall) / 1000);
    stats.syncN++;
    stats.syncSum += Math.abs(diff);
    stats.syncSigned += diff;
    stats.syncMax = Math.max(stats.syncMax, Math.abs(diff));
  }
}, 8);

// ---- 聲音 ----
function stopAudio() {
  if (audio) { audio.dead = true; kill(audio.proc); audio = null; }
  clk = null;
}
function startAudio(at) {
  stopAudio();
  if (!SRC.hasAudio) return;
  const proc = spawn("ffplay", ["-nodisp", "-autoexit", "-hide_banner", "-ss", String(at), "-volume", String(Math.round(S.volume)), SOURCE], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  const me = { proc, dead: false };
  audio = me;
  audioStartedAt = now();
  let buf = "";
  proc.stderr.on("data", (d) => {
    if (me.dead) return;
    buf += d.toString("latin1");
    const parts = buf.split(/[\r\n]/);
    buf = parts.pop();
    for (const line of parts) {
      const m = /^\s*(\d+(?:\.\d+)?)\s+(?:A-V|M-A|M-V|A)\b/.exec(line);
      if (m) {
        if (!clk) audioLatency ??= now() - audioStartedAt;
        // ffplay 加了 -ss 之後報的數字起點不固定（實測 -ss 20 從 10.32 開始），但之後走得準：只取「第一次報的數字」當起點
        const v = Number(m[1]);
        if (me.base === undefined) me.base = v;
        clk = { pos: at + (v - me.base), wall: now() };
      }
    }
    if (buf.length > 4096) buf = "";
  });
  proc.on("exit", () => {
    if (me.dead) return;
    audio = null;
    // 自然播完
    S.playing = false;
    S.ended = true;
    S.pos = S.dur;
    stopVideo();
    sendStatus();
  });
}

// ---- 指令 ----
function play(at = S.pos) {
  if (S.ended || (S.dur && at >= S.dur - 0.2)) { at = 0; }
  S.ended = false;
  S.pos = at;
  S.playing = true;
  startWall = now();
  clk = null;
  startAudio(at);
  startVideo(at);
  sendStatus();
}
function pause() {
  if (!S.playing) return;
  S.pos = Math.min(clock(), S.dur || Infinity);
  S.playing = false;
  stopAudio();
  stopVideo();
  sendStatus();
}
function seek(to) {
  to = Math.max(0, Math.min(S.dur || to, to));
  if (S.playing) play(to);
  else { S.pos = to; S.ended = false; sendStatus(); }
}
let volumeTimer = null;
function handle(m) {
  switch (m.cmd) {
    case "play": play(); break;
    case "pause": pause(); break;
    case "toggle": S.playing ? pause() : play(); break;
    case "seek": seek(Number(m.to) || 0); break;
    case "video":
      S.video = Boolean(m.on) && SRC.hasVideo;
      if (S.playing) { if (S.video) startVideo(clock()); else stopVideo(); }
      sendStatus();
      break;
    case "mode":
      if (m.mode === "mono" || m.mode === "low") { S.mode = m.mode; if (S.playing && S.video) startVideo(clock()); }
      sendStatus();
      break;
    case "size":
      if (m.cols > 0 && m.rows > 0) { S.cols = m.cols | 0; S.rows = m.rows | 0; if (S.playing && S.video) startVideo(clock()); }
      sendStatus();
      break;
    case "volume":
      S.volume = Math.max(0, Math.min(100, Number(m.value) || 0));
      clearTimeout(volumeTimer);
      // ffplay 的音量只能在啟動時給：停一下沒有再調才重開，位置不變
      if (S.playing) volumeTimer = setTimeout(() => { if (S.playing) startAudio(clock()); }, 300);
      sendStatus();
      break;
    case "stats": send("\x01" + JSON.stringify({ stats: report() })); break;
    case "quit": shutdown(0); break;
  }
}

// ---- 連線 ----
let idleTimer = null;
const server = net.createServer((sock) => {
  if (client && client !== sock) client.destroy();
  client = sock;
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
    idleTimer = setTimeout(() => shutdown(0), 15000);
  });
  sock.setNoDelay(true);
  sendStatus({ hello: true, aspect: [SRC.w, SRC.h], hasAudio: SRC.hasAudio, hasVideo: SRC.hasVideo });
});
server.listen(PORT, "127.0.0.1", () => console.log(`tunr engine on 127.0.0.1:${PORT} source=${SOURCE} dur=${S.dur}`));
idleTimer = setTimeout(() => shutdown(0), 30000);

function report() {
  return {
    t: new Date().toISOString(),
    pos: +clock().toFixed(2),
    sent: stats.sent, decoded: stats.decoded, dropped: stats.dropped, maxQueue: stats.maxQueue,
    syncMeanAbs: stats.syncN ? +(stats.syncSum / stats.syncN).toFixed(3) : null,
    syncMaxAbs: +stats.syncMax.toFixed(3),
    syncMeanSigned: stats.syncN ? +(stats.syncSigned / stats.syncN).toFixed(3) : null,
    audioLatencyMs: audioLatency,
  };
}
if (LOG) setInterval(() => { try { fs.appendFileSync(LOG, JSON.stringify(report()) + "\n"); } catch {} }, 1000);
setInterval(() => { if (S.playing) sendStatus(); }, 250);

function shutdown(code) {
  stopAudio();
  stopVideo();
  try { server.close(); } catch {}
  try { client?.destroy(); } catch {}
  setTimeout(() => process.exit(code), 50);
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));
process.on("exit", () => { kill(audio?.proc); kill(video?.proc); });
