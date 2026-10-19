// Builds apu/test/dsptest.spc: a small SPC700 program that drives the S-DSP through a scripted sequence
// (BRR filters and loops, one-shot samples, ADSR, every GAIN mode, pitch modulation, noise, echo with FIR
// and feedback, KOFF, mute) paced by timer 0. Used to compare the reference APU (apu.js), blargg's
// snes_spc and the GPU core. Usage: node apu/make_test_spc.js [out.spc]
'use strict';
const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------ BRR encoder
// Brute force over shift/filter per block, scored with the hardware decoder so history matches playback.
function decodeOne(nib, shift, filter, p1, p2h) {
  let s = (nib << 28) >> 28;
  if (shift <= 12) s = (s << shift) >> 1; else s &= ~0x7FF;
  if (filter >= 8) {
    s += p1; s -= p2h;
    if (filter === 8) { s += p2h >> 4; s += (p1 * -3) >> 6; } else { s += (p1 * -13) >> 7; s += (p2h * 3) >> 4; }
  } else if (filter) { s += p1 >> 1; s += (-p1) >> 5; }
  s = Math.max(-32768, Math.min(32767, s));
  return ((s * 2) << 16) >> 16;
}

function encodeBrr(pcm, loopBlock) {
  const out = [];
  let h1 = 0, h2 = 0;   // decoded history (as stored in the DSP buffer)
  const blocks = Math.ceil(pcm.length / 16);
  for (let b = 0; b < blocks; b++) {
    let best = null;
    // Filter 0 on the first and loop blocks: the decoder keeps stale history across key-on and loops.
    const maxF = b === 0 || b === loopBlock ? 1 : 4;
    for (let f = 0; f < maxF; f++) {
      for (let sh = 0; sh <= 12; sh++) {
        let p1 = h1, p2 = h2, err = 0;
        const nibs = [];
        for (let k = 0; k < 16; k++) {
          const target = pcm[b * 16 + k] || 0;
          let bestN = 0, bestE = Infinity, bestV = 0;
          for (let n = -8; n < 8; n++) {
            const v = decodeOne(n & 15, sh, f << 2, p1, p2 >> 1);
            const e = Math.abs(v - target);
            if (e < bestE) { bestE = e; bestN = n; bestV = v; }
          }
          nibs.push(bestN & 15); err += bestE * bestE;
          p2 = p1; p1 = bestV;
        }
        if (!best || err < best.err) best = { err, f, sh, nibs, p1, p2 };
      }
    }
    const last = b === blocks - 1;
    let header = (best.sh << 4) | (best.f << 2);
    if (last) header |= loopBlock >= 0 ? 3 : 1;
    out.push(header);
    for (let k = 0; k < 16; k += 2) out.push((best.nibs[k] << 4) | best.nibs[k + 1]);
    h1 = best.p1; h2 = best.p2;
  }
  return out;
}

// ------------------------------------------------------------------ tiny assembler
class Asm {
  constructor(org) { this.org = org; this.bytes = []; this.labels = {}; this.fix = []; }
  get pc() { return this.org + this.bytes.length; }
  label(n) { this.labels[n] = this.pc; }
  b(...v) { this.bytes.push(...v.map((x) => x & 0xFF)); }
  rel(op, lbl, pre = []) { this.b(op, ...pre); this.fix.push({ at: this.bytes.length, lbl, base: this.pc + 1 }); this.b(0); }
  finish() {
    for (const f of this.fix) {
      const d = this.labels[f.lbl] - f.base;
      if (d < -128 || d > 127) throw new Error('branch out of range ' + f.lbl);
      this.bytes[f.at] = d & 0xFF;
    }
    return this.bytes;
  }
}

const ram = new Uint8Array(0x10000);
const put = (addr, data) => data.forEach((v, i) => { ram[addr + i] = v; });

// Samples
const square = []; for (let i = 0; i < 64; i++) square.push((i & 16) ? 11000 : -11000);
const sine = []; for (let i = 0; i < 128; i++) sine.push(Math.round(Math.sin(i * 2 * Math.PI / 64) * 14000));
const drum = []; let seed = 1;
for (let i = 0; i < 512; i++) { seed = (seed * 1103515245 + 12345) >>> 0; drum.push(Math.round(((seed >>> 16) / 32768 - 1) * 20000 * Math.exp(-i / 90))); }
const saw = []; for (let i = 0; i < 96; i++) saw.push(Math.round(((i % 48) / 48 * 2 - 1) * 9000));

