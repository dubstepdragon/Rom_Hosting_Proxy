// Renders an .spc with the reference APU (apu.js) and compares it with a raw render from blargg's snes_spc.
// Usage: node apu/compare_oracle.js in.spc oracle.raw [samples] [outdir]
// Writes ref.raw (interleaved int16 stereo, the format the GPU test also produces) and WAVs of both renders.
'use strict';
const fs = require('fs');
const path = require('path');
const { Apu } = require('./apu');

const spcPath = process.argv[2], oraclePath = process.argv[3];
const samples = parseInt(process.argv[4] || '96000', 10);
const outDir = process.argv[5] || path.dirname(oraclePath);

function render(spcBuf, n) {
  const apu = new Apu();
  apu.loadSpc(spcBuf);
  let frame = 0, made = 0;
  while (made < n) {
    const s = frame % 3 === 2 ? 534 : 533;
    apu.runFrame(s);
    made += s; frame++;
  }
  return Int16Array.from(apu.out.slice(0, n * 2));
}

function wav(file, pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length * 2, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(32000, 24);
  h.writeUInt32LE(128000, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
  h.writeUInt32LE(pcm.length * 2, 40);
  fs.writeFileSync(file, Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2)]));
}

const t0 = Date.now();
const ref = render(fs.readFileSync(spcPath), samples);
const ms = Date.now() - t0;
const ob = fs.readFileSync(oraclePath);
const ora = new Int16Array(ob.buffer, ob.byteOffset, Math.min(ob.length >> 1, samples * 2));
fs.writeFileSync(path.join(outDir, 'ref.raw'), Buffer.from(ref.buffer));
wav(path.join(outDir, 'ref.wav'), ref);
wav(path.join(outDir, 'oracle.wav'), ora);

function stats(a, b, lag) {
  let num = 0, ea = 0, eb = 0, diff2 = 0, maxd = 0, n = 0;
  for (let i = Math.max(0, lag); i < samples && i - lag < samples; i++) {
    for (let ch = 0; ch < 2; ch++) {
      const x = a[i * 2 + ch], y = b[(i - lag) * 2 + ch];
      num += x * y; ea += x * x; eb += y * y; diff2 += (x - y) * (x - y);
      maxd = Math.max(maxd, Math.abs(x - y)); n++;
    }
  }
  return { corr: num / Math.sqrt(ea * eb || 1), rmsDiff: Math.sqrt(diff2 / n), rmsRef: Math.sqrt(ea / n), maxd };
}

let best = null;
for (let lag = -64; lag <= 64; lag++) {
  const s = stats(ref, ora, lag);
  if (!best || s.corr > best.corr) best = Object.assign({ lag }, s);
}
let exact = 0;
for (let i = 0; i < samples * 2; i++) if (ref[i] === ora[i]) exact++;
console.log(`reference: ${samples} samples in ${ms} ms`);
console.log(`lag 0: ${JSON.stringify(stats(ref, ora, 0))}`);
console.log(`best lag ${best.lag}: corr ${best.corr.toFixed(5)} rmsDiff ${best.rmsDiff.toFixed(1)} rmsRef ${best.rmsRef.toFixed(1)} maxDiff ${best.maxd}`);
console.log(`identical samples at lag 0: ${(100 * exact / (samples * 2)).toFixed(2)}%`);

// Per 0.25 s windows: where do the two renders disagree most?
const win = 8000;
const rows = [];
for (let w = 0; w * win < samples; w++) {
  let d = 0, e = 0;
  for (let i = w * win; i < Math.min(samples, (w + 1) * win); i++) {
    for (let ch = 0; ch < 2; ch++) {
      const x = ref[i * 2 + ch], y = ora[(i - best.lag) * 2 + ch] || 0;
      d += (x - y) * (x - y); e += y * y;
    }
  }
  rows.push(`${(w * win / 32000).toFixed(2)}s: rel ${(Math.sqrt(d / (e || 1))).toFixed(3)} level ${Math.sqrt(e / win / 2).toFixed(0)}`);
}
console.log(rows.join('\n'));
