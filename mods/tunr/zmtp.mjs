import net from "node:net";

export const ZMTP_GREETING_LEN = 64;
export const ZMTP_SIGNATURE = Buffer.from([0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0x7f]);
export const ZMTP_FLAG_MORE = 0x01;
export const ZMTP_FLAG_LONG = 0x02;
export const ZMTP_FLAG_COMMAND = 0x04;
const MAX_FRAME_LEN = 1024 * 1024;

/**
 * 建構 64 位元組的 ZMTP 3.x NULL 機制 greeting 標頭。
 * @param {{ major?: number, minor?: number, mechanism?: string, asServer?: boolean }} [opts]
 * @returns {Buffer}
 */
export function buildZmtpGreeting({ major = 3, minor = 0, mechanism = "NULL", asServer = false } = {}) {
  const buf = Buffer.alloc(ZMTP_GREETING_LEN, 0);
  ZMTP_SIGNATURE.copy(buf, 0);
  buf[10] = major & 0xff;
  buf[11] = minor & 0xff;
  Buffer.from(String(mechanism), "ascii").subarray(0, 20).copy(buf, 12);
  buf[32] = asServer ? 1 : 0;
  return buf;
}

/**
 * 驗證並解析對方送來的 64 位元組 ZMTP 3.x greeting。
 * @param {Uint8Array | Buffer} buf
 * @returns {{ major: number, minor: number, mechanism: string, asServer: boolean }}
 */
export function parseZmtpGreeting(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  if (b.length < ZMTP_GREETING_LEN) {
    throw new Error(`incomplete ZMTP greeting (${b.length}/${ZMTP_GREETING_LEN})`);
  }
  if (b[0] !== 0xff || b[9] !== 0x7f) {
    throw new Error("invalid ZMTP greeting signature");
  }
  const major = b[10];
  const minor = b[11];
  if (major < 3) {
    throw new Error(`unsupported ZMTP major version: ${major}.${minor}`);
  }
  const mechanism = b.subarray(12, 32).toString("ascii").replace(/\0+$/, "");
  if (mechanism !== "NULL") {
    throw new Error(`unsupported ZMTP security mechanism: ${mechanism || "<empty>"}`);
  }
  return {
    major,
    minor,
    mechanism,
    asServer: b[32] !== 0,
  };
}

/**
 * 編碼單一 ZMTP 3.x frame（短幀 1-byte 長度；>= 256 bytes 使用 8-byte 大端序長度）。
 * @param {Uint8Array | Buffer | string} payload
 * @param {{ more?: boolean, command?: boolean }} [opts]
 * @returns {Buffer}
 */
export function encodeZmtpFrame(payload, { more = false, command = false } = {}) {
  const body = typeof payload === "string"
    ? Buffer.from(payload, "utf8")
    : Buffer.from(payload ?? []);
  let flags = 0;
  if (more) flags |= ZMTP_FLAG_MORE;
  if (command) flags |= ZMTP_FLAG_COMMAND;
  if (body.length <= 255) {
    const out = Buffer.allocUnsafe(2 + body.length);
    out[0] = flags;
    out[1] = body.length;
    body.copy(out, 2);
    return out;
  }
  flags |= ZMTP_FLAG_LONG;
  const out = Buffer.allocUnsafe(9 + body.length);
  out[0] = flags;
  out.writeBigUInt64BE(BigInt(body.length), 1);
  body.copy(out, 9);
  return out;
}

/**
 * 增量解析緩衝區中的 ZMTP 3.x frames，回傳已完整解碼的 frames 與尚未收齊的剩餘位元組。
 * @param {Uint8Array | Buffer} buf
 * @returns {{ frames: Array<{ flags: number, more: boolean, long: boolean, command: boolean, payload: Buffer }>, remaining: Buffer }}
 */
