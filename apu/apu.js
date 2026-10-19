// Reference model of the whole sound unit (SPC700 + I/O + timers + IPL ROM + S-DSP) used to check the
// GPU version (Assets/SNES/Shaders/SnesApu.cginc). It follows the shader step for step: the DSP makes one
// stereo sample every 32 SPC cycles, run after the instruction that crosses the boundary, and timers tick
// after each instruction. The DSP is per sample (blargg's fast DSP structure) with the arithmetic of
// blargg's accurate DSP (gaussian rounding, per-voice clamping, single rate counter).
'use strict';
const { Spc700 } = require('./spc700');

const IPL = [
  0xCD, 0xEF, 0xBD, 0xE8, 0x00, 0xC6, 0x1D, 0xD0, 0xFC, 0x8F, 0xAA, 0xF4, 0x8F, 0xBB, 0xF5, 0x78,
  0xCC, 0xF4, 0xD0, 0xFB, 0x2F, 0x19, 0xEB, 0xF4, 0xD0, 0xFC, 0x7E, 0xF4, 0xD0, 0x0B, 0xE4, 0xF5,
  0xCB, 0xF4, 0xD7, 0x00, 0xFC, 0xD0, 0xF3, 0xAB, 0x01, 0x10, 0xEF, 0x7E, 0xF4, 0x10, 0xEB, 0xBA,
  0xF6, 0xDA, 0x00, 0xBA, 0xF4, 0xC4, 0xF4, 0xDD, 0x5D, 0xD0, 0xDB, 0x1F, 0x00, 0x00, 0xC0, 0xFF,
];

const GAUSS = require('./gauss');

const COUNTER_RANGE = 2048 * 5 * 3;
const COUNTER_RATES = [COUNTER_RANGE + 1, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80,
  64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1];
const COUNTER_OFFSETS = [1, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536,
  0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 0, 0];

// DSP register numbers
const R = { MVOLL: 0x0C, MVOLR: 0x1C, EVOLL: 0x2C, EVOLR: 0x3C, KON: 0x4C, KOFF: 0x5C, FLG: 0x6C, ENDX: 0x7C,
  EFB: 0x0D, PMON: 0x2D, NON: 0x3D, EON: 0x4D, DIR: 0x5D, ESA: 0x6D, EDL: 0x7D };
const ENV_RELEASE = 0, ENV_ATTACK = 1, ENV_DECAY = 2, ENV_SUSTAIN = 3;

const s8 = (v) => (v << 24) >> 24;
const s16 = (v) => (v << 16) >> 16;
const clamp16 = (v) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);

class Voice {
  constructor() {
    this.brrAddr = 0; this.brrOffset = 1; this.bufPos = 0; this.interpPos = 0;
    this.env = 0; this.hiddenEnv = 0; this.envMode = ENV_RELEASE; this.konDelay = 0;
    this.buf = new Int32Array(12);
  }
}

class Apu {
  constructor() {
    this.ram = new Uint8Array(0x10000);
    this.dsp = new Uint8Array(128);
    this.voices = []; for (let i = 0; i < 8; i++) this.voices.push(new Voice());
    this.cpu = new Spc700({ read: (a) => this.read(a), peek: (a) => this.peek(a), write: (a, v) => this.write(a, v) });
    this.reset();
  }

  reset() {
    const c = this.cpu;
    c.pc = 0xFFC0; c.a = 0; c.x = 0; c.y = 0; c.sp = 0; c.psw = 0; c.stopped = false;
    this.portIn = [0, 0, 0, 0];   // CPU -> APU ($2140-3 writes, read at $F4-7)
    this.portOut = [0, 0, 0, 0];  // APU -> CPU ($F4-7 writes)
    this.control = 0xB0; this.dspAddr = 0; this.f8 = 0; this.f9 = 0;
    this.tTarget = [0, 0, 0]; this.tDiv = [0, 0, 0]; this.tOut = [0x0F, 0x0F, 0x0F];
    this.clock = 0;               // total SPC cycles (mod 2^32)
    this.apuCyc = 0;              // cycles in the current frame
    this.dspNext = 32;            // cycle (in this frame) at which the next sample is due
    this.dsp.fill(0); this.dsp[R.FLG] = 0xE0;
    this.noise = 0x4000; this.counter = 0; this.echoOffset = 0; this.echoLength = 0;
    this.everyOther = 1; this.kon = 0; this.newKon = 0; this.tKoff = 0; this.tEsa = 0;
    this.echoHistPos = 0; this.hist = new Int32Array(16);
    for (const v of this.voices) Object.assign(v, new Voice());
    this.out = [];                // interleaved int16 stereo
  }

