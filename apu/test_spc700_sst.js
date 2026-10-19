// Runs the SingleStepTests SPC700 suite (https://github.com/SingleStepTests/spc700, MIT) against the
// reference core. Usage: node apu/test_spc700_sst.js <dir with 00.json..ff.json> [opcode hex]
'use strict';
const fs = require('fs');
const path = require('path');
const { Spc700 } = require('./spc700');

const dir = process.argv[2];
const only = process.argv[3] ? parseInt(process.argv[3], 16) : -1;
let total = 0, failed = 0;
const failOps = {};

for (let op = 0; op < 256; op++) {
  if (only >= 0 && op !== only) continue;
  const file = path.join(dir, op.toString(16).padStart(2, '0') + '.json');
  const tests = JSON.parse(fs.readFileSync(file, 'utf8'));
  let opFails = 0, firstMsg = '';
  for (const t of tests) {
    const mem = new Map(t.initial.ram.map(([a, v]) => [a, v]));
    const bus = {
      read: (a) => (mem.has(a) ? mem.get(a) : 0),
      peek: (a) => (mem.has(a) ? mem.get(a) : 0),
      write: (a, v) => mem.set(a, v),
    };
    const cpu = new Spc700(bus);
    Object.assign(cpu, { pc: t.initial.pc, a: t.initial.a, x: t.initial.x, y: t.initial.y, sp: t.initial.sp, psw: t.initial.psw });
    const cycles = cpu.step();
    const f = t.final;
    const errs = [];
    for (const k of ['pc', 'a', 'x', 'y', 'sp', 'psw'])
      if (cpu[k] !== f[k]) errs.push(`${k}=${cpu[k].toString(16)} want ${f[k].toString(16)}`);
    for (const [a, v] of f.ram) if ((mem.get(a) ?? 0) !== v) errs.push(`[${a.toString(16)}]=${(mem.get(a) ?? 0).toString(16)} want ${v.toString(16)}`);
    if (op !== 0xEF && op !== 0xFF && cycles !== t.cycles.length) errs.push(`cycles=${cycles} want ${t.cycles.length}`);
    total++;
    if (errs.length) {
      failed++; opFails++;
      if (!firstMsg) firstMsg = `${t.name}: ${errs.join(', ')}`;
    }
  }
  if (opFails) { failOps[op.toString(16)] = opFails; console.log(`op ${op.toString(16).padStart(2, '0')}: ${opFails} fails, e.g. ${firstMsg}`); }
}
console.log(`${total - failed}/${total} passed`);
process.exitCode = failed ? 1 : 0;
