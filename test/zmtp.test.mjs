import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  ZMTP_GREETING_LEN,
  ZMTP_FLAG_MORE,
  ZMTP_FLAG_LONG,
  ZMTP_FLAG_COMMAND,
  buildZmtpGreeting,
  parseZmtpGreeting,
  encodeZmtpFrame,
  decodeZmtpFrames,
  encodeZmtpCommand,
  decodeZmtpCommand,
  encodeReqMessage,
  decodeRepFrames,
  ZmtpReqClient,
  findFreePort,
} from "../mods/tunr/zmtp.mjs";

test("ZMTP greeting 編碼與驗證正確處理 NULL 3.x 與非法標頭", () => {
  const g = buildZmtpGreeting();
  assert.equal(g.length, ZMTP_GREETING_LEN);
  assert.equal(g[0], 0xff);
  assert.equal(g[9], 0x7f);
  assert.equal(g[10], 3);
  assert.equal(g[11], 0);
  assert.deepEqual(parseZmtpGreeting(g), {
    major: 3,
    minor: 0,
    mechanism: "NULL",
    asServer: false,
  });

  const g31 = buildZmtpGreeting({ major: 3, minor: 1, asServer: true });
  assert.deepEqual(parseZmtpGreeting(g31), {
    major: 3,
    minor: 1,
    mechanism: "NULL",
    asServer: true,
  });

  assert.throws(() => parseZmtpGreeting(g.subarray(0, 63)), /incomplete/);
  const badSig = Buffer.from(g);
  badSig[9] = 0x00;
  assert.throws(() => parseZmtpGreeting(badSig), /signature/);
  const oldVer = Buffer.from(g);
  oldVer[10] = 2;
  assert.throws(() => parseZmtpGreeting(oldVer), /major version/);
  const badMech = Buffer.from(g);
  Buffer.from("PLAIN\0\0\0\0", "ascii").copy(badMech, 12);
  assert.throws(() => parseZmtpGreeting(badMech), /mechanism/);
});

test("ZMTP frame 編解碼支援短幀、長幀、旗標與任意切斷重組", () => {
  const f1 = encodeZmtpFrame(Buffer.alloc(0), { more: true });
  assert.deepEqual(f1, Buffer.from([ZMTP_FLAG_MORE, 0]));

  const f2 = encodeZmtpFrame("volume volume 0.35");
  assert.equal(f2[0], 0);
  assert.equal(f2[1], 18);

  const big = "x".repeat(300);
  const f3 = encodeZmtpFrame(big, { command: true });
  assert.equal(f3[0], ZMTP_FLAG_LONG | ZMTP_FLAG_COMMAND);
  assert.equal(Number(f3.readBigUInt64BE(1)), 300);
  assert.equal(f3.length, 9 + 300);

  // 逐位元組切斷後重組解碼
  const combined = Buffer.concat([f1, f2, f3]);
  let pending = Buffer.alloc(0);
  const decoded = [];
  for (let i = 0; i < combined.length; i++) {
    const res = decodeZmtpFrames(Buffer.concat([pending, combined.subarray(i, i + 1)]));
    decoded.push(...res.frames);
    pending = res.remaining;
  }
  assert.equal(pending.length, 0);
  assert.equal(decoded.length, 3);
  assert.equal(decoded[0].more, true);
  assert.equal(decoded[0].payload.length, 0);
  assert.equal(decoded[1].more, false);
  assert.equal(decoded[1].payload.toString("utf8"), "volume volume 0.35");
  assert.equal(decoded[2].command, true);
  assert.equal(decoded[2].long, true);
  assert.equal(decoded[2].payload.toString("utf8"), big);
});

