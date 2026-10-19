// Builds test/snesapu.sfc + .png: a LoROM homebrew that boots the sound CPU the way games do. It waits for
// the IPL ROM's $AA/$BB, uploads the DSP test program from apu/test/dsptest.spc ($0200-$11FF) through the
// $2140-3 handshake, starts it, then idles on NMI. WRAM $0100 = $5A when the upload finished, $0101-2 = NMI
// count at that moment, $0200-1 = NMI count. Used by Editor/SnesApuTest.cs (full-system audio check).
// Usage: node apu/make_apu_test_rom.js [dsptest.spc]
'use strict';
const fs = require('fs');
const path = require('path');
const { parseRom, encodePng } = require('../rom-proxy/romimage');

const spcPath = process.argv[2] || path.join(__dirname, 'test', 'dsptest.spc');
const spc = fs.readFileSync(spcPath);
const UP_START = 0x0200, UP_END = 0x1200;
const upload = spc.subarray(0x100 + UP_START, 0x100 + UP_END);
const LEN = upload.length;

const rom = Buffer.alloc(0x8000, 0xFF);
let pc = 0;
const labels = {}, fixups = [];
const addr = () => 0x8000 + pc;
const b = (...xs) => { for (const x of xs) rom[pc++] = x & 0xFF; };
const w = (v) => b(v, v >> 8);
const label = (n) => { labels[n] = addr(); };
const rel = (op, n) => { b(op, 0); fixups.push({ at: pc - 1, n, kind: 'rel' }); };
const abs = (op, n) => { b(op, 0, 0); fixups.push({ at: pc - 2, n, kind: 'abs' }); };

label('reset');
b(0x78, 0x18, 0xFB);                    // sei ; clc ; xce
b(0xC2, 0x30, 0xA2); w(0x1FFF); b(0x9A);// rep #$30 ; ldx #$1FFF ; txs
b(0xE2, 0x20);                          // sep #$20  (A 8-bit, X/Y 16-bit)
b(0xA9, 0x80, 0x8D); w(0x2100);         // forced blank
b(0x9C); w(0x4200);                     // stz $4200
// Count frames during the upload too (NMI on, no auto-joypad needed)
b(0xA9, 0x80, 0x8D); w(0x4200);
// Wait for the IPL ROM
label('w1'); b(0xAD); w(0x2140); b(0xC9, 0xAA); rel(0xD0, 'w1');
label('w2'); b(0xAD); w(0x2141); b(0xC9, 0xBB); rel(0xD0, 'w2');
b(0xA2); w(UP_START); b(0x8E); w(0x2142);   // destination
b(0xA9, 0x01, 0x8D); w(0x2141);             // transfer follows
b(0xA9, 0xCC, 0x8D); w(0x2140);
label('w3'); b(0xCD); w(0x2140); rel(0xD0, 'w3');
b(0xA2); w(0x0000);                          // ldx #0
label('byte');
abs(0xBD, 'data');                           // lda data,x
b(0x8D); w(0x2141);
b(0x8A, 0x8D); w(0x2140);                    // txa ; sta $2140   (index low byte)
label('w4'); b(0xCD); w(0x2140); rel(0xD0, 'w4');
b(0xE8, 0xE0); w(LEN); rel(0xD0, 'byte');    // inx ; cpx #LEN ; bne byte
// Start the program: port1 = 0, ports 2/3 = entry, port0 = last index + 2
b(0xA2); w(UP_START); b(0x8E); w(0x2142);
b(0x9C); w(0x2141);
const kick = ((LEN - 1 + 2) & 0xFF) || 1;
b(0xA9, kick, 0x8D); w(0x2140);
label('w5'); b(0xCD); w(0x2140); rel(0xD0, 'w5');
b(0xAD); w(0x0200); b(0x8D); w(0x0101);      // NMI count when the upload finished
b(0xAD); w(0x0201); b(0x8D); w(0x0102);
b(0xA9, 0x5A, 0x8D); w(0x0100);
label('main');
b(0xCB); rel(0x80, 'main');                  // wai ; bra main

label('nmi');
b(0xC2, 0x20, 0x48, 0xEE); w(0x0200);        // rep #$20 ; pha ; inc $0200
b(0xE2, 0x20, 0xAD); w(0x4210);              // sep #$20 ; lda $4210
b(0xC2, 0x20, 0x68, 0xE2, 0x20, 0x40);       // rep #$20 ; pla ; sep #$20 ; rti

label('data');
for (const v of upload) b(v);

for (const f of fixups) {
  const t = labels[f.n];
  if (t === undefined) throw new Error('undefined label ' + f.n);
  if (f.kind === 'abs') { rom[f.at] = t & 0xFF; rom[f.at + 1] = t >> 8; }
  else {
    const d = t - (0x8000 + f.at + 1);
    if (d < -128 || d > 127) throw new Error('branch out of range ' + f.n);
    rom[f.at] = d & 0xFF;
  }
}
if (pc > 0x7FB0) throw new Error('code too large');

Buffer.from('GPU SNES APU TEST    ', 'ascii').copy(rom, 0x7FC0);
rom[0x7FD5] = 0x20; rom[0x7FD6] = 0x00; rom[0x7FD7] = 0x08; rom[0x7FD8] = 0x00;
rom[0x7FD9] = 0x01; rom[0x7FDA] = 0x00; rom[0x7FDB] = 0x00;
const vec = (o, v) => { rom[o] = v & 0xFF; rom[o + 1] = v >> 8; };
vec(0x7FEA, labels.nmi); vec(0x7FFC, labels.reset); vec(0x7FFA, labels.nmi);
rom[0x7FDC] = 0; rom[0x7FDD] = 0; rom[0x7FDE] = 0; rom[0x7FDF] = 0;
let sum = 0; for (const v of rom) sum = (sum + v) & 0xFFFF;
sum = (sum + 0x1FE) & 0xFFFF;
vec(0x7FDE, sum); vec(0x7FDC, sum ^ 0xFFFF);

const outDir = path.join(__dirname, '..', 'test');
fs.writeFileSync(path.join(outDir, 'snesapu.sfc'), rom);
fs.writeFileSync(path.join(outDir, 'snesapu.png'), encodePng(parseRom(rom)));
console.log(`wrote ${outDir}/snesapu.sfc/.png (upload ${LEN} bytes, kick $${kick.toString(16)})`);