  // ------------------------------------------------------------------ bus
  peek(a) {
    a &= 0xFFFF;
    if (a >= 0xFFC0 && (this.control & 0x80)) return IPL[a - 0xFFC0];
    return this.ram[a];
  }

  read(a) {
    a &= 0xFFFF;
    if (a >= 0xF0 && a <= 0xFF) {
      switch (a) {
        case 0xF2: return this.dspAddr;
        case 0xF3: return this.dsp[this.dspAddr & 0x7F];
        case 0xF4: case 0xF5: case 0xF6: case 0xF7: return this.portIn[a - 0xF4];
        case 0xF8: return this.f8;
        case 0xF9: return this.f9;
        case 0xFD: case 0xFE: case 0xFF: { const i = a - 0xFD; const v = this.tOut[i]; this.tOut[i] = 0; return v; }
        default: return 0;
      }
    }
    return this.peek(a);
  }

  write(a, v) {
    a &= 0xFFFF; v &= 0xFF;
    this.ram[a] = v;
    if (a < 0xF0 || a > 0xFF) return;
    switch (a) {
      case 0xF1:
        if (v & 0x10) { this.portIn[0] = 0; this.portIn[1] = 0; }
        if (v & 0x20) { this.portIn[2] = 0; this.portIn[3] = 0; }
        for (let i = 0; i < 3; i++) {
          const on = (v >> i) & 1, was = (this.control >> i) & 1;
          if (on && !was) { this.tDiv[i] = 0; this.tOut[i] = 0; }
        }
        this.control = v;
        break;
      case 0xF2: this.dspAddr = v; break;
      case 0xF3: if (this.dspAddr < 0x80) this.dspWrite(this.dspAddr, v); break;
      case 0xF4: case 0xF5: case 0xF6: case 0xF7: this.portOut[a - 0xF4] = v; break;
      case 0xF8: this.f8 = v; break;
      case 0xF9: this.f9 = v; break;
      case 0xFA: case 0xFB: case 0xFC: this.tTarget[a - 0xFA] = v; break;
      case 0xFD: case 0xFE: case 0xFF: this.tOut[a - 0xFD] = 0; break;
      default: break;
    }
  }

  dspWrite(r, v) {
    this.dsp[r] = v;
    if (r === R.KON) this.newKon = v;
    if (r === R.ENDX) this.dsp[R.ENDX] = 0;
  }

  // ------------------------------------------------------------------ timers
  timerAdvance(i, ticks) {
    if (ticks <= 0 || !((this.control >> i) & 1)) return;
    const target = this.tTarget[i];
    const remain = ((target - this.tDiv[i] - 1) & 0xFF) + 1;   // ticks until the divider matches
    if (ticks < remain) { this.tDiv[i] = (this.tDiv[i] + ticks) & 0xFF; return; }
    const over = ticks - remain, period = target === 0 ? 256 : target;
    const n = Math.floor(over / period);
    this.tOut[i] = (this.tOut[i] + 1 + n) & 0x0F;
    this.tDiv[i] = over - n * period;
  }

  advance(cycles) {
    const old = this.clock;
    this.clock = (this.clock + cycles) >>> 0;
    // Clock is mod 2^32; 128 divides 2^32, so the tick counts stay correct across the wrap.
    const t01 = ((this.clock >>> 7) - (old >>> 7)) & 0x1FFFFFF;
    const t2 = ((this.clock >>> 4) - (old >>> 4)) & 0xFFFFFFF;
    this.timerAdvance(0, t01); this.timerAdvance(1, t01); this.timerAdvance(2, t2);
    this.apuCyc += cycles;
  }

  // Runs one SPC instruction (or, when stopped, idles until `limit`, at most 1024 cycles).
  spcStep(limit) {
    if (this.cpu.stopped) { this.advance(Math.max(2, Math.min(limit - this.apuCyc, 1024))); return; }
    this.advance(this.cpu.step());
  }

  // ------------------------------------------------------------------ DSP
  readCounter(rate) { return (this.counter + COUNTER_OFFSETS[rate]) % COUNTER_RATES[rate]; }

