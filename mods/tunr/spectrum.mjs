// Audio spectrum analyzer: FFT, logarithmic frequency bands, and ASCII rendering.
// Pure JavaScript, zero external dependencies.

export const FFT_SIZE = 2048;

export function createFFT(size = FFT_SIZE) {
  const bits = Math.round(Math.log2(size));
  const bitRev = new Uint16Array(size);
  for (let i = 0; i < size; i++) {
    let rev = 0;
    let val = i;
    for (let b = 0; b < bits; b++) {
      rev = (rev << 1) | (val & 1);
      val >>= 1;
    }
    bitRev[i] = rev;
  }
  const cosTable = new Float32Array(size / 2);
  const sinTable = new Float32Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    cosTable[i] = Math.cos(-2 * Math.PI * i / size);
    sinTable[i] = Math.sin(-2 * Math.PI * i / size);
  }
  const hannWindow = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    hannWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }

  return {
    size,
    window: hannWindow,
    transform(real, imag) {
      for (let i = 0; i < size; i++) {
        const j = bitRev[i];
        if (j > i) {
          let t = real[i]; real[i] = real[j]; real[j] = t;
          t = imag[i]; imag[i] = imag[j]; imag[j] = t;
        }
      }
      for (let s = 2; s <= size; s *= 2) {
        const half = s / 2;
        const step = size / s;
        for (let i = 0; i < size; i += s) {
          for (let j = 0; j < half; j++) {
            const k = j * step;
            const c = cosTable[k];
            const sn = sinTable[k];
            const re = real[i + j + half] * c - imag[i + j + half] * sn;
            const im = real[i + j + half] * sn + imag[i + j + half] * c;
            real[i + j + half] = real[i + j] - re;
            imag[i + j + half] = imag[i + j] - im;
            real[i + j] += re;
            imag[i + j] += im;
          }
        }
      }
    }
  };
}

export function getBandBins(cols, sampleRate, fftSize = FFT_SIZE, minFreq = 40, maxFreq = 16000) {
  const bands = [];
  const binFreq = sampleRate / fftSize;
  const maxBin = Math.floor(fftSize / 2);
  const logMin = Math.log10(minFreq);
  const logMax = Math.log10(maxFreq);

  for (let c = 0; c < cols; c++) {
    const fLow = Math.pow(10, logMin + (logMax - logMin) * (c / cols));
    const fHigh = Math.pow(10, logMin + (logMax - logMin) * ((c + 1) / cols));
    let binStart = Math.floor(fLow / binFreq);
    let binEnd = Math.ceil(fHigh / binFreq);
    if (binStart < 1) binStart = 1;
    if (binEnd <= binStart) binEnd = binStart + 1;
    if (binEnd > maxBin) binEnd = maxBin;
    bands.push({ col: c, binStart, binEnd, fLow, fHigh, centerFreq: Math.sqrt(fLow * fHigh) });
  }
  return bands;
}

export function renderAsciiFrame(heights, cols, rows, mode = "mono") {
  const rowColors = [];
  for (let y = 0; y < rows; y++) {
    const fraction = (rows - 1 - y) / Math.max(1, rows - 1);
    if (fraction < 0.35) rowColors[y] = 3;      // green
    else if (fraction < 0.65) rowColors[y] = 2; // yellow
    else if (fraction < 0.85) rowColors[y] = 1; // red
    else rowColors[y] = 6;                      // magenta
  }

  const isSilent = !heights.some((h) => h > 0.05);
  const lines = [];

  for (let y = 0; y < rows; y++) {
    const d = rows - 1 - y;
    let rowText = "";
    for (let c = 0; c < cols; c++) {
      const h = heights[c];
      if (h <= 0.05) {
        rowText += d === 0 ? "-" : " ";
      } else {
        const floorH = Math.floor(h);
        if (d < floorH) {
          rowText += "#";
        } else if (d === floorH) {
          const frac = h - floorH;
          if (frac > 0.6) rowText += "=";
          else if (frac > 0.3) rowText += "-";
          else rowText += ".";
        } else {
          rowText += " ";
        }
      }
    }

    if (mode === "mono") {
      lines.push(rowText);
    } else {
      const colIdx = d === 0 && isSilent ? 0 : rowColors[y];
      lines.push(`${colIdx}${rowText}`);
    }
  }

  return lines.join("\n");
}

