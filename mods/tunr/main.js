// tunr：小小的懸浮播放器。影像在背景引擎（tunr.mjs：ffmpeg 轉 ASCII、ffplay 放聲音）裡算好，
// 用本機 TCP 一幀一幀送來，這裡只負責畫（黑白或低彩度）和控制列。可以關畫面只留聲音。
//
// 開法：herdr-app do mod.open --name tunr（或 herdr-quota 狀態列的 tunr 按鈕）。這個實例只是啟動器：它開出真正的懸浮視窗
// （kind window、key tunr、keep：記住位置，App 重開後回來），然後把自己關掉。視窗開著時再 mod.open 一次會關掉視窗。
// 設定放同一個資料夾的 config.json（沒有也行）：
//   { "source": "C:/Videos/a.mp4" | "system", "size": "S|M|L", "mode": "mono|low", "video": true, "volume": 80, "debug": false }
// 把影音檔拖進視窗也能換來源。debug: true 會多一顆 FPS 鈕，並每 2 秒把量到的數字寫到 ~/.config/herdr-app/data/tunr-stats.json。
//
// 指令：herdr-app do tunr.toggle（播放／暫停）、tunr.video、tunr.mode、tunr.size、tunr.system、tunr.close（只到視窗那份）
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, openOverlay, closeOverlay, appHome, hc, shared, setShared, nextCommand, theme, exec } from "herdr";
import { t as translate, language, initLanguage } from "./i18n.js";
import { windowSize, doesFit, nextFitSize, canOpenVideo, bestFitSize, SIZES, SIZE_ORDER, CHAR_W, LINE_H, PAD, CONTROLS_H, AUDIO_ONLY_H } from "./layout.js";
import { mergeConfigText, parseConfigText, resolveStartupConfig } from "./config.js";
import { fps_monitor } from "gpui-fps";
import net from "net";
import { readFile, writeFile } from "fs/promises";

const MOD = "tunr";
const ENGINE_NAME = "tunr-engine";
// 低彩度的 8 個顏色：0 中性、1 紅、2 黃、3 綠、4 青、5 藍、6 洋紅、7 亮中性（飽和度都壓在 0.2–0.3）
const PALETTE = ["#b4b4b4", "#c49a9a", "#c4b896", "#9ec4a0", "#96bcc4", "#9aa4c8", "#c49ac0", "#e2e2e2"];
const MONO_COLOR = "#c8c8c8";
const tr = (key, vars = {}) => translate(key, vars, language(shared));

const dir = () => `${appHome()}/mods/${MOD}`;
const settingsPath = () => `${appHome()}/data/${MOD}/settings.json`;
const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
// 引擎送來的都是 ASCII：自己把位元組轉成文字
const ascii = (u8) => {
  let s = "";
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 8192)));
  return s;
};
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

