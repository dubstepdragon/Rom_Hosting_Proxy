// Builds a tiny self-checking LoROM homebrew used by the GPU test (Assets/SNES/Editor/SnesGpuTest.cs).
// The CPU section stores known results in WRAM $0100-$010F; the video section draws a tiled BG1
// that scrolls every NMI plus one white sprite; NMI copies the joypad to $0202/$0203.
// Run: node Tools/make_test_rom.js   -> Tools/test/snestest.sfc and Tools/test/snestest.png
'use strict';
const fs = require('fs');
const path = require('path');
const { parseRom, encodePng } = require('./rom-proxy/romimage');

const rom = Buffer.alloc(0x8000, 0xFF);
let pc = 0;                 // offset in rom (bank 0, address = 0x8000 + pc)
const labels = {}, fixups = [];
const addr = () => 0x8000 + pc;
const b = (...xs) => { for (const x of xs) rom[pc++] = x & 0xFF; };
const w = (v) => b(v, v >> 8);
const label = (n) => { labels[n] = addr(); };
const rel = (op, n) => { b(op, 0); fixups.push({ at: pc - 1, n, kind: 'rel' }); };
const abs = (op, n) => { b(op, 0, 0); fixups.push({ at: pc - 2, n, kind: 'abs' }); };

// --- reset
label('reset');
b(0x78);                    // sei
b(0x18, 0xFB);              // clc ; xce   -> native mode
b(0xC2, 0x30);              // rep #$30
b(0xA2); w(0x1FFF); b(0x9A);// ldx #$1FFF ; txs
b(0xE2, 0x20);              // sep #$20 (A 8-bit, X/Y 16-bit)
b(0xA9, 0x80, 0x8D); w(0x2100);   // forced blank

// T1 binary ADC + overflow flag
b(0x18, 0xA9, 0x7F, 0x69, 0x01);  // clc ; lda #$7F ; adc #$01
b(0x8D); w(0x0100);               // sta $0100   -> $80
b(0x08, 0x68, 0x8D); w(0x0101);   // php ; pla ; sta $0101 -> P (N V M set, X 0 -> $E0)
// T2 decimal ADC
b(0xF8, 0x18, 0xA9, 0x19, 0x69, 0x28, 0xD8);  // sed ; clc ; lda #$19 ; adc #$28 ; cld
b(0x8D); w(0x0102);               // -> $47
// T3 16-bit ADC
b(0xC2, 0x20, 0xA9); w(0x1234); b(0x18, 0x69); w(0x4321);  // rep #$20 ; lda #$1234 ; clc ; adc #$4321
b(0x8D); w(0x0103);               // -> $5555 at $0103/$0104
b(0xE2, 0x20);                    // sep #$20
// T4 hardware multiply 13*11 = 143
b(0xA9, 0x0D, 0x8D); w(0x4202); b(0xA9, 0x0B, 0x8D); w(0x4203);
b(0xEA, 0xEA, 0xEA, 0xEA, 0xAD); w(0x4216); b(0x8D); w(0x0105);
// T5 hardware divide 1000/7 = 142 r 6
b(0xC2, 0x20, 0xA9); w(1000); b(0x8D); w(0x4204); b(0xE2, 0x20);
b(0xA9, 0x07, 0x8D); w(0x4206);
b(0xEA, 0xEA, 0xEA, 0xEA, 0xEA, 0xEA, 0xEA, 0xEA);
b(0xAD); w(0x4214); b(0x8D); w(0x0106);
b(0xAD); w(0x4216); b(0x8D); w(0x0107);
// T6 MVN: copy 4 bytes of `table` to $0110
b(0xC2, 0x30, 0xA9); w(0x0003);   // rep #$30 ; lda #3
abs(0xA2, 'table');               // ldx #table (16-bit immediate)
b(0xA0); w(0x0110);               // ldy #$0110
b(0x54, 0x00, 0x00);              // mvn $00,$00
b(0xE2, 0x20);                    // sep #$20
// T7 JSR/RTS
abs(0x20, 'sub');
// T8 decimal SBC 42-15 = 27
b(0xF8, 0x38, 0xA9, 0x42, 0xE9, 0x15, 0xD8, 0x8D); w(0x0109);
// T9 loop: 5 * 3 = 15
b(0xE2, 0x10, 0xA2, 0x05, 0xA9, 0x00);   // sep #$10 ; ldx #5 ; lda #0
label('loop');
b(0x18, 0x69, 0x03, 0xCA); rel(0xD0, 'loop');  // clc ; adc #3 ; dex ; bne loop
b(0x8D); w(0x010A);
// T10 (dp),Y: pointer at $20 -> $0110, y=2 -> table[2] = $CC
b(0xA9, 0x10, 0x85, 0x20, 0xA9, 0x01, 0x85, 0x21, 0xA0, 0x02, 0xB1, 0x20, 0x8D); w(0x010B);
// T11 long addressing through bank $7F
b(0xA9, 0x77, 0x8F, 0x00, 0x00, 0x7F);   // sta $7F0000
b(0xA9, 0x00, 0xAF, 0x00, 0x00, 0x7F);   // lda #0 ; lda $7F0000
b(0x8D); w(0x010C);
// T12 ROR through carry: sec ; lda #$02 ; ror a -> $81, C=0
b(0x38, 0xA9, 0x02, 0x6A, 0x8D); w(0x010D);
b(0xC2, 0x10);                           // rep #$10 (X/Y 16-bit again)