export class SpectrumAnalyzer {
  constructor(sampleRate = 48000, cols = 48, rows = 16, minFreq = 40, maxFreq = 16000) {
    this.sampleRate = sampleRate;
    this.cols = cols;
    this.rows = rows;
    this.fft = createFFT(FFT_SIZE);
    this.bands = getBandBins(cols, sampleRate, FFT_SIZE, minFreq, maxFreq);
    this.ring = new Float32Array(FFT_SIZE * 4);
    this.ringPos = 0;
    this.totalSamples = 0;
    this.real = new Float32Array(FFT_SIZE);
    this.imag = new Float32Array(FFT_SIZE);
    this.heights = new Float32Array(cols);
    this.prevHeights = new Float32Array(cols);
    this.minDB = -60;
    this.maxDB = -6;
    this.pcmRemainder = null;
  }

  setDimensions(cols, rows) {
    if (this.cols === cols && this.rows === rows) return;
    this.cols = cols;
    this.rows = rows;
    this.bands = getBandBins(cols, this.sampleRate, FFT_SIZE);
    this.heights = new Float32Array(cols);
    this.prevHeights = new Float32Array(cols);
  }

  setSampleRate(rate) {
    if (this.sampleRate === rate) return;
    this.sampleRate = rate;
    this.bands = getBandBins(this.cols, rate, FFT_SIZE);
  }

  pushPCM16(buf) {
    if (this.pcmRemainder !== null) {
      buf = Buffer.concat([Buffer.from([this.pcmRemainder]), buf]);
      this.pcmRemainder = null;
    }
    const numSamples = Math.floor(buf.length / 2);
    if (buf.length % 2 !== 0) {
      this.pcmRemainder = buf[buf.length - 1];
    }
    const ringLen = this.ring.length;
    let pos = this.ringPos;
    for (let i = 0; i < numSamples; i++) {
      const s = buf.readInt16LE(i * 2);
      this.ring[pos] = s / 32768;
      pos = (pos + 1) % ringLen;
    }
    this.ringPos = pos;
    this.totalSamples += numSamples;
  }

  computeHeights() {
    const size = FFT_SIZE;
    const ringLen = this.ring.length;
    let rms = 0;

    for (let i = 0; i < size; i++) {
      const idx = (this.ringPos - size + i + ringLen) % ringLen;
      const val = this.ring[idx];
      rms += val * val;
      this.real[i] = val * this.fft.window[i];
      this.imag[i] = 0;
    }
    rms = Math.sqrt(rms / size);

    if (rms < 0.001) {
      this.heights.fill(0);
      this.prevHeights.fill(0);
      return this.heights;
    }

    this.fft.transform(this.real, this.imag);

    const mags = new Float32Array(size / 2);
    const scale = 2 / size;
    for (let i = 0; i < size / 2; i++) {
      mags[i] = Math.sqrt(this.real[i] * this.real[i] + this.imag[i] * this.imag[i]) * scale;
    }

    for (let c = 0; c < this.cols; c++) {
      const { binStart, binEnd } = this.bands[c];
      let maxVal = 0;
      for (let b = binStart; b < binEnd; b++) {
        if (mags[b] > maxVal) maxVal = mags[b];
      }
      const dB = 20 * Math.log10(maxVal + 1e-6);
      let norm = (dB - this.minDB) / (this.maxDB - this.minDB);
      if (norm < 0) norm = 0;
      if (norm > 1) norm = 1;

      let targetH = norm * this.rows;
      // Smooth decay
      const smoothed = Math.max(targetH, this.prevHeights[c] * 0.82);
      this.heights[c] = smoothed < 0.1 ? 0 : smoothed;
      this.prevHeights[c] = this.heights[c];
    }

    return this.heights;
  }

  getPeakBand() {
    this.computeHeights();
    let maxH = -1;
    let peakCol = -1;
    for (let c = 0; c < this.cols; c++) {
      if (this.heights[c] > maxH) {
        maxH = this.heights[c];
        peakCol = c;
      }
    }
    return { band: peakCol, height: maxH, info: this.bands[peakCol] };
  }

  render(mode = "mono") {
    this.computeHeights();
    return renderAsciiFrame(this.heights, this.cols, this.rows, mode);
  }
}
