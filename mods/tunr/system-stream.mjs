import { StringDecoder } from "node:string_decoder";
import { parseMediaLine } from "./media.mjs";

export const FRAME_MAGIC = 0x54; // 'T'
export const TAG_RATE = 0x52;    // 'R'
export const TAG_PCM = 0x50;     // 'P'
export const TAG_MEDIA = 0x4d;   // 'M'
export const FRAME_HEADER_SIZE = 6;
const MAX_FRAME_LEN = 16 * 1024 * 1024;

/**
 * 封裝一個系統音訊分框（[0x54 'T'][tag][uint32LE length][payload]），供測試與傳輸驗證。
 * @param {number} tag
 * @param {Uint8Array | Buffer | string} payload
 * @returns {Buffer}
 */
export function encodeSystemFrame(tag, payload) {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload ?? []);
  const hdr = Buffer.allocUnsafe(FRAME_HEADER_SIZE);
  hdr[0] = FRAME_MAGIC;
  hdr[1] = tag;
  hdr.writeUInt32LE(body.length, 2);
  return Buffer.concat([hdr, body]);
}

/**
 * 建立合併後 system.ps1 輸出的串流解析器：
 * - 處理標頭跨 chunk 切斷、PCM 與 JSON 混在同一個 chunk、以及 JSON 行跨幀切斷或含非 ASCII UTF-8 的情況。
 * @returns {{ push: (chunk: Uint8Array | Buffer) => Array<{ type: "rate", sampleRate: number } | { type: "pcm", data: Buffer } | { type: "media", media: ReturnType<typeof parseMediaLine> }> }}
 */
export function createSystemStreamParser() {
  let pending = Buffer.alloc(0);
  let mediaLineBuf = "";
  const utf8Decoder = new StringDecoder("utf8");

  function emitMediaText(text, out) {
    if (!text) return;
    if (!mediaLineBuf && !text.includes("\n") && !text.includes("\r")) {
      const direct = parseMediaLine(text);
      if (direct) {
        out.push({ type: "media", media: direct });
        return;
      }
      // 未結尾也沒有換行且不完整：視為被切斷的 JSON 行，先暫存
      mediaLineBuf += text;
      return;
    }

    mediaLineBuf += text;
    let idx;
    while ((idx = mediaLineBuf.indexOf("\n")) >= 0) {
      const line = mediaLineBuf.slice(0, idx);
      mediaLineBuf = mediaLineBuf.slice(idx + 1);
      const parsed = parseMediaLine(line);
      if (parsed) out.push({ type: "media", media: parsed });
    }
    if (mediaLineBuf) {
      const maybeComplete = parseMediaLine(mediaLineBuf);
      if (maybeComplete) {
        mediaLineBuf = "";
        out.push({ type: "media", media: maybeComplete });
      }
    }
  }

  return {
    push(chunk) {
      if (!chunk || chunk.length === 0) return [];
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const buf = pending.length > 0 ? Buffer.concat([pending, incoming]) : incoming;
      const out = [];
      let offset = 0;

      while (offset + FRAME_HEADER_SIZE <= buf.length) {
        const magic = buf[offset];
        const tag = buf[offset + 1];
        const len = buf.readUInt32LE(offset + 2);

        if (
          magic !== FRAME_MAGIC ||
          (tag !== TAG_RATE && tag !== TAG_PCM && tag !== TAG_MEDIA) ||
          len > MAX_FRAME_LEN
        ) {
          // 若前端出現非分框位元組，向後掃描下一個有效分框標頭
          offset += 1;
          continue;
        }

        if (offset + FRAME_HEADER_SIZE + len > buf.length) break;

        const payload = buf.subarray(offset + FRAME_HEADER_SIZE, offset + FRAME_HEADER_SIZE + len);
        offset += FRAME_HEADER_SIZE + len;

        if (tag === TAG_RATE) {
          const rate = Number(payload.toString("ascii").trim());
          if (Number.isFinite(rate) && rate > 0) {
            out.push({ type: "rate", sampleRate: Math.round(rate) });
          }
        } else if (tag === TAG_PCM) {
          if (payload.length > 0) {
            out.push({ type: "pcm", data: Buffer.from(payload) });
          }
        } else if (tag === TAG_MEDIA) {
          emitMediaText(utf8Decoder.write(payload), out);
        }
      }

      pending = offset < buf.length ? Buffer.from(buf.subarray(offset)) : Buffer.alloc(0);
      return out;
    },
  };
}
