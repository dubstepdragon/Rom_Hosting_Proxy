// SNES ROM -> PNG packing shared by the proxy server and the offline converter.
//
// VRChat can only download images (VRCImageDownloader) or text, so ROMs travel as a lossless
// PNG: RGB, 2048 pixels wide, 3 bytes per pixel, read row-major from the top-left.
//   bytes 0-2  'S','N','S'           bytes 3-5  ROM length (little endian)
//   byte 6     flags (bit1 = HiROM)  byte 7     SRAM size code (log2(KB)+1, 0 = none)
//   bytes 8-47 reserved (title in 8-28 for debugging)
//   bytes 48+  ROM data
// Must match Assets/SNES/Shaders/SnesRomDecode.shader.
'use strict';
const zlib = require('zlib');

const WIDTH = 2048;
const DATA_OFFSET = 48;
const MAX_ROM = 2048 * 1023 * 4;          // ROM texture capacity
const MAX_IMAGE_BYTES = 2048 * 2048 * 3;  // VRChat image size limit

class RomError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const CHIPS = { 0x03: 'DSP', 0x13: 'SuperFX', 0x14: 'SuperFX', 0x15: 'SuperFX', 0x1A: 'SuperFX',
  0x23: 'OBC1', 0x33: 'SA-1', 0x34: 'SA-1', 0x35: 'SA-1', 0x43: 'S-DD1', 0x45: 'S-DD1', 0x55: 'S-RTC',
  0xE3: 'Super Game Boy', 0xF3: 'Cx4', 0xF5: 'SPC7110 / ST018', 0xF6: 'ST010/011', 0xF9: 'SPC7110' };

function scoreHeader(rom, base, hiExpected) {
  if (rom.length < base + 0x40) return -100;
  let score = 0;
  const map = rom[base + 0x15];
  const chk = rom[base + 0x1E] | (rom[base + 0x1F] << 8);
  const cmp = rom[base + 0x1C] | (rom[base + 0x1D] << 8);
  const reset = rom[base + 0x3C] | (rom[base + 0x3D] << 8);
  if ((chk ^ cmp) === 0xFFFF) score += 4;
  if (((map & 1) === 1) === hiExpected && (map & 0xE0) === 0x20) score += 2;
  if (reset >= 0x8000) score += 2; else score -= 4;
  let ascii = 0;
  for (let i = 0; i < 21; i++) { const c = rom[base + i]; if (c >= 0x20 && c < 0x7F) ascii++; }
  if (ascii >= 18) score += 1;
  const op = rom[(base & ~0xFFFF) + (reset & (hiExpected ? 0xFFFF : 0x7FFF))];
  if ([0x78, 0x18, 0x38, 0x9C, 0x4C, 0x5C, 0xC2, 0xE2, 0xAD, 0xAE, 0xAC, 0xAF, 0xA9, 0xA2, 0xA0, 0x20, 0x22].includes(op)) score += 1;
  return score;
}

/** Validates a raw ROM and returns { rom, hirom, sramCode, title }. Throws RomError. */
function parseRom(buf) {
  let rom = buf;
  if (rom.length % 1024 === 512) rom = rom.subarray(512);   // copier header
  if (rom.length < 0x8000) throw new RomError(422, 'File is too small to be a SNES ROM.');
  if (rom.length > MAX_ROM) throw new RomError(422, `ROM is ${(rom.length / 1048576).toFixed(1)} MB; the emulator supports up to 8 MB.`);
  const lo = scoreHeader(rom, 0x7FC0, false);
  const hi = scoreHeader(rom, 0xFFC0, true);
  if (Math.max(lo, hi) < 2) throw new RomError(422, 'No valid SNES header found - this does not look like a SNES ROM.');
  const hirom = hi > lo;
  const base = hirom ? 0xFFC0 : 0x7FC0;
  const type = rom[base + 0x16];
  if (CHIPS[type]) throw new RomError(422, `This game needs the ${CHIPS[type]} enhancement chip, which the emulator does not support.`);
  if (rom[base + 0x15] === 0x25 || rom[base + 0x15] === 0x35) throw new RomError(422, 'ExHiROM cartridges are not supported.');
  const ramSize = rom[base + 0x18];
  const sramCode = ramSize === 0 || ramSize > 5 ? (ramSize > 5 ? 6 : 0) : ramSize + 1;   // cap at 32 KB
  const title = Buffer.from(rom.subarray(base, base + 21)).toString('latin1').replace(/[^\x20-\x7E]/g, '').trim();
  return { rom, hirom, sramCode, title };
}

/** Pulls the first SNES ROM out of a .zip (stored or deflated entries). */
function extractZip(buf) {
  // Find the end of central directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new RomError(422, 'Corrupt zip file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new RomError(422, 'Corrupt zip directory.');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    entries.push({ method, csize, usize, local, name });
    p += 46 + nlen + xlen + clen;
  }
  const rom = entries.find(e => /\.(sfc|smc|swc|fig|bin)$/i.test(e.name)) ;
  if (!rom) throw new RomError(422, 'The zip does not contain a .sfc/.smc ROM.');
  if (rom.usize > MAX_ROM + 512) throw new RomError(422, 'ROM inside the zip is too large.');
  const lp = rom.local;
  if (buf.readUInt32LE(lp) !== 0x04034b50) throw new RomError(422, 'Corrupt zip entry.');
  const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
  const data = buf.subarray(start, start + rom.csize);
  if (rom.method === 0) return Buffer.from(data);
  if (rom.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ROM + 1024 });
  throw new RomError(422, `Unsupported zip compression method ${rom.method}.`);
}

/** Accepts a raw ROM or a zip and returns the parsed ROM. */
function loadRomFile(buf) {
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) buf = extractZip(buf);
  const head = buf.subarray(0, 64).toString('latin1').toLowerCase();
  if (head.includes('<!doctype') || head.includes('<html')) {
    throw new RomError(422, 'The link returned a web page, not a file. Use a direct download link to the ROM file.');
  }
  return parseRom(buf);
}

function crc32(buf) { return zlib.crc32(buf) >>> 0; }

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Packs a parsed ROM into the PNG layout described above. */
function encodePng({ rom, hirom, sramCode, title }) {
  const total = DATA_OFFSET + rom.length;
  const height = Math.ceil(total / (WIDTH * 3));
  if (WIDTH * height * 3 > MAX_IMAGE_BYTES) throw new RomError(422, 'ROM too large for a 2048x2048 image.');
  const payload = Buffer.alloc(WIDTH * height * 3);
  payload.write('SNS', 0, 'ascii');
  payload[3] = rom.length & 0xFF; payload[4] = (rom.length >> 8) & 0xFF; payload[5] = (rom.length >> 16) & 0xFF;
  payload[6] = hirom ? 2 : 0;
  payload[7] = sramCode;
  Buffer.from((title || '').slice(0, 21), 'latin1').copy(payload, 8);
  rom.copy ? rom.copy(payload, DATA_OFFSET) : payload.set(rom, DATA_OFFSET);

  const stride = WIDTH * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;   // filter: none
    payload.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { RomError, loadRomFile, parseRom, encodePng, MAX_ROM };
