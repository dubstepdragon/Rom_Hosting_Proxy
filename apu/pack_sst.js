// Packs the SingleStepTests SPC700 suite into the binary layout of Shaders/SnesSpcTest.shader for the GPU test
// (Editor/SnesApuTest.cs). Writes <out>/sst_in.bin and <out>/sst_expect.bin, 64 bytes (16 texels) per case.
// Expected cycles are 0xFF ("don't care") for SLEEP/STOP. Usage: node apu/pack_sst.js <dir with 00.json..ff.json> <out dir>
'use strict';
const fs = require('fs');
const path = require('path');

const dir = process.argv[2], outDir = process.argv[3];
const MAXRAM = 14;
const inBufs = [], expBufs = [];
let total = 0, skipped = 0;
for (let op = 0; op < 256; op++) {
  const tests = JSON.parse(fs.readFileSync(path.join(dir, op.toString(16).padStart(2, '0') + '.json'), 'utf8'));
  for (const t of tests) {
    const addrs = [];
    const init = new Map(t.initial.ram.map(([a, v]) => [a, v]));
    for (const [a] of t.initial.ram) if (!addrs.includes(a)) addrs.push(a);
    for (const [a] of t.final.ram) if (!addrs.includes(a)) addrs.push(a);
    if (addrs.length > MAXRAM) { skipped++; continue; }
    const fin = new Map(t.final.ram.map(([a, v]) => [a, v]));
    const ib = Buffer.alloc(64), eb = Buffer.alloc(64);
    const i0 = t.initial, f0 = t.final;
    ib.set([i0.pc & 0xFF, i0.pc >> 8, i0.a, i0.x, i0.y, i0.sp, i0.psw, addrs.length], 0);
    eb.set([f0.pc & 0xFF, f0.pc >> 8, f0.a, f0.x, f0.y, f0.sp, f0.psw, op === 0xEF || op === 0xFF ? 0xFF : t.cycles.length], 0);
    addrs.forEach((a, k) => {
      ib.set([a & 0xFF, a >> 8, init.get(a) ?? 0, 0], 8 + k * 4);
      eb[8 + k * 4] = fin.has(a) ? fin.get(a) : (init.get(a) ?? 0);
    });
    inBufs.push(ib); expBufs.push(eb); total++;
  }
}
// Pad to a whole row of 64 cases (padding cases are NOPs at $0000 with NOP expectations).
while (total % 64) {
  const ib = Buffer.alloc(64), eb = Buffer.alloc(64);
  ib.set([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0x00, 0], 0);
  eb.set([1, 0, 0, 0, 0, 0, 0, 2, 0], 0);
  inBufs.push(ib); expBufs.push(eb); total++;
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'sst_in.bin'), Buffer.concat(inBufs));
fs.writeFileSync(path.join(outDir, 'sst_expect.bin'), Buffer.concat(expBufs));
console.log(`packed ${total} cases (${skipped} skipped: more than ${MAXRAM} addresses)`);
