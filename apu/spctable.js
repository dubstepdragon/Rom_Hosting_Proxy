// SPC700 decode table shared by the reference core (spc700.js) and the GPU core.
// Entry = kind | mode << 6 | reg << 11 | sub << 13.  `node apu/spctable.js` prints the HLSL table.
'use strict';

const K = ['NOP', 'ALU', 'MOVLD', 'MOVST', 'MOVRR', 'MOVMM', 'INCDEC', 'SHIFT', 'BRANCH', 'BBX', 'CBNE', 'DBNZ',
  'JMP', 'JMPIX', 'CALL', 'RET', 'PUSH', 'POP', 'SETCLR1', 'TSETCLR', 'BITC', 'FLAG', 'WORD', 'MISC'];
const M = ['IMP', 'IMM', 'DP', 'DPX', 'DPY', 'ABS', 'ABSX', 'ABSY', 'IX', 'IXINC', 'IDPX', 'IDPY', 'DPDP', 'DPIMM',
  'XY', 'REL', 'DPREL', 'DPXREL', 'MBIT'];
const MODE_LEN = { IMP: 1, IMM: 2, DP: 2, DPX: 2, DPY: 2, ABS: 3, ABSX: 3, ABSY: 3, IX: 1, IXINC: 1, IDPX: 2, IDPY: 2,
  DPDP: 3, DPIMM: 3, XY: 1, REL: 2, DPREL: 3, DPXREL: 3, MBIT: 3 };

const C = {};
K.forEach((n, i) => { C['K_' + n] = i; });
M.forEach((n, i) => { C['M_' + n] = i; });
Object.assign(C, { R_A: 0, R_X: 1, R_Y: 2, A_OR: 0, A_AND: 1, A_EOR: 2, A_CMP: 3, A_ADC: 4, A_SBC: 5 });

const TABLE = new Array(256).fill(-1);
const LENGTH = new Array(256).fill(0);
const set = (op, kind, mode, reg = 0, sub = 0) => {
  if (TABLE[op] !== -1) throw new Error('duplicate ' + op.toString(16));
  TABLE[op] = C['K_' + kind] | (C['M_' + mode] << 6) | (reg << 11) | (sub << 13);
  LENGTH[op] = MODE_LEN[mode];
};

// ALU rows: OR AND EOR CMP ADC SBC on A, plus the memory-to-memory forms.
for (let i = 0; i < 6; i++) {
  const row = i << 5;
  set(row | 0x04, 'ALU', 'DP', 0, i); set(row | 0x05, 'ALU', 'ABS', 0, i);
  set(row | 0x06, 'ALU', 'IX', 0, i); set(row | 0x07, 'ALU', 'IDPX', 0, i);
  set(row | 0x08, 'ALU', 'IMM', 0, i); set(row | 0x09, 'ALU', 'DPDP', 0, i);
  set(row | 0x14, 'ALU', 'DPX', 0, i); set(row | 0x15, 'ALU', 'ABSX', 0, i);
  set(row | 0x16, 'ALU', 'ABSY', 0, i); set(row | 0x17, 'ALU', 'IDPY', 0, i);
  set(row | 0x18, 'ALU', 'DPIMM', 0, i); set(row | 0x19, 'ALU', 'XY', 0, i);
}
// CMP X / CMP Y
set(0xC8, 'ALU', 'IMM', 1, 3); set(0x3E, 'ALU', 'DP', 1, 3); set(0x1E, 'ALU', 'ABS', 1, 3);
set(0xAD, 'ALU', 'IMM', 2, 3); set(0x7E, 'ALU', 'DP', 2, 3); set(0x5E, 'ALU', 'ABS', 2, 3);

// Loads
[[0xE8, 'IMM'], [0xE4, 'DP'], [0xF4, 'DPX'], [0xE5, 'ABS'], [0xF5, 'ABSX'], [0xF6, 'ABSY'], [0xE6, 'IX'],
  [0xBF, 'IXINC'], [0xE7, 'IDPX'], [0xF7, 'IDPY']].forEach(([o, m]) => set(o, 'MOVLD', m, 0));
