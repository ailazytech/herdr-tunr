/**
 * 計算在指定媒體時間 clockSec 下應取用的 PCM 樣本範圍（不超前聲音）。
 * 樣本索引以 -ss startTime 為 0 起點。
 * @param {{
 *   startTime: number,
 *   sampleRate: number,
 *   bufferStartSample: number,
 *   totalSamples: number,
 *   clockSec: number,
 *   windowSamples: number,
 *   maxBehindSec?: number,
 *   eof?: boolean
 * }} params
 * @returns {{ ready: boolean, sliceStart: number, sliceEnd: number, padLeft: number }}
 */
export function alignPcmWindow({
  startTime,
  sampleRate,
  bufferStartSample,
  totalSamples,
  clockSec,
  windowSamples,
  maxBehindSec = 0.35,
  eof = false,
}) {
  const empty = { ready: false, sliceStart: 0, sliceEnd: 0, padLeft: windowSamples };
  if (!(sampleRate > 0) || !(windowSamples > 0) || !Number.isFinite(clockSec) || !Number.isFinite(startTime)) {
    return empty;
  }
  const elapsed = clockSec - startTime;
  if (elapsed <= 0) return empty;

  const targetEnd = Math.round(elapsed * sampleRate);
  if (targetEnd <= 0) return empty;

  let endSample;
  if (totalSamples >= targetEnd) {
    endSample = targetEnd;
  } else {
    const lagSec = (targetEnd - totalSamples) / sampleRate;
    if (lagSec > maxBehindSec || totalSamples <= bufferStartSample) {
      return empty;
    }
    if (eof && lagSec > 0.1) return empty;
    endSample = totalSamples;
  }

  const wantStart = endSample - windowSamples;
  const sliceStart = Math.max(bufferStartSample, Math.max(0, wantStart));
  const sliceEnd = endSample;
  if (sliceEnd <= sliceStart) return empty;
  const have = sliceEnd - sliceStart;
  const padLeft = Math.max(0, windowSamples - have);
  return { ready: true, sliceStart, sliceEnd, padLeft };
}

/**
 * 計算 PCM 解碼相對於播放時鐘的領先時間與背壓控制旗標。
 * @param {{
 *   startTime: number,
 *   sampleRate: number,
 *   totalSamples: number,
 *   clockSec: number,
 *   maxLeadSec?: number,
 *   resumeLeadSec?: number
 * }} params
 * @returns {{ decodedTime: number, leadSec: number, shouldPause: boolean, shouldResume: boolean }}
 */
export function computeBackpressure({
  startTime,
  sampleRate,
  totalSamples,
  clockSec,
  maxLeadSec = 2.0,
  resumeLeadSec = 1.0,
}) {
  const decodedTime = startTime + (sampleRate > 0 ? totalSamples / sampleRate : 0);
  const leadSec = decodedTime - clockSec;
  return {
    decodedTime,
    leadSec,
    shouldPause: leadSec > maxLeadSec,
    shouldResume: leadSec < resumeLeadSec,
  };
}

/**
 * 以時間戳管理連續 s16le 單聲道 PCM 串流的滑動緩衝區。
 */
export class PcmTimeline {
  /**
   * @param {{ startTime?: number, sampleRate?: number, maxLeadSec?: number, resumeLeadSec?: number, keepBehindSec?: number }} [opts]
   */
  constructor(opts = {}) {
    this.startTime = Number(opts.startTime) || 0;
    this.sampleRate = Number(opts.sampleRate) || 22050;
    this.maxLeadSec = opts.maxLeadSec ?? 2.0;
    this.resumeLeadSec = opts.resumeLeadSec ?? 1.0;
    this.keepBehindSec = opts.keepBehindSec ?? 0.5;
    this.chunks = []; // { startSample: number, samples: Float32Array }
    this.bufferStartSample = 0;
    this.totalSamples = 0;
    this.oddByte = null;
    this.eof = false;
    this.windowBuf = null;
  }

  /**
   * 寫入一段 s16le PCM 位元組。
   * @param {Uint8Array | Buffer} rawChunk
   */
  pushPcm16(rawChunk) {
    if (!rawChunk || rawChunk.length === 0) return;
    let buf = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    if (this.oddByte !== null) {
      buf = Buffer.concat([Buffer.from([this.oddByte]), buf]);
      this.oddByte = null;
    }
    const numSamples = Math.floor(buf.length / 2);
    if (buf.length % 2 !== 0) {
      this.oddByte = buf[buf.length - 1];
    }
    if (numSamples === 0) return;

    const samples = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      samples[i] = buf.readInt16LE(i * 2) / 32768;
    }
    this.chunks.push({ startSample: this.totalSamples, samples });
    this.totalSamples += numSamples;
  }

  /**
   * 丟棄過舊且確定不再需要的 PCM 區塊。
   * @param {number} keepFromSample
   */
  trimBefore(keepFromSample) {
    const floorSample = Math.max(0, Math.floor(keepFromSample));
    while (this.chunks.length > 0) {
      const first = this.chunks[0];
      const firstEnd = first.startSample + first.samples.length;
      if (firstEnd <= floorSample) {
        this.chunks.shift();
        this.bufferStartSample = this.chunks.length > 0 ? this.chunks[0].startSample : this.totalSamples;
      } else {
        break;
      }
    }
  }

  /**
   * 取出對應於 clockSec（不超前聲音）的 windowSamples 長度 Float32Array，並清理過舊樣本。
   * @param {number} clockSec
   * @param {number} [windowSamples=2048]
   * @returns {Float32Array | null}
   */
  getWindowForClock(clockSec, windowSamples = 2048) {
    const aligned = alignPcmWindow({
      startTime: this.startTime,
      sampleRate: this.sampleRate,
      bufferStartSample: this.bufferStartSample,
      totalSamples: this.totalSamples,
      clockSec,
      windowSamples,
      eof: this.eof,
    });

    if (clockSec > this.startTime) {
      const targetSample = Math.round((clockSec - this.startTime) * this.sampleRate);
      const keepBehindSamples = Math.round(this.keepBehindSec * this.sampleRate);
      this.trimBefore(targetSample - windowSamples - keepBehindSamples);
    }

    if (!aligned.ready) return null;

    if (!this.windowBuf || this.windowBuf.length !== windowSamples) {
      this.windowBuf = new Float32Array(windowSamples);
    }
    const out = this.windowBuf;
    if (aligned.padLeft > 0) {
      out.fill(0, 0, aligned.padLeft);
    }

    let writePos = aligned.padLeft;
    let cursor = aligned.sliceStart;
    const end = aligned.sliceEnd;

    for (let i = 0; i < this.chunks.length && cursor < end; i++) {
      const chunk = this.chunks[i];
      const chunkStart = chunk.startSample;
      const chunkEnd = chunkStart + chunk.samples.length;
      if (chunkEnd <= cursor) continue;
      if (chunkStart >= end) break;
      const from = Math.max(0, cursor - chunkStart);
      const to = Math.min(chunk.samples.length, end - chunkStart);
      const len = to - from;
      if (len > 0) {
        out.set(chunk.samples.subarray(from, to), writePos);
        writePos += len;
        cursor += len;
      }
    }

    return out;
  }

  /**
   * 檢查相對於 clockSec 是否需要暫停或恢復讀取解碼器。
   * @param {number} clockSec
   */
  backpressure(clockSec) {
    return computeBackpressure({
      startTime: this.startTime,
      sampleRate: this.sampleRate,
      totalSamples: this.totalSamples,
      clockSec,
      maxLeadSec: this.maxLeadSec,
      resumeLeadSec: this.resumeLeadSec,
    });
  }
}