test("ZMTP READY 指令與 REQ/REP 訊息編解碼正確", () => {
  const readyFrame = encodeZmtpCommand("READY", { "Socket-Type": "REQ" });
  const { frames } = decodeZmtpFrames(readyFrame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].command, true);
  const cmd = decodeZmtpCommand(frames[0].payload);
  assert.equal(cmd.name, "READY");
  assert.deepEqual(cmd.properties, { "Socket-Type": "REQ" });

  const reqBytes = encodeReqMessage("volume volume 0.5");
  const parsedReq = decodeZmtpFrames(reqBytes);
  assert.equal(parsedReq.frames.length, 2);
  assert.equal(parsedReq.frames[0].more, true);
  assert.equal(parsedReq.frames[0].payload.length, 0);
  assert.equal(parsedReq.frames[1].more, false);
  assert.equal(parsedReq.frames[1].payload.toString("utf8"), "volume volume 0.5");

  const okRep = decodeRepFrames([Buffer.alloc(0), Buffer.from("0 Error number 0 occurred")]);
  assert.deepEqual(
    { ok: okRep.ok, code: okRep.code, message: okRep.message },
    { ok: true, code: 0, message: "Error number 0 occurred" }
  );

  const errRep = decodeRepFrames([Buffer.alloc(0), Buffer.from("-22 Invalid argument")]);
  assert.deepEqual(
    { ok: errRep.ok, code: errRep.code, message: errRep.message },
    { ok: false, code: -22, message: "Invalid argument" }
  );
});

test("ZmtpReqClient 可完成交握、鎖步送收指令並在對方斷線重聽後自動重連", async () => {
  const port = await findFreePort();
  const receivedCmds = [];
  let connCount = 0;

  const makeServer = () => net.createServer((sock) => {
    connCount++;
    const myConn = connCount;
    let rx = Buffer.alloc(0);
    let greetSent = false;
    let readySent = false;
    let curParts = [];

    // 故意分兩段送出 greeting 測試增量解析
    const g = buildZmtpGreeting({ major: 3, minor: 1, asServer: true });
    sock.write(g.subarray(0, 11));
    setTimeout(() => {
      if (!sock.destroyed) {
        sock.write(g.subarray(11));
        greetSent = true;
      }
    }, 5);

    sock.on("data", (chunk) => {
      rx = Buffer.concat([rx, chunk]);
      if (rx.length >= ZMTP_GREETING_LEN && greetSent && !readySent) {
        rx = Buffer.from(rx.subarray(ZMTP_GREETING_LEN));
        readySent = true;
        sock.write(encodeZmtpCommand("READY", { "Socket-Type": "REP" }));
      }
      if (!readySent) return;
      const { frames, remaining } = decodeZmtpFrames(rx);
      rx = remaining;
      for (const f of frames) {
        if (f.command) continue;
        curParts.push(f.payload);
        if (!f.more) {
          const decoded = decodeRepFrames(curParts);
          curParts = [];
          receivedCmds.push({ conn: myConn, text: decoded.raw });
          // 第一個連線在收到第一筆後正常回覆；若測試要求斷線則在下一次關閉
          sock.write(Buffer.concat([
            encodeZmtpFrame(Buffer.alloc(0), { more: true }),
            encodeZmtpFrame("0 Error number 0 occurred"),
          ]));
          if (decoded.raw === "volume volume 0.4") {
            setTimeout(() => sock.destroy(), 10);
          }
        }
      }
    });
  });

  const srv = makeServer();
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));

  const client = new ZmtpReqClient(port, { connectTimeoutMs: 2000, replyTimeoutMs: 2000 });
  try {
    const r1 = await client.request("volume volume 0.25");
    assert.equal(r1.ok, true);
    assert.equal(r1.code, 0);

    const r2 = await client.request("volume volume 0.4");
    assert.equal(r2.ok, true);

    // 等伺服器端關閉舊 socket，驗證下次送指令會自動重連成功
    await new Promise((r) => setTimeout(r, 40));
    const r3 = await client.request("volume volume 0.8");
    assert.equal(r3.ok, true);
    assert.deepEqual(receivedCmds, [
      { conn: 1, text: "volume volume 0.25" },
      { conn: 1, text: "volume volume 0.4" },
      { conn: 2, text: "volume volume 0.8" },
    ]);
  } finally {
    client.close();
    await new Promise((r) => srv.close(r));
  }
});