[[0xCD, 'IMM'], [0xF8, 'DP'], [0xF9, 'DPY'], [0xE9, 'ABS']].forEach(([o, m]) => set(o, 'MOVLD', m, 1));
[[0x8D, 'IMM'], [0xEB, 'DP'], [0xFB, 'DPX'], [0xEC, 'ABS']].forEach(([o, m]) => set(o, 'MOVLD', m, 2));
// Stores
[[0xC4, 'DP'], [0xD4, 'DPX'], [0xC5, 'ABS'], [0xD5, 'ABSX'], [0xD6, 'ABSY'], [0xC6, 'IX'], [0xAF, 'IXINC'],
  [0xC7, 'IDPX'], [0xD7, 'IDPY']].forEach(([o, m]) => set(o, 'MOVST', m, 0));
[[0xD8, 'DP'], [0xD9, 'DPY'], [0xC9, 'ABS']].forEach(([o, m]) => set(o, 'MOVST', m, 1));
[[0xCB, 'DP'], [0xDB, 'DPX'], [0xCC, 'ABS']].forEach(([o, m]) => set(o, 'MOVST', m, 2));
// Register transfers
set(0x7D, 'MOVRR', 'IMP', 0, 0); set(0xDD, 'MOVRR', 'IMP', 0, 1); set(0x5D, 'MOVRR', 'IMP', 0, 2);
set(0xFD, 'MOVRR', 'IMP', 0, 3); set(0x9D, 'MOVRR', 'IMP', 0, 4); set(0xBD, 'MOVRR', 'IMP', 0, 5);
// Memory to memory
set(0xFA, 'MOVMM', 'DPDP'); set(0x8F, 'MOVMM', 'DPIMM');
// INC / DEC
set(0xBC, 'INCDEC', 'IMP', 0, 0); set(0x3D, 'INCDEC', 'IMP', 1, 0); set(0xFC, 'INCDEC', 'IMP', 2, 0);
set(0x9C, 'INCDEC', 'IMP', 0, 1); set(0x1D, 'INCDEC', 'IMP', 1, 1); set(0xDC, 'INCDEC', 'IMP', 2, 1);
set(0xAB, 'INCDEC', 'DP', 0, 0); set(0xBB, 'INCDEC', 'DPX', 0, 0); set(0xAC, 'INCDEC', 'ABS', 0, 0);
set(0x8B, 'INCDEC', 'DP', 0, 1); set(0x9B, 'INCDEC', 'DPX', 0, 1); set(0x8C, 'INCDEC', 'ABS', 0, 1);
// Shifts: ASL ROL LSR ROR
for (let s = 0; s < 4; s++) {
  const row = s << 5;
  set(row | 0x1C, 'SHIFT', 'IMP', 0, s); set(row | 0x0B, 'SHIFT', 'DP', 0, s);
  set(row | 0x1B, 'SHIFT', 'DPX', 0, s); set(row | 0x0C, 'SHIFT', 'ABS', 0, s);
}
// Branches
for (let s = 0; s < 8; s++) set(0x10 | (s << 5), 'BRANCH', 'REL', 0, s);
set(0x2F, 'BRANCH', 'REL', 3, 0);
for (let b = 0; b < 8; b++) {
  set(0x03 | (b << 5), 'BBX', 'DPREL', 0, b);
  set(0x13 | (b << 5), 'BBX', 'DPREL', 1, b);
  set(0x02 | (b << 5), 'SETCLR1', 'DP', 0, b);
  set(0x12 | (b << 5), 'SETCLR1', 'DP', 1, b);
}
set(0x2E, 'CBNE', 'DPREL'); set(0xDE, 'CBNE', 'DPXREL');
set(0x6E, 'DBNZ', 'DPREL'); set(0xFE, 'DBNZ', 'REL');
set(0x5F, 'JMP', 'ABS'); set(0x1F, 'JMPIX', 'ABS');
// Calls and returns
set(0x3F, 'CALL', 'ABS', 0, 0); set(0x4F, 'CALL', 'IMM', 0, 1); set(0x0F, 'CALL', 'IMP', 0, 3);
for (let n = 0; n < 16; n++) set(0x01 | (n << 4), 'CALL', 'IMP', 0, 2);
set(0x6F, 'RET', 'IMP', 0, 0); set(0x7F, 'RET', 'IMP', 0, 1);
// Stack
set(0x0D, 'PUSH', 'IMP', 0, 1); set(0x2D, 'PUSH', 'IMP', 0, 0); set(0x4D, 'PUSH', 'IMP', 1, 0); set(0x6D, 'PUSH', 'IMP', 2, 0);
set(0x8E, 'POP', 'IMP', 0, 1); set(0xAE, 'POP', 'IMP', 0, 0); set(0xCE, 'POP', 'IMP', 1, 0); set(0xEE, 'POP', 'IMP', 2, 0);
// Bit operations
set(0x0E, 'TSETCLR', 'ABS', 0); set(0x4E, 'TSETCLR', 'ABS', 1);
[[0x0A, 0], [0x2A, 1], [0x4A, 2], [0x6A, 3], [0x8A, 4], [0xEA, 5], [0xAA, 6], [0xCA, 7]]
  .forEach(([o, s]) => set(o, 'BITC', 'MBIT', 0, s));