// --- video setup
b(0xA9, 0x00, 0x8D); w(0x2105);         // BGMODE 0
b(0xA9, 0x04, 0x8D); w(0x2107);         // BG1SC: map at word $0400
b(0xA9, 0x00, 0x8D); w(0x210B);         // BG12NBA: chars at $0000
b(0xA9, 0x01, 0x8D); w(0x2101);         // OBSEL: 8x8/16x16, name base word $2000
b(0xA9, 0x80, 0x8D); w(0x2115);         // VMAIN: increment after $2119
// tile 1 (2bpp) via DMA channel 0, mode 1 -> $2118/$2119
b(0xA2); w(0x0008); b(0x8E); w(0x2116); // VMADD = $0008
b(0xA9, 0x01, 0x8D); w(0x4300);         // DMAP0 mode 1
b(0xA9, 0x18, 0x8D); w(0x4301);         // BBAD0 = $18
abs(0xA2, 'tile'); b(0x8E); w(0x4302);  // A1T0 = tile
b(0xA9, 0x00, 0x8D); w(0x4304);         // bank 0
b(0xA2); w(16); b(0x8E); w(0x4305);     // DAS0 = 16
b(0xA9, 0x01, 0x8D); w(0x420B);         // MDMAEN
// tilemap: 32x32 entries of tile 1 (palette 0), written by the CPU
b(0xA2); w(0x0400); b(0x8E); w(0x2116);
b(0xC2, 0x20, 0xA0); w(0x0400);          // rep #$20 ; ldy #$400
label('maploop');
b(0xA9); w(0x0001); b(0x8D); w(0x2118); // lda #$0001 ; sta $2118 (16-bit store)
b(0x88); rel(0xD0, 'maploop');           // dey ; bne
// sprite tile 0 at word $2000: 16 words of $FFFF (4bpp colour 15)
b(0xA2); w(0x2000); b(0x8E); w(0x2116);
b(0xA0); w(16);
label('sprloop');
b(0xA9); w(0xFFFF); b(0x8D); w(0x2118); b(0x88); rel(0xD0, 'sprloop');
b(0xE2, 0x20);                          // sep #$20
// palette
b(0x9C); w(0x2121);                     // stz $2121
b(0xA2); w(0);
label('palloop');
abs(0xBD, 'pal');                       // lda pal,x
b(0x8D); w(0x2122, 0); b(0xE8, 0xE0); w(8); rel(0xD0, 'palloop');
// sprite palette colour 143 = white
b(0xA9, 0x8F, 0x8D); w(0x2121); b(0xA9, 0xFF, 0x8D); w(0x2122); b(0xA9, 0x7F, 0x8D); w(0x2122);
// OAM: sprite 0 at (120,100) tile 0 prio 3; others parked off-screen (y=240)
b(0x9C); w(0x2102); b(0x9C); w(0x2103);
b(0xA9, 120, 0x8D); w(0x2104); b(0xA9, 100, 0x8D); w(0x2104);
b(0xA9, 0x00, 0x8D); w(0x2104); b(0xA9, 0x30, 0x8D); w(0x2104);
b(0xA2); w(127);
label('oamloop');
b(0xA9, 0x00, 0x8D); w(0x2104); b(0xA9, 240, 0x8D); w(0x2104);
b(0xA9, 0x00, 0x8D); w(0x2104); b(0xA9, 0x00, 0x8D); w(0x2104);
b(0xCA); rel(0xD0, 'oamloop');
b(0xA2); w(32);
label('oamhi');
b(0x9C); w(0x2104); b(0xCA); rel(0xD0, 'oamhi');
b(0xA9, 0x11, 0x8D); w(0x212C);         // TM: BG1 + OBJ
b(0xA9, 0x5A, 0x8D); w(0x01FF);         // "setup done" marker
b(0xA9, 0x81, 0x8D); w(0x4200);         // NMI + auto joypad
b(0xA9, 0x0F, 0x8D); w(0x2100);         // screen on, full brightness
label('main');
b(0xCB); rel(0x80, 'main');              // wai ; bra main