export function decodeZmtpFrames(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  const frames = [];
  let off = 0;
  while (off < b.length) {
    if (off + 2 > b.length) break;
    const flags = b[off];
    if ((flags & 0xf8) !== 0) {
      throw new Error(`invalid ZMTP frame reserved flags: 0x${flags.toString(16)}`);
    }
    const isLong = (flags & ZMTP_FLAG_LONG) !== 0;
    const hdrLen = isLong ? 9 : 2;
    if (off + hdrLen > b.length) break;
    const rawLen = isLong ? b.readBigUInt64BE(off + 1) : BigInt(b[off + 1]);
    if (rawLen > BigInt(MAX_FRAME_LEN)) {
      throw new Error(`ZMTP frame too large: ${rawLen.toString()}`);
    }
    const len = Number(rawLen);
    if (off + hdrLen + len > b.length) break;
    frames.push({
      flags,
      more: (flags & ZMTP_FLAG_MORE) !== 0,
      long: isLong,
      command: (flags & ZMTP_FLAG_COMMAND) !== 0,
      payload: Buffer.from(b.subarray(off + hdrLen, off + hdrLen + len)),
    });
    off += hdrLen + len;
  }
  return {
    frames,
    remaining: off < b.length ? Buffer.from(b.subarray(off)) : Buffer.alloc(0),
  };
}

/**
 * 編碼 ZMTP 3.x 指令 frame（例如 READY + Socket-Type: REQ）。
 * @param {string} name
 * @param {Record<string, string>} [properties]
 * @returns {Buffer}
 */
export function encodeZmtpCommand(name, properties = {}) {
  const nameBuf = Buffer.from(String(name), "ascii");
  if (nameBuf.length === 0 || nameBuf.length > 255) {
    throw new Error(`invalid ZMTP command name length: ${nameBuf.length}`);
  }
  const parts = [Buffer.from([nameBuf.length]), nameBuf];
  for (const [k, v] of Object.entries(properties)) {
    const kBuf = Buffer.from(String(k), "ascii");
    const vBuf = Buffer.from(String(v), "utf8");
    if (kBuf.length === 0 || kBuf.length > 255) {
      throw new Error(`invalid ZMTP property name length: ${kBuf.length}`);
    }
    const hdr = Buffer.allocUnsafe(1 + kBuf.length + 4);
    hdr[0] = kBuf.length;
    kBuf.copy(hdr, 1);
    hdr.writeUInt32BE(vBuf.length, 1 + kBuf.length);
    parts.push(hdr, vBuf);
  }
  return encodeZmtpFrame(Buffer.concat(parts), { command: true });
}

/**
 * 解析 ZMTP 3.x 指令 frame 的 payload（如 READY、ERROR、PING）。
 * @param {Uint8Array | Buffer} payload
 * @returns {{ name: string, properties: Record<string, string>, rawTail: Buffer }}
 */
export function decodeZmtpCommand(payload) {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? []);
  if (b.length < 1) throw new Error("empty ZMTP command payload");
  const nameLen = b[0];
  if (nameLen === 0 || 1 + nameLen > b.length) {
    throw new Error("truncated ZMTP command name");
  }
  const name = b.subarray(1, 1 + nameLen).toString("ascii");
  const properties = {};
  let off = 1 + nameLen;
  if (name === "READY" || name === "INITIATE") {
    while (off < b.length) {
      const kLen = b[off++];
      if (off + kLen + 4 > b.length) break;
      const key = b.subarray(off, off + kLen).toString("ascii");
      off += kLen;
      const vLen = b.readUInt32BE(off);
      off += 4;
      if (off + vLen > b.length) break;
      properties[key] = b.subarray(off, off + vLen).toString("utf8");
      off += vLen;
    }
  }
  return {
    name,
    properties,
    rawTail: off < b.length ? Buffer.from(b.subarray(off)) : Buffer.alloc(0),
  };
}

/**
 * 編碼 REQ 端請求訊息：先送一個空的 MORE 分隔 frame，再送指令 frame（多幀時依序標記 MORE）。
 * @param {string | Uint8Array | Buffer | Array<string | Uint8Array | Buffer>} body
 * @returns {Buffer}
 */
export function encodeReqMessage(body) {
  const items = Array.isArray(body) ? body : [body];
  if (items.length === 0) throw new Error("REQ message requires at least one body frame");
  const encoded = [encodeZmtpFrame(Buffer.alloc(0), { more: true })];
  for (let i = 0; i < items.length; i++) {
    encoded.push(encodeZmtpFrame(items[i], { more: i < items.length - 1 }));
  }
  return Buffer.concat(encoded);
}

/**
 * 解碼 REP 端回覆的 frames：剝除前置空分隔 frame，解析狀態碼與訊息文字。
 * @param {Array<Uint8Array | Buffer>} frames
 * @returns {{ ok: boolean, code: number | null, message: string, raw: string, parts: Buffer[] }}
 */