// Flags
[[0x60, 0], [0x80, 1], [0xED, 2], [0xE0, 3], [0x20, 4], [0x40, 5], [0xA0, 6], [0xC0, 7]]
  .forEach(([o, s]) => set(o, 'FLAG', 'IMP', 0, s));
// 16-bit
[[0xBA, 0], [0xDA, 1], [0x3A, 2], [0x1A, 3], [0x7A, 4], [0x9A, 5], [0x5A, 6]]
  .forEach(([o, s]) => set(o, 'WORD', 'DP', 0, s));
// Misc
set(0xCF, 'MISC', 'IMP', 0, 0); set(0x9E, 'MISC', 'IMP', 0, 1); set(0xDF, 'MISC', 'IMP', 0, 2);
set(0xBE, 'MISC', 'IMP', 0, 3); set(0x9F, 'MISC', 'IMP', 0, 4); set(0xEF, 'MISC', 'IMP', 0, 5); set(0xFF, 'MISC', 'IMP', 0, 5);
set(0x00, 'NOP', 'IMP');

for (let i = 0; i < 256; i++) if (TABLE[i] === -1) throw new Error('missing opcode ' + i.toString(16));

// Cycles (taken branches; a branch not taken costs 2 less). Packed two per byte, from blargg's table.
const PACKED = [
  0x28, 0x47, 0x34, 0x36, 0x26, 0x54, 0x54, 0x68, 0x48, 0x47, 0x45, 0x56, 0x55, 0x65, 0x22, 0x46,
  0x28, 0x47, 0x34, 0x36, 0x26, 0x54, 0x54, 0x74, 0x48, 0x47, 0x45, 0x56, 0x55, 0x65, 0x22, 0x38,
  0x28, 0x47, 0x34, 0x36, 0x26, 0x44, 0x54, 0x66, 0x48, 0x47, 0x45, 0x56, 0x55, 0x45, 0x22, 0x43,
  0x28, 0x47, 0x34, 0x36, 0x26, 0x44, 0x54, 0x75, 0x48, 0x47, 0x45, 0x56, 0x55, 0x55, 0x22, 0x36,
  0x28, 0x47, 0x34, 0x36, 0x26, 0x54, 0x52, 0x45, 0x48, 0x47, 0x45, 0x56, 0x55, 0x55, 0x22, 0xC5,
  0x38, 0x47, 0x34, 0x36, 0x26, 0x44, 0x52, 0x44, 0x48, 0x47, 0x45, 0x56, 0x55, 0x55, 0x22, 0x34,
  0x38, 0x47, 0x45, 0x47, 0x25, 0x64, 0x52, 0x49, 0x48, 0x47, 0x56, 0x67, 0x45, 0x55, 0x22, 0x83,
  0x28, 0x47, 0x34, 0x36, 0x24, 0x53, 0x43, 0x40, 0x48, 0x47, 0x45, 0x56, 0x34, 0x54, 0x22, 0x60,
];
const CYCLES = [];
for (const n of PACKED) { CYCLES.push(n >> 4); CYCLES.push(n & 15); }

module.exports = Object.assign({ TABLE, LENGTH, CYCLES, K, M }, C);

if (require.main === module) {
  // HLSL: one uint per opcode = table entry | length << 16 | cycles << 20
  const rows = [];
  for (let i = 0; i < 256; i += 8) {
    rows.push('    ' + TABLE.slice(i, i + 8).map((t, j) => '0x' + (t | (LENGTH[i + j] << 16) | (CYCLES[i + j] << 20)).toString(16).toUpperCase().padStart(6, '0') + 'u').join(', '));
  }
  console.log(rows.join(',\n'));
}