const brr = [encodeBrr(square, 0), encodeBrr(sine, 0), encodeBrr(drum, -1), encodeBrr(saw, 2)];
const loopOff = [0, 0, 0, 2 * 9];
let addr = 0x1000;
const dir = [];
brr.forEach((d, i) => { put(addr, d); dir.push(addr, addr + loopOff[i]); addr += d.length; addr = (addr + 15) & ~15; });
dir.forEach((a, i) => { ram[0x0300 + i * 2] = a & 0xFF; ram[0x0301 + i * 2] = a >> 8; });

// Event script: [delay ticks (100 Hz), dsp register, value]
const ev = [];
const at = (delay, ...pairs) => { for (let i = 0; i < pairs.length; i += 2) ev.push(i === 0 ? delay : 0, pairs[i], pairs[i + 1]); };
const V = (v, r) => (v << 4) | r;
at(0, 0x6C, 0x20, 0x0C, 0x60, 0x1C, 0x60, 0x2C, 0x30, 0x3C, 0xD0, 0x5D, 0x03, 0x6D, 0xC0, 0x7D, 0x02, 0x0D, 0x50,
  0x0F, 0x0C, 0x1F, 0x21, 0x2F, 0x2B, 0x3F, 0x2B, 0x4F, 0x13, 0x5F, 0xFE, 0x6F, 0xF3, 0x7F, 0xF9, 0x4D, 0x05);
const voice = (v, voll, volr, pitch, srcn, a1, a2, gain) =>
  [V(v, 0), voll, V(v, 1), volr, V(v, 2), pitch & 0xFF, V(v, 3), pitch >> 8, V(v, 4), srcn, V(v, 5), a1, V(v, 6), a2, V(v, 7), gain];
at(0, ...voice(0, 0x40, 0x20, 0x1000, 0, 0xC3, 0x6A, 0));
at(0, ...voice(1, 0x30, 0x30, 0x0800, 1, 0x00, 0x00, 0x7F));
at(0, ...voice(2, 0x28, 0x38, 0x0C00, 1, 0xFF, 0xE0, 0));
at(0, ...voice(3, 0x18, 0x18, 0x1000, 0, 0xFA, 0x8F, 0));
at(0, ...voice(4, 0x50, 0x50, 0x1000, 2, 0xFF, 0xF0, 0));
at(0, ...voice(5, 0x20, 0x40, 0x3FFF, 3, 0xB4, 0x55, 0));
at(0, ...voice(6, 0x30, 0x10, 0x0123, 0, 0x8F, 0xE0, 0));
at(0, ...voice(7, 0x10, 0x30, 0x0789, 3, 0x00, 0x00, 0xDC));
at(0, 0x2D, 0x04, 0x3D, 0x08, 0x6C, 0x1C);           // PMON voice 2, NON voice 3, FLG noise rate 28, echo on
const scene = process.env.SCENE || 'full';
if (scene === 'kon') at(2, 0x4D, 0x00, 0x4C, 0x02);   // v1 alone, GAIN direct, no echo
else if (scene === 'attack') at(2, 0x4D, 0x00, 0x4C, 0x01);
else if (scene === 'two') { at(2, 0x4C, 0x01); at(10, 0x4C, 0x02); }
else if (scene === 'twonoecho') { at(2, 0x4D, 0x00, 0x4C, 0x01); at(10, 0x4C, 0x02); }
else if (scene === 'konlate') { at(2, 0x4D, 0x00); at(10, 0x4C, 0x02); }
else if (scene === 'v0koff') { at(2, 0x4D, 0x00, 0x4C, 0x01); at(10, 0x5C, 0x01); }
else if (scene === 'echo') { at(2, 0x4D, 0x02, 0x4C, 0x02); at(10, 0x0F, 0x7F, 0x6C, 0x1C); }
else {
at(2, 0x4C, 0x01);                                   // KON v0
at(10, 0x4C, 0x02);                                  // KON v1 (GAIN direct)
at(15, 0x4C, 0x04);                                  // KON v2 (pitch modulated)
at(20, 0x17, 0x9C);                                  // v1 GAIN linear decrease
at(10, 0x4C, 0x08);                                  // KON v3 noise
at(10, 0x5C, 0x01);                                  // KOFF v0
at(3, 0x5C, 0x00, 0x4C, 0x10);                       // KON v4 drum (one shot)
at(12, 0x17, 0xBC, 0x4C, 0x02);                      // v1 GAIN exponential decrease, re-key
at(8, 0x4C, 0x20);                                   // KON v5 saw with mid loop at max pitch
at(9, 0x52, 0x00, 0x53, 0x08);                       // v5 pitch change
at(6, 0x4C, 0xC0);                                   // KON v6 + v7 (GAIN linear increase)
at(10, 0x77, 0xFC, 0x4C, 0x80);                      // v7 GAIN bent increase, re-key
at(10, 0x6C, 0x5C);                                  // mute
at(5, 0x6C, 0x1C, 0x4D, 0x35, 0x0D, 0xA0);           // unmute, more echo voices, negative feedback
at(10, 0x5C, 0xFF);                                  // KOFF all
at(15, 0x5C, 0x00, 0x7D, 0x01, 0x4C, 0x11);          // echo length change, KON v0 + v4
at(20, 0x6C, 0x9C);                                  // soft reset bit
at(5, 0x6C, 0x1C, 0x4C, 0x03);
at(25, 0x5C, 0x03);
}
ev.push(0xFF, 0, 0);
if (ev.length > 0xC00) throw new Error('script too long');
put(0x0400, ev);