  runEnvelope(v, adsr0, adsr1, gain) {
    let env = v.env;
    if (v.envMode === ENV_RELEASE) {
      env -= 8; if (env < 0) env = 0; v.env = env; return;
    }
    let rate, envData = adsr1;
    if (adsr0 & 0x80) {
      if (v.envMode >= ENV_DECAY) {
        env--; env -= env >> 8;
        rate = envData & 0x1F;
        if (v.envMode === ENV_DECAY) rate = ((adsr0 >> 3) & 0x0E) + 0x10;
      } else {
        rate = (adsr0 & 0x0F) * 2 + 1;
        env += rate < 31 ? 0x20 : 0x400;
      }
    } else {
      envData = gain;
      const mode = gain >> 5;
      if (mode < 4) { env = gain * 0x10; rate = 31; }
      else {
        rate = gain & 0x1F;
        if (mode === 4) env -= 0x20;
        else if (mode < 6) { env--; env -= env >> 8; }
        else { env += 0x20; if (mode > 6 && (v.hiddenEnv >>> 0) >= 0x600) env += 0x8 - 0x20; }
      }
    }
    if ((env >> 8) === (envData >> 5) && v.envMode === ENV_DECAY) v.envMode = ENV_SUSTAIN;
    v.hiddenEnv = env;
    if (env < 0 || env > 0x7FF) {
      env = env < 0 ? 0 : 0x7FF;
      if (v.envMode === ENV_ATTACK) v.envMode = ENV_DECAY;
    }
    if (this.readCounter(rate) === 0) v.env = env;
  }

  decodeBrr(v, header, b0, b1) {
    let nyb = (b0 << 8) | b1;
    const shift = header >> 4, filter = header & 0x0C;
    for (let k = 0; k < 4; k++, nyb <<= 4) {
      const i = (v.bufPos + k) % 12;
      let s = s16(nyb) >> 12;
      if (shift <= 12) s = (s << shift) >> 1; else s &= ~0x7FF;
      const p1 = v.buf[(i + 11) % 12], p2 = v.buf[(i + 10) % 12] >> 1;
      if (filter >= 8) {
        s += p1; s -= p2;
        if (filter === 8) { s += p2 >> 4; s += (p1 * -3) >> 6; }
        else { s += (p1 * -13) >> 7; s += (p2 * 3) >> 4; }
      } else if (filter) { s += p1 >> 1; s += (-p1) >> 5; }
      s = clamp16(s);
      v.buf[i] = s16(s * 2);
    }
    v.bufPos = (v.bufPos + 4) % 12;
  }

  interpolate(v) {
    const off = (v.interpPos >> 4) & 0xFF;
    const base = v.bufPos + (v.interpPos >> 12);
    const i0 = v.buf[base % 12], i1 = v.buf[(base + 1) % 12], i2 = v.buf[(base + 2) % 12], i3 = v.buf[(base + 3) % 12];
    let out = (GAUSS[255 - off] * i0) >> 11;
    out += (GAUSS[511 - off] * i1) >> 11;
    out += (GAUSS[256 + off] * i2) >> 11;
    out = s16(out);
    out += (GAUSS[off] * i3) >> 11;
    return clamp16(out) & ~1;
  }

