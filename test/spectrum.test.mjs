import test from "node:test";
import assert from "node:assert/strict";
import { SpectrumAnalyzer, renderAsciiFrame, getBandBins } from "../mods/tunr/spectrum.mjs";

function generateSinePCM(frequency, sampleRate, numSamples, amplitude = 0.8) {
  const buf = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const val = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude;
    const intVal = Math.max(-32768, Math.min(32767, Math.round(val * 32767)));
    buf.writeInt16LE(intVal, i * 2);
  }
  return buf;
}

test("440 Hz and 3 kHz peaks fall in expected logarithmic frequency bands", () => {
  const sampleRate = 48000;
  const cols = 48;
  const rows = 16;
  const analyzer = new SpectrumAnalyzer(sampleRate, cols, rows);

  // 440 Hz
  const pcm440 = generateSinePCM(440, sampleRate, 4096);
  analyzer.pushPCM16(pcm440);
  analyzer.computeHeights();
  const peak440 = analyzer.getPeakBand();
  assert.equal(peak440.band, 19, "440 Hz peak should be at band 19");
  assert.ok(peak440.height > 8, "440 Hz should have substantial height");

  // Silence reset
  const pcmSilence = Buffer.alloc(4096 * 2);
  analyzer.pushPCM16(pcmSilence);
  analyzer.computeHeights();
  const peakSilence = analyzer.getPeakBand();
  assert.equal(peakSilence.height, 0, "Silence should have 0 height across all bands");

  // 3000 Hz
  const pcm3k = generateSinePCM(3000, sampleRate, 4096);
  analyzer.pushPCM16(pcm3k);
  analyzer.computeHeights();
  const peak3k = analyzer.getPeakBand();
  assert.equal(peak3k.band, 34, "3 kHz peak should be at band 34");
  assert.ok(peak3k.height > 8, "3 kHz should have substantial height");
});

test("silence produces flat line on the bottom row and spaces above", () => {
  const sampleRate = 48000;
  const cols = 48;
  const rows = 16;
  const analyzer = new SpectrumAnalyzer(sampleRate, cols, rows);

  const silence = Buffer.alloc(4096 * 2);
  analyzer.pushPCM16(silence);

  const monoFrame = analyzer.render("mono");
  const monoLines = monoFrame.split("\n");
  assert.equal(monoLines.length, rows, "Frame should have exact rows count");

  for (let y = 0; y < rows - 1; y++) {
    assert.equal(monoLines[y], " ".repeat(cols), `Row ${y} should be spaces`);
  }
  assert.equal(monoLines[rows - 1], "-".repeat(cols), "Bottom row should be a solid flat line of '-'");

  const lowFrame = analyzer.render("low");
  const lowLines = lowFrame.split("\n");
  assert.equal(lowLines.length, rows);
  assert.equal(lowLines[rows - 1], "0" + "-".repeat(cols), "Bottom row in low mode should use color 0 for flat line");
});

test("frame dimensions for small (48x16), medium (64x22), large (80x27)", () => {
  const sampleRate = 48000;
  const sizes = [
    { cols: 48, rows: 16 },
    { cols: 64, rows: 22 },
    { cols: 80, rows: 27 },
  ];

  for (const { cols, rows } of sizes) {
    const analyzer = new SpectrumAnalyzer(sampleRate, cols, rows);
    const pcm = generateSinePCM(1000, sampleRate, 4096);
    analyzer.pushPCM16(pcm);

    const monoFrame = analyzer.render("mono");
    const monoLines = monoFrame.split("\n");
    assert.equal(monoLines.length, rows);
    for (const line of monoLines) {
      assert.equal(line.length, cols);
    }

    const lowFrame = analyzer.render("low");
    const lowLines = lowFrame.split("\n");
    assert.equal(lowLines.length, rows);
    for (const line of lowLines) {
      // In low mode, first char is color digit 0-7, followed by `cols` characters
      assert.equal(line.length, cols + 1);
      assert.ok(/^[0-7]/.test(line));
    }
  }
});

test("computeNormalizedHeightsFromSamples at 22050 Hz peaks in expected bands and avoids dead high bands", () => {
  const sampleRate = 22050;
  const bandCount = 36;
  const analyzer = new SpectrumAnalyzer(sampleRate, bandCount, 16);

  // Confirm even top bands have non-empty bin range under 22050 Hz
  const topBand = analyzer.bands[bandCount - 1];
  assert.ok(topBand.binEnd > topBand.binStart, `top band should not be empty: ${JSON.stringify(topBand)}`);

  // 440 Hz vs 3000 Hz Float32 samples
  const samples440 = new Float32Array(2048);
  const samples3000 = new Float32Array(2048);
  for (let i = 0; i < 2048; i++) {
    samples440[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.8;
    samples3000[i] = Math.sin((2 * Math.PI * 3000 * i) / sampleRate) * 0.8;
  }

  const h440 = analyzer.computeNormalizedHeightsFromSamples(samples440, 0);
  let peakBand440 = 0;
  for (let i = 1; i < h440.length; i++) {
    if (h440[i] > h440[peakBand440]) peakBand440 = i;
  }
  assert.ok(h440[peakBand440] > 0.7);

  analyzer.resetNormalizedHeights();
  const h3000 = analyzer.computeNormalizedHeightsFromSamples(samples3000, 0);
  let peakBand3000 = 0;
  for (let i = 1; i < h3000.length; i++) {
    if (h3000[i] > h3000[peakBand3000]) peakBand3000 = i;
  }
  assert.ok(h3000[peakBand3000] > 0.7);
  assert.ok(peakBand3000 > peakBand440 + 5, `expected 3000Hz (${peakBand3000}) > 440Hz (${peakBand440})`);
});

test("computeNormalizedHeights (ring buffer) and decayNormalizedHeights decay cleanly to 0", () => {
  const sampleRate = 48000;
  const analyzer = new SpectrumAnalyzer(sampleRate, 36, 16);
  analyzer.pushPCM16(generateSinePCM(1000, sampleRate, 4096));
  const h = analyzer.computeNormalizedHeights();
  assert.equal(h.length, 36);
  assert.ok(Math.max(...h) > 0.7);

  let steps = 0;
  let res = { allZero: false };
  while (!res.allZero && steps < 40) {
    res = analyzer.decayNormalizedHeights();
    steps++;
  }
  assert.equal(res.allZero, true);
  assert.ok(res.heights.every((v) => v === 0));
});