export function decodeRepFrames(frames) {
  const list = Array.isArray(frames) ? frames.map((f) => (Buffer.isBuffer(f) ? f : Buffer.from(f))) : [];
  const delimIdx = list.findIndex((f) => f.length === 0);
  const parts = delimIdx >= 0 ? list.slice(delimIdx + 1) : list;
  const raw = parts.map((p) => p.toString("utf8")).join("\n");
  const m = /^(-?\d+)\s*(.*)$/s.exec(raw.trim());
  const code = m ? Number(m[1]) : null;
  const message = m ? m[2].trim() : raw.trim();
  return {
    ok: code === 0,
    code,
    message,
    raw,
    parts,
  };
}

/**
 * 基於 Node net 的最小 ZMTP 3.x REQ 用戶端（無外部相依）。
 * 採嚴格 REQ/REP 鎖步佇列、支援斷線時自動重連（例如 ffplay 依裝置格式重建音訊濾鏡圖）。
 */
export class ZmtpReqClient {
  /**
   * @param {number} port
   * @param {{ host?: string, connectTimeoutMs?: number, replyTimeoutMs?: number, retryDelayMs?: number, shouldAbort?: () => boolean }} [opts]
   */
  constructor(port, {
    host = "127.0.0.1",
    connectTimeoutMs = 3000,
    replyTimeoutMs = 3000,
    retryDelayMs = 25,
    shouldAbort = null,
  } = {}) {
    this.port = port;
    this.host = host;
    this.connectTimeoutMs = connectTimeoutMs;
    this.replyTimeoutMs = replyTimeoutMs;
    this.retryDelayMs = retryDelayMs;
    this.shouldAbort = shouldAbort;
    this.sock = null;
    this.rx = Buffer.alloc(0);
    this.greetingDone = false;
    this.readyDone = false;
    this.destroyed = false;
    this.sockClosed = false;
    this.curMsgParts = [];
    this.inFlight = null;
    this.queue = Promise.resolve();
    this.connectPromise = null;
    this.retryTimer = null;
    this.retryWake = null;
  }

  isOpen() {
    return Boolean(this.sock && !this.destroyed && !this.sockClosed && !this.sock.destroyed && this.readyDone);
  }