export default class Tunr extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.isWindow = Boolean(p.window);
    if (!this.isWindow) {
      cx.spawn(async (cx) => {
        try { await this.launch(cx, p); } catch (e) { await writeFile(`${appHome()}/data/tunr-launch-error.txt`, String(e?.stack ?? e)); }
      });
      return;
    }
    this.cfg = p.cfg ?? {};
    this.source = p.source ?? null;
    this.sizeKey = p.size ?? "S";
    this.mode = p.mode ?? "mono";
    this.video = p.video !== false;
    this.volume = p.volume ?? 80;
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
    this.frame = "";
    this.status = { pos: 0, dur: 0, playing: false };
    this.shownSecond = -1;
    this.message = this.source ? "connecting" : "drop";
    this.installCommand = "winget install yt-dlp.yt-dlp";
    this.showUrl = false;
    this.urlInput = null;
    cx.spawn(async () => {
      await initLanguage(shared, setShared, exec);
      try {
        const r = await exec("node", ["-p", "process.platform"]);
        const plat = r.stdout.trim();
        this.platform = plat;
        if (plat === "darwin") this.installCommand = "brew install yt-dlp";
        else if (plat === "linux") this.installCommand = "pipx install yt-dlp";
      } catch {}
      cx.notify();
    });
    this.sock = null;
    this.handoff = false;
    this.closed = false;
    this.pendingFrame = false;
    if (this.debug) {
      const t = now();
      this.st = { t0: t, received: 0, shown: 0, dropped: 0, renders: 0, jsMs: 0, segs: 0, rowsDrawn: 0 };
      this.win = { received: 0, shown: 0, dropped: 0, renders: 0, jsMs: 0, segs: 0, since: t };
    }
    if (this.source) cx.spawn(async (cx) => this.connectEngine(cx, p.resume ?? null));
    cx.spawn(async (cx) => {
      await cx.sleep(50);
      await this.ensureFit(cx);
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (this.closed) return;
        if (c === "toggle") this.send({ cmd: "toggle" });
        if (c === "video") await this.setVideo(cx, !this.video);
        if (c === "mode") this.setMode(cx, !this.mode || this.mode === "mono" ? "low" : "mono");
        if (c === "size") await this.cycleSize(cx);
        if (c === "system") this.loadSource(cx, "system");
        if (c === "close") closeOverlay(props().overlay);
        if (c === "language-auto") setShared("ui.language", "auto");
        if (c === "language-zh") setShared("ui.language", "zh-TW");
        if (c === "language-en") setShared("ui.language", "en");
        cx.notify();
      }
    });
    if (this.debug) cx.timer.every(2000, (cx) => this.dumpStats(cx));
  }

  // ---- 啟動器 ----
  async launch(cx, p) {
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
      mod: MOD, kind: "window", key: "tunr", keep: true, width, height,
      props: {
        window: true, source: cfg.source ?? null, size: sizeKey, mode: cfg.mode === "low" ? "low" : "mono",
        video, volume: cfg.volume ?? 80, debug: Boolean(cfg.debug), cfg,
      },
    };
    const id = openOverlay(spec);
    setShared("tunr.window", id);
    closeOverlay(p.overlay);
  }

  // ---- 引擎 ----
  send(obj) {
    try {
      this.sock?.write(JSON.stringify(obj) + "\n");
    } catch {}
  }

  async startEngine(source) {
    this.port = 30000 + Math.floor(Math.random() * 20000);
    // 前一個沒收乾淨的先收掉（名字不能重複）
    try { await hc(["kill", ENGINE_NAME]); } catch {}
    const r = await hc([
      "run", "--bg", "--no-parent", "--no-notify", "--name", ENGINE_NAME, "--",
      "node", `${dir()}/tunr.mjs`, "--source", source, "--port", String(this.port),
      "--cols", String(SIZES[this.sizeKey].cols), "--rows", String(SIZES[this.sizeKey].rows),
      "--mode", this.mode, "--video", this.video ? "1" : "0", "--volume", String(this.volume),
      "--log", `${appHome()}/data/tunr-engine.jsonl`,
    ]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "hc run failed").trim());
  }

  async connectEngine(cx, resume) {
    try {
      if (this.source === "system") {
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
        if (plat && plat !== "win32") {
          this.message = "windowsOnly";
          cx.notify();
          return;
        }
      }
      if (resume?.port) this.port = resume.port;
      else await this.startEngine(this.source);
      let sock = null;
      for (let i = 0; i < 650 && !this.closed; i++) {
        try {
          sock = await net.connect("127.0.0.1", this.port);
          break;
        } catch {
          await cx.sleep(150);
        }
      }
      if (!sock) throw new Error("connectFailed");
      if (this.closed) { sock.close(); return; }
      this.sock = sock;
      this.message = null;
      cx.notify();
      if (!resume) this.send({ cmd: "play" });
      await this.readLoop(cx, sock);
    } catch (e) {
      this.message = "connectFailed";
      cx.notify();
    }
  }

  async readLoop(cx, sock) {
    let buf = "";
    for (;;) {
      const chunk = await sock.read(1 << 20);
      if (!chunk) break;
      buf += ascii(chunk);
      let i;
      while ((i = buf.indexOf("\f")) >= 0) {
        const msg = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (msg.charCodeAt(0) === 1) this.onStatus(cx, JSON.parse(msg.slice(1)));
        else this.onFrame(msg);
      }
      if (this.pendingFrame && this.video && !this.closed) cx.notify();
    }
    if (sock === this.sock && !this.closed && !this.handoff) {
      this.sock = null;
      this.message = "engineEnded";
      cx.notify();
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
    if (s.error) this.message = s.error;
    // 關畫面時只在畫面上看得到的東西變了才重畫：時間（每秒）、播放狀態等，不然每 250 毫秒一次沒有意義
    const sec = Math.floor(s.pos ?? 0);
    const changed = sec !== this.shownSecond || before.playing !== s.playing || before.video !== s.video || before.mode !== s.mode || before.volume !== s.volume || before.ended !== s.ended || s.hello;
    if (s.hello) {
      this.hello = s;
      // 引擎回報的設定為準（重新連上 handoff 的引擎時）
      this.video = s.video;
      this.mode = s.mode;
      this.volume = s.volume;
    }
    if (changed) {
      this.shownSecond = sec;
      if (!this.video || !s.playing || before.playing !== s.playing) cx.notify();
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
    cx.spawn(async (cx) => {
      await cx.sleep(3000);
      if (this.noticeToken === token && !this.closed) {
        this.notice = null;
        cx.notify();
      }
    });
  }

  scheduleSave(cx) {
    if (!this.isWindow) return;
    this.savePending = true;
    const token = ++this.saveToken;
    cx.spawn(async (cx) => {
      await cx.sleep(500);
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
      mode: this.mode,
      size: this.sizeKey,
      video: this.video,
      ...(this.source ? { source: this.source } : {}),
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
        await writeFile(path, next, "utf8");
      }
    } catch {}
  }

  async ensureFit(cx) {
    if (this.closed || !this.isWindow) return;
    const curPos = await this.getCurrentPos();
    const vp = this.getViewport();
    if (!curPos || !vp) return;
    const currentSize = windowSize(this.sizeKey, this.video);
    if (!doesFit(curPos, currentSize, vp)) {
      const best = bestFitSize(curPos, this.video, vp);
      if (best && best !== this.sizeKey) {
        this.sizeKey = best;
        const { cols, rows } = SIZES[this.sizeKey];
        this.send({ cmd: "size", cols, rows });
        this.scheduleSave(cx);
        await this.resize(cx);
      }
    }
  }

  // ---- 控制 ----
  async setVideo(cx, on) {
    if (on && !this.video) {
      const curPos = await this.getCurrentPos();
      const vp = this.getViewport();
      if (!canOpenVideo(this.sizeKey, curPos, vp)) {
        this.showNotice(cx, tr("noRoom", { size: this.sizeKey }));
        return;
      }
    }
    this.video = on;
    this.send({ cmd: "video", on });
    if (!on) { this.frame = ""; this.pendingFrame = false; }
    this.scheduleSave(cx);
    await this.resize(cx);
  }
  setMode(cx, m) {
    this.mode = m;
    this.send({ cmd: "mode", mode: m });
    this.scheduleSave(cx);
  }
  async cycleSize(cx) {
    const curPos = await this.getCurrentPos();
    const vp = this.getViewport();
    const fit = nextFitSize(this.sizeKey, curPos, this.video, vp);
    if (fit.skipped) {
      this.showNotice(cx, tr("noRoom", { size: fit.skipped }));
    }
    if (fit.changed) {
      this.sizeKey = fit.sizeKey;
      const { cols, rows } = SIZES[this.sizeKey];
      this.send({ cmd: "size", cols, rows });
      this.scheduleSave(cx);
      await this.resize(cx);
    }
  }
  // 同一個 key 再開一次 = 原地換成新大小；引擎留著，新視窗接回同一個埠
  async resize(cx) {
    if (this.savePending) await this.flushConfig();
    const { width, height } = windowSize(this.sizeKey, this.video);
    this.handoff = true;
    const spec = {
      mod: MOD, kind: "window", key: "tunr", keep: true, width, height,
      props: {
        window: true, source: this.source, size: this.sizeKey, mode: this.mode, video: this.video,
        volume: this.volume, debug: this.debug, cfg: this.cfg,
        resume: this.source ? { port: this.port } : null,
        bounds: this.bounds,
      },
    };
    const id = openOverlay(spec);
    setShared("tunr.window", id);
  }
  setVolume(cx, v) {
    this.volume = Math.max(0, Math.min(100, v));
    this.send({ cmd: "volume", value: this.volume });
    this.scheduleSave(cx);
  }
  seekAt(e, cx) {
    const w = e.bounds?.width ?? 0;
    if (!w || !this.status.dur) return;
    const f = Math.max(0, Math.min(1, (e.local_position?.x ?? 0) / w));
    this.send({ cmd: "seek", to: f * this.status.dur });
  }
  async loadSource(cx, path) {
    this.source = path;
    this.frame = "";
    this.message = "connecting";
    this.status = { pos: 0, dur: 0, playing: false };
    this.scheduleSave(cx);
    try { this.send({ cmd: "quit" }); this.sock?.close(); } catch {}
    this.sock = null;
    await this.connectEngine(cx, null);
  }

  async close(cx) {
    this.closed = true;
    if (!this.isWindow) return;
    if (this.handoff) return; // 換大小：引擎留給新視窗
    if (this.savePending) await this.flushConfig();
    try { this.send({ cmd: "quit" }); } catch {}
    try { this.sock?.close(); } catch {}
    try { setShared("tunr.window", null); } catch {}
    await hc(["kill", ENGINE_NAME]).catch(() => {});
  }

  // ---- 量測（debug）----
  async dumpStats(cx) {
    const t = now();
    const w = this.win;
    const secs = (t - w.since) / 1000;
    const out = {
      at: new Date().toISOString(), seconds: +secs.toFixed(2), mode: this.mode, video: this.video, size: this.sizeKey,
      playing: Boolean(this.status.playing), pos: this.status.pos,
      receivedFps: +(w.received / secs).toFixed(1), shownFps: +(w.shown / secs).toFixed(1),
      dropped: w.dropped, droppedPct: w.received ? +((100 * w.dropped) / w.received).toFixed(1) : 0,
      rendersPerSec: +(w.renders / secs).toFixed(2), avgJsMs: +(w.jsMs / Math.max(1, w.renders)).toFixed(3),
      avgTextElementsPerFrame: w.renders ? +(w.segs / w.renders).toFixed(0) : 0,
    };
    this.win = { received: 0, shown: 0, dropped: 0, renders: 0, jsMs: 0, segs: 0, since: t };
    try {
      (this.hist ??= []).push(out);
      if (this.hist.length > 300) this.hist.shift();
      await writeFile(`${appHome()}/data/tunr-stats.json`, JSON.stringify({ latest: out, history: this.hist }, null, 1));
    } catch {}
  }

  // ---- 畫 ----
  btn(id, label, onClick, opts = {}) {
    const t = theme();
    return div()
      .id(id).px(5).py(1).rounded(4).cursor_pointer()
      .text_color(opts.on ? t.foreground : t.muted)
      .when(opts.on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .when(Boolean(opts.tip), (el) => el.tooltip(opts.tip))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { onClick(cx); cx.notify(); })
      .child(label);
  }

  frameRows() {
    const rows = this.frame ? this.frame.split("\n") : [];
    const low = this.mode === "low";
    let segs = 0;
    const out = rows.map((r) => {
      if (!low) { if (this.debug) segs++; return div().whitespace_nowrap().child(r); }
      const parts = r.split("|");
      if (this.debug) segs += parts.length;
      return h_flex().whitespace_nowrap().children(parts.map((s) => div().text_color(PALETTE[s.charCodeAt(0) - 48] ?? MONO_COLOR).child(s.slice(1))));
    });
    if (this.debug) this.lastSegs = segs;
    return out;
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
    const frac = s.dur ? Math.max(0, Math.min(1, (s.pos ?? 0) / s.dur)) : 0;

    const screen = this.video
      ? v_flex()
          .w(cols * CHAR_W).h(rows * LINE_H).items_center().justify_center().overflow_hidden()
          .font_family("JetBrains Mono").text_size(10).line_height(`${LINE_H}px`)
          .text_color(MONO_COLOR)
          .when(Boolean(this.message), (el) => el.child(div().text_color(t.dim).child(tr(this.message, { command: this.installCommand }))))
          .child(v_flex().children(this.frameRows()))
      : null;
    if (this.debug) this.win.segs += this.lastSegs ?? 0;

    const seekBar = div().id("tunr-seek").flex_1().h(8).rounded(3).bg(t.border).cursor_pointer().relative().overflow_hidden()
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.seekAt(e, cx); })
      .child(div().absolute().left(0).top(0).h(8).w(`${(frac * 100).toFixed(2)}%`).bg(t.accent));

    const controls = v_flex().gap(4).px(PAD).py(4).text_size(11).text_color(t.muted).bg(t.chrome)
      .child(
        h_flex().gap(6).items_center()
          .child(this.btn("tunr-play", s.playing ? "⏸" : "▶", () => this.send({ cmd: "toggle" }), { tip: tr(s.playing ? "pause" : "play") }))
          .when(!isSystem, (el) =>
            el
              .child(seekBar)
              .child(div().flex_none().child(`${mmss(s.pos)}/${mmss(s.dur)}`))
          )
          .when(isSystem, (el) =>
            // 關畫面時上方那行已經寫著「電腦的聲音」，這裡留空當間隔
            el.child(div().flex_1().text_color(t.dim).child(this.video ? tr("systemAudio") : ""))
          ),
      )
      .child(
        h_flex().gap(3).items_center().whitespace_nowrap()
          .when(!isSystem, (el) =>
            el
              .child(this.btn("tunr-vol-", "−", (cx) => this.setVolume(cx, this.volume - 10), { tip: tr("volumeDown") }))
              .child(div().w(20).flex_none().text_color(t.foreground).child(`${this.volume}`))
              .child(this.btn("tunr-vol+", "+", (cx) => this.setVolume(cx, this.volume + 10), { tip: tr("volumeUp") }))
          )
          .child(div().flex_1())
          .child(this.btn("tunr-system", "📻", (cx) => {
            if (!isSystem) this.loadSource(cx, "system");
          }, { on: isSystem, tip: tr("systemAudioTip") }))
          .child(this.btn("tunr-url", "🔗", (cx) => {
            this.showUrl = !this.showUrl;
            if (this.showUrl) {
              let text = "";
              try { text = (cx.read_from_clipboard() ?? "").trim(); } catch {}
              const value = /^https?:\/\/[^\s/]+(?:[/?#][^\s]*)?$/i.test(text) ? text : "";
              this.urlInput?.release();
              this.urlInput = InputState.new({ value, placeholder: tr("urlPlaceholder") });
              this.urlInput.on("submit", (_e, inputCx) => { const url = this.urlInput.value().trim(); if (url) { this.showUrl = false; this.loadSource(inputCx, url); inputCx.notify(); } });
              this.urlInput.set_selected_range({ start: 0, end: value.length });
              this.urlInput.focus();
            }
          }, { tip: tr("url") }))
          .child(this.btn("tunr-video", tr("video"), (cx) => this.setVideo(cx, !this.video), { on: this.video, tip: tr("videoHelp") }))
          .child(this.btn("tunr-mode", tr(this.mode === "low" ? "low" : "mono"), (cx) => this.setMode(cx, this.mode === "low" ? "mono" : "low"), { tip: tr("mode") }))
          .child(this.btn("tunr-size", this.sizeKey, (cx) => this.cycleSize(cx), { tip: tr("size") }))
          .when(this.debug, (el) => el.child(this.btn("tunr-fps", "FPS", () => { this.showFps = !this.showFps; }, { on: this.showFps, tip: tr("fps") })))
          .child(this.btn("tunr-close", "✕", () => closeOverlay(props().overlay), { tip: tr("close") })),
      );

    const updateBounds = (e) => {
      const b = e?.bounds;
      if (b && Number.isFinite(b.x) && Number.isFinite(b.y)) {
        this.bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
        this.pos = { x: b.x, y: b.y };
      }
    };

    const root = v_flex().id("tunr-root").relative().size_full().bg("#0b0b0b").overflow_hidden()
      .on_mouse_move((e) => updateBounds(e))
      .on_mouse_down("left", (e) => updateBounds(e))
      .on_mouse_up("left", (e) => updateBounds(e))
      .on_drop((e, cx) => { const f = e.paths?.[0]; if (f) this.loadSource(cx, f); })
      .child(
        this.video
          ? v_flex().flex_1().items_center().justify_center().p(PAD).child(screen)
          : v_flex().h(AUDIO_ONLY_H).px(PAD).justify_center().text_size(10).text_color(t.dim)
              .child(this.notice ? div().text_color(t.accent ?? "#e3814f").child(this.notice) : (this.message ? tr(this.message, { command: this.installCommand }) : (isSystem ? tr("systemAudio") : (this.source ? this.source.split(/[\\/]/).pop() : tr("drop"))))),
      )
      .child(controls)
      .when(Boolean(this.video && this.notice), (el) =>
        el.child(
          div()
            .absolute().top(PAD + 4).left(PAD + 4).right(PAD + 4).px(8).py(3).rounded(4)
            .bg(t.chrome ?? "#1f1f1f").border(1, t.accent ?? "#e3814f")
            .text_size(10).text_color(t.foreground).text_center().whitespace_nowrap().overflow_hidden()
            .child(this.notice)
        )
      )
      .when(this.message === "missingYtDlp", (el) => el.child(div().absolute().bottom(52).left(8).bg(t.chrome).child(this.btn("tunr-copy", tr("copyCommand"), (cx) => { cx.write_to_clipboard(this.installCommand); this.copied = true; }, { tip: tr(this.copied ? "copied" : "copyCommand") }))))
      .when(this.showUrl, (el) => el.child(div().absolute().top(4).left(4).right(4).p(6).bg(t.chrome).child(Input.new(this.urlInput).w_full().text_size(12).text_color(t.foreground))))
      .when(this.debug && this.showFps, (el) => el.child(div().absolute().top(4).right(4).w(150).h(110).child(div().relative().size_full().child(fps_monitor()))));
    if (this.debug) {
      const dt = now() - t0;
      this.st.jsMs += dt;
      this.win.jsMs += dt;
    }
    return root;
  }
}
