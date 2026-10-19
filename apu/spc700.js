// Reference SPC700 core used to check the GPU sound CPU (Assets/SNES/Shaders/SnesSpc.cginc).
// It decodes through the same opcode table (spctable.js) and follows the same steps as the shader,
// so a bug found here maps one-to-one onto the HLSL. Memory is reached through callbacks.
'use strict';
const T = require('./spctable');

class Spc700 {
  // read(addr) / write(addr, value) are the bus. peek(addr) reads code bytes without side effects.
  constructor(bus) {
    this.bus = bus;
    this.pc = 0; this.a = 0; this.x = 0; this.y = 0; this.sp = 0; this.psw = 0;
    this.stopped = false;
  }

  rd(a) { return this.bus.read(a & 0xFFFF) & 0xFF; }
  wr(a, v) { this.bus.write(a & 0xFFFF, v & 0xFF); }
  dp(off) { return ((this.psw & 0x20) ? 0x100 : 0) | (off & 0xFF); }
  push(v) { this.wr(0x100 | this.sp, v); this.sp = (this.sp - 1) & 0xFF; }
  pop() { this.sp = (this.sp + 1) & 0xFF; return this.rd(0x100 | this.sp); }
  setNZ(v) { this.psw = (this.psw & ~0x82) | (v & 0x80) | ((v & 0xFF) === 0 ? 0x02 : 0); }
  setNZ16(v) { this.psw = (this.psw & ~0x82) | ((v >> 8) & 0x80) | ((v & 0xFFFF) === 0 ? 0x02 : 0); }
  reg(r) { return r === T.R_A ? this.a : r === T.R_X ? this.x : this.y; }
  setReg(r, v) { v &= 0xFF; if (r === T.R_A) this.a = v; else if (r === T.R_X) this.x = v; else this.y = v; }

  adc(a, b) {
    const c = this.psw & 1;
    const r = a + b + c;
    let p = this.psw & ~0x4B;
    if (~(a ^ b) & (a ^ r) & 0x80) p |= 0x40;
    if ((a ^ b ^ r) & 0x10) p |= 0x08;
    if (r > 0xFF) p |= 0x01;
    this.psw = p;
    this.setNZ(r);
    return r & 0xFF;
  }

  alu(op, a, b) {
    switch (op) {
      case T.A_OR: a |= b; this.setNZ(a); return a;
      case T.A_AND: a &= b; this.setNZ(a); return a;
      case T.A_EOR: a ^= b; this.setNZ(a); return a;
      case T.A_CMP: { const t = a - b; this.psw = (this.psw & ~1) | (t >= 0 ? 1 : 0); this.setNZ(t & 0xFF); return a; }
      case T.A_ADC: return this.adc(a, b);
      default: return this.adc(a, b ^ 0xFF);   // SBC
    }
  }