  dspSample() {
    const d = this.dsp, ram = this.ram;
    if ((this.everyOther ^= 1) !== 0) {
      this.newKon &= ~this.kon;
      this.kon = this.newKon;
      this.tKoff = d[R.KOFF] | (this.muteMask || 0);
    }
    if (--this.counter < 0) this.counter = COUNTER_RANGE - 1;
    if (this.readCounter(d[R.FLG] & 0x1F) === 0) {
      const fb = (this.noise << 13) ^ (this.noise << 14);
      this.noise = (fb & 0x4000) ^ (this.noise >> 1);
    }

    const main = [0, 0], echo = [0, 0];
    let prevOut = 0;
    const flg = d[R.FLG], pmon = d[R.PMON] & 0xFE, non = d[R.NON], eon = d[R.EON];
    for (let vi = 0; vi < 8; vi++) {
      const v = this.voices[vi], vb = 1 << vi, r = vi << 4;
      const dirAddr = (d[R.DIR] * 0x100 + d[r + 4] * 4) & 0xFFFF;
      const e = (dirAddr + (v.konDelay ? 0 : 2)) & 0xFFFF;
      const brrNext = ram[e] | (ram[(e + 1) & 0xFFFF] << 8);
      let pitch = d[r + 2] | ((d[r + 3] & 0x3F) << 8);
      const brrByte = ram[(v.brrAddr + v.brrOffset) & 0xFFFF];
      let header = ram[v.brrAddr];

      if (pmon & vb) pitch += ((prevOut >> 5) * pitch) >> 10;
      if (v.konDelay) {
        if (v.konDelay === 5) { v.brrAddr = brrNext; v.brrOffset = 1; v.bufPos = 0; header = 0; }
        v.env = 0; v.hiddenEnv = 0;
        v.interpPos = 0;
        if (--v.konDelay & 3) v.interpPos = 0x4000;
        pitch = 0;
      }
      let output = this.interpolate(v);
      if (non & vb) output = s16(this.noise * 2);
      const tOut = ((output * v.env) >> 11) & ~1;
      const envx = v.env >> 4;
      if ((flg & 0x80) || (header & 3) === 1) { v.envMode = ENV_RELEASE; v.env = 0; }
      if (this.everyOther) {
        if (this.tKoff & vb) v.envMode = ENV_RELEASE;
        if (this.kon & vb) { v.konDelay = 5; v.envMode = ENV_ATTACK; }
      }
      if (!v.konDelay) this.runEnvelope(v, d[r + 5], d[r + 6], d[r + 7]);
      if (this.trace) this.trace(vi, v, tOut, header);

      let looped = 0;
      if (v.interpPos >= 0x4000) {
        this.decodeBrr(v, header, brrByte, ram[(v.brrAddr + v.brrOffset + 1) & 0xFFFF]);
        v.brrOffset += 2;
        if (v.brrOffset >= 9) {
          v.brrAddr = (v.brrAddr + 9) & 0xFFFF;
          if (header & 1) { v.brrAddr = brrNext; looped = vb; }
          v.brrOffset = 1;
        }
      }
      v.interpPos = (v.interpPos & 0x3FFF) + pitch;
      if (v.interpPos > 0x7FFF) v.interpPos = 0x7FFF;

      for (let ch = 0; ch < 2; ch++) {
        const amp = (tOut * s8(d[r + ch])) >> 7;
        main[ch] = clamp16(main[ch] + amp);
        if (eon & vb) echo[ch] = clamp16(echo[ch] + amp);
      }
      let endx = d[R.ENDX] | looped;
      if (v.konDelay === 5) endx &= ~vb;
      d[R.ENDX] = endx & 0xFF;
      d[r + 8] = envx & 0xFF;
      d[r + 9] = (tOut >> 8) & 0xFF;
      prevOut = tOut;
    }

    // Echo
    this.echoHistPos = (this.echoHistPos + 1) & 7;
    const ptr = (this.tEsa * 0x100 + this.echoOffset) & 0xFFFF;
    const p = this.echoHistPos;
    const inL = s16(ram[ptr] | (ram[(ptr + 1) & 0xFFFF] << 8));
    const inR = s16(ram[(ptr + 2) & 0xFFFF] | (ram[(ptr + 3) & 0xFFFF] << 8));
    this.hist[p * 2] = inL >> 1; this.hist[p * 2 + 1] = inR >> 1;
    const echoIn = [0, 0], outS = [0, 0], fb = [0, 0];
    for (let ch = 0; ch < 2; ch++) {
      let sum = 0;
      for (let t = 0; t < 7; t++) sum += (this.hist[((p + t + 1) & 7) * 2 + ch] * s8(d[t * 0x10 + 0x0F])) >> 6;
      sum = s16(sum);
      sum += s16((this.hist[p * 2 + ch] * s8(d[0x7F])) >> 6);
      echoIn[ch] = clamp16(sum) & ~1;
      outS[ch] = clamp16(s16((main[ch] * s8(d[R.MVOLL + ch * 0x10])) >> 7) + s16((echoIn[ch] * s8(d[R.EVOLL + ch * 0x10])) >> 7));
      fb[ch] = clamp16(echo[ch] + s16((echoIn[ch] * s8(d[R.EFB])) >> 7)) & ~1;
    }
    if (flg & 0x40) { outS[0] = 0; outS[1] = 0; }
    this.tEsa = d[R.ESA];
    if (this.echoOffset === 0) this.echoLength = (d[R.EDL] & 0x0F) * 0x800;
    this.echoOffset += 4;
    if (this.echoOffset >= this.echoLength) this.echoOffset = 0;
    if (!(flg & 0x20)) {
      ram[ptr] = fb[0] & 0xFF; ram[(ptr + 1) & 0xFFFF] = (fb[0] >> 8) & 0xFF;
      ram[(ptr + 2) & 0xFFFF] = fb[1] & 0xFF; ram[(ptr + 3) & 0xFFFF] = (fb[1] >> 8) & 0xFF;
    }
    this.out.push(outS[0], outS[1]);
  }