// --- subroutine for T7
label('sub');
b(0xA9, 0xAB, 0x8D); w(0x0108); b(0x60);

// --- NMI: frame counter, horizontal scroll, joypad copy
label('nmi');
b(0xC2, 0x20, 0x48);                    // rep #$20 ; pha
b(0xEE); w(0x0200);                     // inc $0200 (16-bit)
b(0xAD); w(0x0200);
b(0xE2, 0x20);                          // sep #$20
b(0x8D); w(0x210D); b(0x9C); w(0x210D); // BG1HOFS = counter low, 0
b(0xAD); w(0x4218); b(0x8D); w(0x0202);
b(0xAD); w(0x4219); b(0x8D); w(0x0203);
b(0xAD); w(0x4210);                     // acknowledge NMI
b(0xC2, 0x20, 0x68, 0xE2, 0x20);        // rep #$20 ; pla ; sep #$20
b(0x40);                                // rti

// --- data
label('table'); b(0xAA, 0xBB, 0xCC, 0xDD);
label('tile');  // 2bpp checkerboard using colours 1..3
for (let y = 0; y < 8; y++) b(y & 1 ? 0x55 : 0xAA, y < 4 ? 0xF0 : 0x0F);
label('pal');   // BGR555: dark blue, red, green, yellow
w(0x2800); w(0x001F); w(0x03E0); w(0x03FF);

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

// --- header at $7FC0
Buffer.from('GPU SNES SELF TEST   ', 'ascii').copy(rom, 0x7FC0);
rom[0x7FD5] = 0x20; rom[0x7FD6] = 0x00; rom[0x7FD7] = 0x08; rom[0x7FD8] = 0x00;
rom[0x7FD9] = 0x01; rom[0x7FDA] = 0x00; rom[0x7FDB] = 0x00;
const vec = (o, v) => { rom[o] = v & 0xFF; rom[o + 1] = v >> 8; };
vec(0x7FEA, labels.nmi);     // native NMI
vec(0x7FFC, labels.reset);   // emulation reset
vec(0x7FFA, labels.nmi);
// checksum
rom[0x7FDC] = 0; rom[0x7FDD] = 0; rom[0x7FDE] = 0; rom[0x7FDF] = 0;
let sum = 0; for (const v of rom) sum = (sum + v) & 0xFFFF;
sum = (sum + 0x1FE) & 0xFFFF;   // complement + checksum bytes contribute 0x1FE
vec(0x7FDE, sum); vec(0x7FDC, sum ^ 0xFFFF);

const outDir = path.join(__dirname, 'test');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'snestest.sfc'), rom);
fs.writeFileSync(path.join(outDir, 'snestest.png'), encodePng(parseRom(rom)));
console.log('labels', Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, v.toString(16)])));
console.log('wrote', outDir);