// Program at $0200
const a = new Asm(0x0200);
a.b(0x8F, 80, 0xFA);            // MOV $FA,#80     timer 0 = 8 kHz / 80 = 100 Hz
a.b(0x8F, 0x01, 0xF1);          // MOV $F1,#$01    start timer 0 (IPL ROM off)
a.b(0x8F, 0x00, 0x20);          // MOV $20,#$00    script pointer = $0400
a.b(0x8F, 0x04, 0x21);          // MOV $21,#$04
a.label('next');
a.b(0x8D, 0x00);                // MOV Y,#0
a.b(0xF7, 0x20);                // MOV A,[$20]+Y   delay
a.b(0x68, 0xFF);                // CMP A,#$FF
a.rel(0xF0, 'idle');            // BEQ idle
a.b(0xC4, 0x10);                // MOV $10,A
a.b(0x3A, 0x20);                // INCW $20
a.label('wait');
a.b(0xE4, 0x10);                // MOV A,$10
a.rel(0xF0, 'fire');            // BEQ fire
a.label('tick');
a.b(0xEB, 0xFD);                // MOV Y,$FD       read timer 0 output
a.rel(0xF0, 'tick');            // BEQ tick
a.b(0x8B, 0x10);                // DEC $10
a.rel(0x2F, 'wait');            // BRA wait
a.label('fire');
a.b(0x8D, 0x00);                // MOV Y,#0
a.b(0xF7, 0x20);                // MOV A,[$20]+Y
a.b(0xC4, 0xF2);                // MOV $F2,A
a.b(0x3A, 0x20);                // INCW $20
a.b(0xF7, 0x20);                // MOV A,[$20]+Y
a.b(0xC4, 0xF3);                // MOV $F3,A
a.b(0x3A, 0x20);                // INCW $20
a.rel(0x2F, 'next');            // BRA next
a.label('idle');
a.b(0xEB, 0xFD);                // MOV Y,$FD
a.rel(0x2F, 'idle');            // BRA idle
put(0x0200, a.finish());

// SPC file
const spc = new Uint8Array(0x10200);
const sig = 'SNES-SPC700 Sound File Data v0.30';
for (let i = 0; i < sig.length; i++) spc[i] = sig.charCodeAt(i);
spc[0x21] = 26; spc[0x22] = 26; spc[0x23] = 27; spc[0x24] = 30;
spc[0x25] = 0x00; spc[0x26] = 0x02;            // PC
spc[0x27] = 0; spc[0x28] = 0; spc[0x29] = 0; spc[0x2A] = 0x02; spc[0x2B] = 0xEF;
ram[0xF1] = 0x00; ram[0xFA] = 0; ram[0xFD] = 0; ram[0xFE] = 0; ram[0xFF] = 0;
spc.set(ram, 0x100);
spc[0x10100 + 0x6C] = 0xE0;                    // DSP FLG
const out = process.argv[2] || path.join(__dirname, 'test', 'dsptest.spc');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, spc);
console.log('wrote ' + out + ' (' + (ev.length / 3) + ' events, samples up to $' + addr.toString(16) + ')');