  /**
   * 連線並完成 ZMTP 3.x greeting + READY 交握；若連不上會重試到逾時或中止。
   * @returns {Promise<void>}
   */
  connect() {
    if (this.destroyed || this.shouldAbort?.()) {
      return Promise.reject(new Error("ZMTP client closed"));
    }
    if (this.isOpen()) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      const deadline = Date.now() + this.connectTimeoutMs;
      let lastErr = new Error("ZMTP connect timeout");
      while (!this.destroyed && !this.shouldAbort?.()) {
        try {
          await this._dialOnce(Math.max(200, deadline - Date.now()));
          return;
        } catch (err) {
          lastErr = err;
          if (this.destroyed || this.shouldAbort?.() || Date.now() >= deadline) break;
          await new Promise((r) => {
            this.retryWake = r;
            this.retryTimer = setTimeout(() => {
              this.retryTimer = null;
              this.retryWake = null;
              r();
            }, this.retryDelayMs);
          });
        }
      }
      throw lastErr;
    })().finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  _dialOnce(timeoutMs) {
    this._dropSocket();
    this.rx = Buffer.alloc(0);
    this.greetingDone = false;
    this.readyDone = false;
    this.sockClosed = false;
    this.curMsgParts = [];

    return new Promise((resolve, reject) => {
      const sock = net.connect(this.port, this.host);
      this.sock = sock;
      let settled = false;
      const timer = setTimeout(() => {
        fail(new Error("ZMTP handshake timeout"));
      }, timeoutMs);

      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.sock === sock) {
          this.sockClosed = true;
          this.sock = null;
        }
        try { sock.destroy(); } catch {}
        reject(err);
      };

      sock.on("error", (err) => {
        if (!settled) fail(err);
      });
      sock.once("connect", () => {
        if (this.destroyed || this.shouldAbort?.()) {
          fail(new Error("ZMTP client closed"));
          return;
        }
        sock.setNoDelay(true);
        sock.write(buildZmtpGreeting());

        sock.on("data", (chunk) => {
          if (this.sock !== sock) return;
          this.rx = Buffer.concat([this.rx, chunk]);
          try {
            if (!this.greetingDone) {
              if (this.rx.length < ZMTP_GREETING_LEN) return;
              parseZmtpGreeting(this.rx.subarray(0, ZMTP_GREETING_LEN));
              this.rx = Buffer.from(this.rx.subarray(ZMTP_GREETING_LEN));
              this.greetingDone = true;
              sock.write(encodeZmtpCommand("READY", { "Socket-Type": "REQ" }));
            }
            const { frames, remaining } = decodeZmtpFrames(this.rx);
            this.rx = remaining;
            for (const f of frames) {
              if (f.command) {
                const cmd = decodeZmtpCommand(f.payload);
                if (cmd.name === "READY" && !this.readyDone) {
                  this.readyDone = true;
                  if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve();
                  }
                } else if (cmd.name === "PING") {
                  try {
                    const ctx = cmd.rawTail.subarray(2);
                    sock.write(encodeZmtpFrame(Buffer.concat([Buffer.from([4]), Buffer.from("PONG", "ascii"), ctx]), { command: true }));
                  } catch {}
                } else if (cmd.name === "ERROR") {
                  throw new Error(`ZMTP peer error: ${cmd.rawTail.toString("utf8")}`);
                }
              } else {
                this.curMsgParts.push(f.payload);
                if (!f.more) {
                  const parts = this.curMsgParts;
                  this.curMsgParts = [];
                  const waiter = this.inFlight;
                  this.inFlight = null;
                  if (waiter) waiter.resolve(decodeRepFrames(parts));
                }
              }
            }
          } catch (err) {
            if (!settled) fail(err);
            else {
              const waiter = this.inFlight;
              this.inFlight = null;
              if (waiter) waiter.reject(err);
              this._dropSocket();
            }
          }
        });

        sock.on("close", () => {
          if (this.sock !== sock) return;
          this.sockClosed = true;
          this.sock = null;
          const err = new Error("ZMTP socket closed");
          if (!settled) fail(err);
          const waiter = this.inFlight;
          this.inFlight = null;
          if (waiter) waiter.reject(err);
        });
      });
    });
  }

  _sendOnce(text) {
    if (!this.isOpen()) {
      return Promise.reject(new Error("ZMTP socket not ready"));
    }
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        if (this.inFlight?.reject === rejectFn) this.inFlight = null;
        this._dropSocket();
        reject(new Error("ZMTP reply timeout"));
      }, this.replyTimeoutMs);

      const resolveFn = (val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(val);
      };
      const rejectFn = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      };

      this.inFlight = { resolve: resolveFn, reject: rejectFn };
      try {
        this.sock.write(encodeReqMessage(text));
      } catch (err) {
        this.inFlight = null;
        rejectFn(err);
      }
    });
  }

  /**
   * 序列化送出 REQ 指令並等待 REP 回覆；若連線恰好被關閉會重連再試一次。
   * @param {string} text
   * @returns {Promise<ReturnType<typeof decodeRepFrames>>}
   */
  request(text) {
    if (this.destroyed || this.shouldAbort?.()) {
      return Promise.reject(new Error("ZMTP client closed"));
    }
    const run = async () => {
      if (this.destroyed || this.shouldAbort?.()) {
        throw new Error("ZMTP client closed");
      }
      if (!this.isOpen()) {
        await this.connect();
      }
      try {
        return await this._sendOnce(text);
      } catch (err) {
        if (this.destroyed || this.shouldAbort?.()) throw err;
        // 若 ffplay 重建音訊濾鏡圖導致連線重設，自動重連重送一次
        this._dropSocket();
        await this.connect();
        return await this._sendOnce(text);
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  _dropSocket() {
    this.readyDone = false;
    this.sockClosed = true;
    if (this.inFlight) {
      const waiter = this.inFlight;
      this.inFlight = null;
      waiter.reject(new Error("ZMTP socket reset"));
    }
    if (this.sock) {
      const s = this.sock;
      this.sock = null;
      try { s.destroy(); } catch {}
    }
  }

  /**
   * 立即關閉 TCP 連線並取消所有等待中的請求。
   */
  close() {
    this.destroyed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.retryWake) {
      const wake = this.retryWake;
      this.retryWake = null;
      wake();
    }
    this._dropSocket();
  }
}

/**
 * 向作業系統申請一個目前無人使用的本機臨時 TCP 埠（127.0.0.1）。
 * @returns {Promise<number>}
 */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else if (!port) reject(new Error("failed to allocate free port"));
        else resolve(port);
      });
    });
  });
}