  // Returns the cycles used.
  step() {
    if (this.stopped) return 2;
    const pc0 = this.pc;
    const op = this.bus.peek(pc0);
    const b1 = this.bus.peek((pc0 + 1) & 0xFFFF);
    const b2 = this.bus.peek((pc0 + 2) & 0xFFFF);
    const t = T.TABLE[op];
    const kind = t & 0x3F, mode = (t >> 6) & 0x1F, r = (t >> 11) & 3, sub = (t >> 13) & 7;
    let cycles = T.CYCLES[op];
    this.pc = (pc0 + T.LENGTH[op]) & 0xFFFF;
    const w16 = b1 | (b2 << 8);

    // Effective address for the memory operand (one site, used by every mode).
    let ea = 0;
    switch (mode) {
      case T.M_DP: ea = this.dp(b1); break;
      case T.M_DPX: ea = this.dp(b1 + this.x); break;
      case T.M_DPY: ea = this.dp(b1 + this.y); break;
      case T.M_ABS: ea = w16; break;
      case T.M_ABSX: ea = (w16 + this.x) & 0xFFFF; break;
      case T.M_ABSY: ea = (w16 + this.y) & 0xFFFF; break;
      case T.M_IX: ea = this.dp(this.x); break;
      case T.M_IDPX: { const p = this.dp(b1 + this.x); ea = this.rd(p) | (this.rd(this.dp(b1 + this.x + 1)) << 8); break; }
      case T.M_IDPY: { const p = this.dp(b1); ea = ((this.rd(p) | (this.rd(this.dp(b1 + 1)) << 8)) + this.y) & 0xFFFF; break; }
      case T.M_DPDP: ea = this.dp(b2); break;        // destination; source is dp(b1)
      case T.M_DPIMM: ea = this.dp(b2); break;       // destination; source is #b1
      case T.M_XY: ea = this.dp(this.x); break;      // destination (X); source (Y)
      case T.M_DPREL: case T.M_DPXREL: ea = this.dp(b1 + (mode === T.M_DPXREL ? this.x : 0)); break;
      case T.M_MBIT: ea = w16 & 0x1FFF; break;
      default: break;
    }

    switch (kind) {
      case T.K_NOP: break;
      case T.K_ALU: {
        // A/X/Y op= operand, or memory op= operand for the two-operand modes.
        let src, dstMem = false;
        if (mode === T.M_IMM) src = b1;
        else if (mode === T.M_DPDP) src = this.rd(this.dp(b1));
        else if (mode === T.M_DPIMM) src = b1;
        else if (mode === T.M_XY) src = this.rd(this.dp(this.y));
        else src = this.rd(ea);
        if (mode === T.M_DPDP || mode === T.M_DPIMM || mode === T.M_XY) dstMem = true;
        if (dstMem) {
          const d = this.rd(ea);
          const res = this.alu(sub, d, src);
          if (sub !== T.A_CMP) this.wr(ea, res);
        } else {
          const res = this.alu(sub, this.reg(r), src);
          if (sub !== T.A_CMP) this.setReg(r, res);
        }
        break;
      }
      case T.K_MOVLD: {
        let v;
        if (mode === T.M_IMM) v = b1;
        else if (mode === T.M_IXINC) { v = this.rd(this.dp(this.x)); this.x = (this.x + 1) & 0xFF; }
        else v = this.rd(ea);
        this.setReg(r, v); this.setNZ(v);
        break;
      }
      case T.K_MOVST: {
        if (mode === T.M_IXINC) { this.wr(this.dp(this.x), this.a); this.x = (this.x + 1) & 0xFF; }
        else this.wr(ea, this.reg(r));
        break;
      }
      case T.K_MOVRR: {
        // sub: 0 A<-X 1 A<-Y 2 X<-A 3 Y<-A 4 X<-SP 5 SP<-X
        switch (sub) {
          case 0: this.a = this.x; this.setNZ(this.a); break;
          case 1: this.a = this.y; this.setNZ(this.a); break;
          case 2: this.x = this.a; this.setNZ(this.x); break;
          case 3: this.y = this.a; this.setNZ(this.y); break;
          case 4: this.x = this.sp; this.setNZ(this.x); break;
          default: this.sp = this.x; break;
        }
        break;
      }
      case T.K_MOVMM: {
        const v = mode === T.M_DPIMM ? b1 : this.rd(this.dp(b1));
        this.wr(ea, v);
        break;
      }
      case T.K_INCDEC: {
        const d = sub & 1 ? -1 : 1;
        if (mode === T.M_IMP) { const v = (this.reg(r) + d) & 0xFF; this.setReg(r, v); this.setNZ(v); }
        else { const v = (this.rd(ea) + d) & 0xFF; this.wr(ea, v); this.setNZ(v); }
        break;
      }
      case T.K_SHIFT: {
        // sub: 0 ASL 1 ROL 2 LSR 3 ROR
        const v = mode === T.M_IMP ? this.a : this.rd(ea);
        const c = this.psw & 1;
        let res, nc;
        if (sub === 0) { res = (v << 1) & 0xFF; nc = v >> 7; }
        else if (sub === 1) { res = ((v << 1) | c) & 0xFF; nc = v >> 7; }
        else if (sub === 2) { res = v >> 1; nc = v & 1; }
        else { res = (v >> 1) | (c << 7); nc = v & 1; }
        this.psw = (this.psw & ~1) | nc;
        this.setNZ(res);
        if (mode === T.M_IMP) this.a = res; else this.wr(ea, res);
        break;
      }
      case T.K_BRANCH: {
        // sub: 0 BPL 1 BMI 2 BVC 3 BVS 4 BCC 5 BCS 6 BNE 7 BEQ ; r==3 -> BRA
        let take = true;
        if (r !== 3) {
          const bit = [0x80, 0x40, 0x01, 0x02][sub >> 1];
          take = ((this.psw & bit) !== 0) === ((sub & 1) === 1);
        }
        if (take) this.pc = (this.pc + ((b1 ^ 0x80) - 0x80)) & 0xFFFF; else cycles -= 2;
        break;
      }
      case T.K_BBX: {
        const v = this.rd(ea);
        const set = ((v >> sub) & 1) === 1;
        if (set === (r === 0)) this.pc = (this.pc + ((b2 ^ 0x80) - 0x80)) & 0xFFFF; else cycles -= 2;
        break;
      }
      case T.K_CBNE: {
        const v = this.rd(ea);
        if (v !== this.a) this.pc = (this.pc + ((b2 ^ 0x80) - 0x80)) & 0xFFFF; else cycles -= 2;
        break;
      }
      case T.K_DBNZ: {
        let v;
        if (mode === T.M_REL) { this.y = (this.y - 1) & 0xFF; v = this.y; }
        else { v = (this.rd(ea) - 1) & 0xFF; this.wr(ea, v); }
        const off = mode === T.M_REL ? b1 : b2;
        if (v !== 0) this.pc = (this.pc + ((off ^ 0x80) - 0x80)) & 0xFFFF; else cycles -= 2;
        break;
      }
      case T.K_JMP: this.pc = w16; break;
      case T.K_JMPIX: { const p = (w16 + this.x) & 0xFFFF; this.pc = this.rd(p) | (this.rd((p + 1) & 0xFFFF) << 8); break; }
      case T.K_CALL: {
        // sub: 0 CALL abs 1 PCALL 2 TCALL (vector index in r|sub-bits via opcode) 3 BRK
        let target;
        if (sub === 0) target = w16;
        else if (sub === 1) target = 0xFF00 | b1;
        else { const v = sub === 2 ? 0xFFDE - ((op >> 4) << 1) : 0xFFDE; target = this.rd(v) | (this.rd(v + 1) << 8); }
        this.push(this.pc >> 8); this.push(this.pc & 0xFF);
        if (sub === 3) { this.push(this.psw); this.psw = (this.psw | 0x10) & ~0x04; }
        this.pc = target;
        break;
      }
      case T.K_RET: {
        if (sub === 1) this.psw = this.pop();
        const lo = this.pop(); const hi = this.pop();
        this.pc = lo | (hi << 8);
        break;
      }
      case T.K_PUSH: this.push(sub === 1 ? this.psw : this.reg(r)); break;
      case T.K_POP: { const v = this.pop(); if (sub === 1) this.psw = v; else this.setReg(r, v); break; }
      case T.K_SETCLR1: { const v = this.rd(ea); this.wr(ea, r === 0 ? (v | (1 << sub)) : (v & ~(1 << sub))); break; }
      case T.K_TSETCLR: {
        const v = this.rd(ea);
        this.setNZ((this.a - v) & 0xFF);
        this.wr(ea, r === 0 ? (v | this.a) : (v & ~this.a));
        break;
      }
      case T.K_BITC: {
        // sub: 0 OR1 1 OR1 / 2 AND1 3 AND1 / 4 EOR1 5 NOT1 6 MOV1 C,m 7 MOV1 m,C
        const bit = b2 >> 5;
        const v = this.rd(ea);
        const m = (v >> bit) & 1;
        const c = this.psw & 1;
        switch (sub) {
          case 0: this.psw = (this.psw & ~1) | (c | m); break;
          case 1: this.psw = (this.psw & ~1) | (c | (m ^ 1)); break;
          case 2: this.psw = (this.psw & ~1) | (c & m); break;
          case 3: this.psw = (this.psw & ~1) | (c & (m ^ 1)); break;
          case 4: this.psw = (this.psw & ~1) | (c ^ m); break;
          case 5: this.wr(ea, v ^ (1 << bit)); break;
          case 6: this.psw = (this.psw & ~1) | m; break;
          default: this.wr(ea, (v & ~(1 << bit)) | (c << bit)); break;
        }
        break;
      }
      case T.K_FLAG: {
        // sub: 0 CLRC 1 SETC 2 NOTC 3 CLRV 4 CLRP 5 SETP 6 EI 7 DI
        const p = this.psw;
        this.psw = [p & ~1, p | 1, p ^ 1, p & ~0x48, p & ~0x20, p | 0x20, p | 0x04, p & ~0x04][sub];
        break;
      }
      case T.K_WORD: {
        // sub: 0 MOVW YA,dp 1 MOVW dp,YA 2 INCW 3 DECW 4 ADDW 5 SUBW 6 CMPW
        const lo = this.dp(b1), hi = this.dp(b1 + 1);
        if (sub === 1) { this.wr(lo, this.a); this.wr(hi, this.y); break; }
        const vl = this.rd(lo);
        const vh = this.rd(hi);
        const m = vl | (vh << 8);
        const ya = this.a | (this.y << 8);
        if (sub === 0) { this.a = vl; this.y = vh; this.setNZ16(m); }
        else if (sub === 2 || sub === 3) {
          const v = (m + (sub === 2 ? 1 : -1)) & 0xFFFF;
          this.wr(lo, v & 0xFF); this.wr(hi, v >> 8); this.setNZ16(v);
        } else if (sub === 6) {
          const t = ya - m;
          this.psw = (this.psw & ~1) | (t >= 0 ? 1 : 0);
          this.setNZ16(t & 0xFFFF);
        } else {
          const b = sub === 4 ? m : (m ^ 0xFFFF);
          const cin = sub === 4 ? 0 : 1;
          const res = ya + b + cin;
          let p = this.psw & ~0x4B;
          if (~(ya ^ b) & (ya ^ res) & 0x8000) p |= 0x40;
          if ((ya ^ b ^ res) & 0x1000) p |= 0x08;
          if (res > 0xFFFF) p |= 0x01;
          this.psw = p;
          this.a = res & 0xFF; this.y = (res >> 8) & 0xFF;
          this.setNZ16(res);
        }
        break;
      }
      case T.K_MISC: {
        // sub: 0 MUL 1 DIV 2 DAA 3 DAS 4 XCN 5 SLEEP/STOP
        if (sub === 0) {
          const p = this.y * this.a;
          this.a = p & 0xFF; this.y = p >> 8;
          this.setNZ(this.y);
        } else if (sub === 1) {
          const ya = (this.y << 8) | this.a, x = this.x;
          let p = this.psw & ~0x48;
          if (this.y >= x) p |= 0x40;
          if ((this.y & 15) >= (x & 15)) p |= 0x08;
          this.psw = p;
          let q, rem;
          if (this.y < x * 2) { q = Math.floor(ya / x); rem = ya - q * x; }
          else { q = 255 - Math.floor((ya - x * 0x200) / (256 - x)); rem = x + ((ya - x * 0x200) % (256 - x)); }
          this.a = q & 0xFF; this.y = rem & 0xFF;
          this.setNZ(this.a);
        } else if (sub === 2) {
          let a = this.a;
          if (a > 0x99 || (this.psw & 1)) { a += 0x60; this.psw |= 1; }
          if ((a & 0x0F) > 9 || (this.psw & 0x08)) a += 0x06;
          this.a = a & 0xFF; this.setNZ(this.a);
        } else if (sub === 3) {
          let a = this.a;
          if (a > 0x99 || !(this.psw & 1)) { a -= 0x60; this.psw &= ~1; }
          if ((a & 0x0F) > 9 || !(this.psw & 0x08)) a -= 0x06;
          this.a = a & 0xFF; this.setNZ(this.a);
        } else if (sub === 4) {
          this.a = ((this.a >> 4) | (this.a << 4)) & 0xFF; this.setNZ(this.a);
        } else this.stopped = true;
        break;
      }
      default: throw new Error('unhandled kind ' + kind + ' op ' + op.toString(16));
    }
    return cycles;
  }
}

module.exports = { Spc700 };