  // ------------------------------------------------------------------ driver
  // Runs one emulated frame of `samples` samples with no main CPU (the GPU's APU test mode).
  runFrame(samples) {
    const end = samples * 32;
    for (;;) {
      if (this.apuCyc >= this.dspNext) { this.dspSample(); this.dspNext += 32; }
      else if (this.apuCyc < end) this.spcStep(end);
      else break;
    }
    this.apuCyc -= end;
    this.dspNext -= end;
  }

  // State in the GPU's word layout (SnesCommon.cginc AW_*), words 0-143, for comparing with a GPU dump.
  stateWords() {
    const c = this.cpu, w = new Array(144).fill(0);
    const b4 = (a, b, x, d) => ((a & 0xFF) | ((b & 0xFF) << 8) | ((x & 0xFF) << 16) | ((d & 0xFF) << 24)) >>> 0;
    w[0] = b4(c.a, c.x, c.y, c.sp);
    w[1] = (c.pc | (c.psw << 16) | ((c.stopped ? 1 : 0) << 24)) >>> 0;
    w[2] = b4(...this.portIn); w[3] = b4(...this.portOut);
    w[4] = b4(this.control, this.dspAddr, this.f8, this.f9);
    w[5] = b4(...this.tTarget, 0); w[6] = b4(...this.tDiv, 0); w[7] = b4(...this.tOut, 0);
    w[8] = this.clock >>> 0; w[9] = this.apuCyc >>> 0; w[10] = this.dspNext >>> 0;
    w[12] = (this.noise | (this.counter << 16)) >>> 0;
    w[13] = (this.echoOffset | (this.echoLength << 16)) >>> 0;
    w[14] = b4(this.everyOther, this.kon, this.newKon, this.tKoff);
    w[15] = this.tEsa | (this.echoHistPos << 8);
    for (let h = 0; h < 8; h++) w[16 + h] = ((this.hist[h * 2] & 0xFFFF) | (this.hist[h * 2 + 1] << 16)) >>> 0;
    for (let r = 0; r < 32; r++) w[32 + r] = b4(this.dsp[r * 4], this.dsp[r * 4 + 1], this.dsp[r * 4 + 2], this.dsp[r * 4 + 3]);
    this.voices.forEach((v, i) => {
      w[64 + i * 4] = (v.brrAddr | (v.brrOffset << 16) | (v.bufPos << 24)) >>> 0;
      w[65 + i * 4] = (v.interpPos | (v.env << 16)) >>> 0;
      w[66 + i * 4] = ((v.hiddenEnv & 0xFFFF) | (v.envMode << 16) | (v.konDelay << 24)) >>> 0;
      for (let k = 0; k < 6; k++) w[96 + i * 6 + k] = ((v.buf[k * 2] & 0xFFFF) | (v.buf[k * 2 + 1] << 16)) >>> 0;
    });
    return w;
  }

  // Loads an .spc file (SPC700 sound file format v0.30).
  loadSpc(buf) {
    this.reset();
    const c = this.cpu;
    c.pc = buf[0x25] | (buf[0x26] << 8); c.a = buf[0x27]; c.x = buf[0x28]; c.y = buf[0x29];
    c.psw = buf[0x2A]; c.sp = buf[0x2B];
    this.ram.set(buf.subarray(0x100, 0x10100));
    const io = this.ram.subarray(0xF0, 0x100);
    this.control = io[1] & 0x87; this.dspAddr = io[2];
    this.portIn = [io[4], io[5], io[6], io[7]];
    this.f8 = io[8]; this.f9 = io[9];
    this.tTarget = [io[0xA], io[0xB], io[0xC]];
    this.tOut = [io[0xD] & 15, io[0xE] & 15, io[0xF] & 15];
    this.tDiv = [0, 0, 0];
    for (let i = 0; i < 128; i++) this.dsp[i] = buf[0x10100 + i];
    this.newKon = this.dsp[R.KON];
  }
}

module.exports = { Apu, IPL, GAUSS, COUNTER_RATES, COUNTER_OFFSETS, R };
