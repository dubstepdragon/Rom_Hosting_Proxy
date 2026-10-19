// Minimal .7z reader: enough to pull one SNES ROM out of a typical archive.
//
// Supports LZMA, LZMA2 and stored (copy) folders with a single coder, solid archives and
// compressed (encoded) headers. Filters (BCJ, delta), encryption and other methods are rejected
// with a clear error. A solid folder is decoded only as far as the end of the wanted file.
//
// The archive is read through a source ({ size, maxRead, read(start, end) }) rather than a whole
// buffer, so an archive too large to download can be read in byte ranges (see proxy.js): only
// the headers and the packed data in front of the wanted file are fetched.
'use strict';

class SevenZipError extends Error {}

// ---------------------------------------------------------------------------------------- LZMA
// A straight port of the reference decoder (LzmaSpec.cpp). Writes into a preallocated output
// buffer, which doubles as the dictionary.

class LzmaDecoder {
  constructor(out) {
    this.out = out;
    this.pos = 0;
    this.dictStart = 0;   // LZMA2 dictionary resets: nothing before this is visible
  }

  setProps(byte) {
    if (byte >= 9 * 5 * 5) throw new SevenZipError('Bad LZMA properties.');
    this.lc = byte % 9; byte = (byte / 9) | 0;
    this.lp = byte % 5;
    this.pb = (byte / 5) | 0;
  }

  resetState() {
    this.literal = new Uint16Array(0x300 << (this.lc + this.lp)).fill(1024);
    this.isMatch = new Uint16Array(12 << 4).fill(1024);
    this.isRep = new Uint16Array(12).fill(1024);
    this.isRepG0 = new Uint16Array(12).fill(1024);
    this.isRepG1 = new Uint16Array(12).fill(1024);
    this.isRepG2 = new Uint16Array(12).fill(1024);
    this.isRep0Long = new Uint16Array(12 << 4).fill(1024);
    this.posSlot = new Uint16Array(4 << 6).fill(1024);
    this.posSpecial = new Uint16Array(115).fill(1024);
    this.align = new Uint16Array(16).fill(1024);
    this.lenDec = newLenProbs();
    this.repLenDec = newLenProbs();
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
  }

  // Range coder over src[start, end)
  initRange(src, start, end) {
    if (end - start < 5 || src[start] !== 0) throw new SevenZipError('Corrupt LZMA stream.');
    this.src = src;
    this.ip = start + 5;
    this.end = end;
    this.range = 0xFFFFFFFF;
    this.code = src.readUInt32BE(start + 1);
  }

  nextByte() {
    if (this.ip >= this.end) throw new SevenZipError('LZMA stream is truncated.');
    return this.src[this.ip++];
  }

  bit(probs, i) {
    const p = probs[i];
    const bound = (this.range >>> 11) * p;
    let b;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = p + ((2048 - p) >> 5);
      b = 0;
    } else {
      this.range -= bound;
      this.code -= bound;
      probs[i] = p - (p >> 5);
      b = 1;
    }
    if (this.range < 0x1000000) {
      this.range *= 256;
      this.code = this.code * 256 + this.nextByte();
    }
    return b;
  }

  directBits(n) {
    let res = 0;
    for (let i = 0; i < n; i++) {
      this.range = this.range >>> 1;
      let b = 0;
      if (this.code >= this.range) { this.code -= this.range; b = 1; }
      res = res * 2 + b;
      if (this.range < 0x1000000) {
        this.range *= 256;
        this.code = this.code * 256 + this.nextByte();
      }
    }
    return res;
  }

  tree(probs, offset, numBits) {
    let m = 1;
    for (let i = 0; i < numBits; i++) m = (m << 1) + this.bit(probs, offset + m);
    return m - (1 << numBits);
  }

  reverseTree(probs, offset, numBits) {
    let m = 1, sym = 0;
    for (let i = 0; i < numBits; i++) {
      const b = this.bit(probs, offset + m);
      m = (m << 1) + b;
      sym |= b << i;
    }
    return sym;
  }

  len(d, posState) {
    if (this.bit(d, 0) === 0) return this.tree(d, LEN_LOW + (posState << 3), 3);
    if (this.bit(d, 1) === 0) return 8 + this.tree(d, LEN_MID + (posState << 3), 3);
    return 16 + this.tree(d, LEN_HIGH, 8);
  }

  distance(len) {
    const lenState = len > 3 ? 3 : len;
    const slot = this.tree(this.posSlot, lenState << 6, 6);
    if (slot < 4) return slot;
    const numDirect = (slot >>> 1) - 1;
    let dist = (2 | (slot & 1)) * 2 ** numDirect;
    if (slot < 14) return dist + this.reverseTree(this.posSpecial, dist - slot, numDirect);
    dist += this.directBits(numDirect - 4) * 16;
    return dist + this.reverseTree(this.align, 0, 4);
  }

  /** Decodes until `limit` bytes of output exist (or an end marker appears). */
  decode(limit) {
    const out = this.out;
    const pbMask = (1 << this.pb) - 1, lpMask = (1 << this.lp) - 1, lc = this.lc;
    while (this.pos < limit) {
      const rel = this.pos - this.dictStart;
      const posState = rel & pbMask;
      let state = this.state;
      if (this.bit(this.isMatch, (state << 4) + posState) === 0) {
        const prev = rel > 0 ? out[this.pos - 1] : 0;
        const base = 0x300 * (((rel & lpMask) << lc) + (prev >> (8 - lc)));
        let sym = 1;
        if (state >= 7) {
          let matchByte = out[this.pos - this.rep0 - 1];
          do {
            const matchBit = (matchByte >> 7) & 1;
            matchByte <<= 1;
            const b = this.bit(this.literal, base + ((1 + matchBit) << 8) + sym);
            sym = (sym << 1) | b;
            if (matchBit !== b) break;
          } while (sym < 0x100);
        }
        while (sym < 0x100) sym = (sym << 1) | this.bit(this.literal, base + sym);
        out[this.pos++] = sym & 0xFF;
        this.state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }
      let len;
      if (this.bit(this.isRep, state) !== 0) {
        if (rel === 0) throw new SevenZipError('Corrupt LZMA stream.');
        if (this.bit(this.isRepG0, state) === 0) {
          if (this.bit(this.isRep0Long, (state << 4) + posState) === 0) {
            this.state = state < 7 ? 9 : 11;
            out[this.pos] = out[this.pos - this.rep0 - 1];
            this.pos++;
            continue;
          }
        } else {
          let dist;
          if (this.bit(this.isRepG1, state) === 0) {
            dist = this.rep1;
          } else {
            if (this.bit(this.isRepG2, state) === 0) {
              dist = this.rep2;
            } else {
              dist = this.rep3;
              this.rep3 = this.rep2;
            }
            this.rep2 = this.rep1;
          }
          this.rep1 = this.rep0;
          this.rep0 = dist;
        }
        len = this.len(this.repLenDec, posState);
        this.state = state < 7 ? 8 : 11;
      } else {
        this.rep3 = this.rep2;
        this.rep2 = this.rep1;
        this.rep1 = this.rep0;
        len = this.len(this.lenDec, posState);
        this.state = state < 7 ? 7 : 10;
        this.rep0 = this.distance(len);
        if (this.rep0 === 0xFFFFFFFF) return;   // end marker
      }
      if (this.rep0 >= this.pos - this.dictStart) throw new SevenZipError('Corrupt LZMA stream.');
      let n = len + 2;
      if (n > limit - this.pos) n = limit - this.pos;
      for (let src = this.pos - this.rep0 - 1; n > 0; n--) out[this.pos++] = out[src++];
    }
  }
}

const LEN_LOW = 2, LEN_MID = LEN_LOW + (16 << 3), LEN_HIGH = LEN_MID + (16 << 3);
function newLenProbs() { return new Uint16Array(LEN_HIGH + 256).fill(1024); }

function lzma(src, props, limit) {
  if (props.length < 5) throw new SevenZipError('Bad LZMA properties.');
  const d = new LzmaDecoder(Buffer.alloc(limit));
  d.setProps(props[0]);
  d.resetState();
  d.initRange(src, 0, src.length);
  d.decode(limit);
  if (d.pos < limit) throw new SevenZipError('LZMA stream ended early.');
  return d.out;
}

function lzma2(src, limit) {
  const d = new LzmaDecoder(Buffer.alloc(limit));
  let p = 0, needProps = true;
  while (d.pos < limit) {
    if (p >= src.length) throw new SevenZipError('LZMA2 stream is truncated.');
    const c = src[p++];
    if (c === 0) break;
    if (c === 1 || c === 2) {                       // stored chunk (1 = dictionary reset)
      if (c === 1) d.dictStart = d.pos;
      const n = src.readUInt16BE(p) + 1; p += 2;
      if (p + n > src.length) throw new SevenZipError('LZMA2 stream is truncated.');
      const take = Math.min(n, limit - d.pos);
      src.copy(d.out, d.pos, p, p + take);
      d.pos += take; p += n;
      continue;
    }
    if (c < 0x80) throw new SevenZipError('Corrupt LZMA2 stream.');
    const unpacked = ((c & 0x1F) << 16) + src.readUInt16BE(p) + 1;
    const packed = src.readUInt16BE(p + 2) + 1;
    p += 4;
    const mode = (c >> 5) & 3;
    if (mode >= 2) { d.setProps(src[p++]); needProps = false; }
    else if (needProps) throw new SevenZipError('Corrupt LZMA2 stream.');
    if (mode === 3) d.dictStart = d.pos;
    if (mode >= 1) d.resetState();
    if (p + packed > src.length) throw new SevenZipError('LZMA2 stream is truncated.');
    d.initRange(src, p, p + packed);
    d.decode(Math.min(limit, d.pos + unpacked));
    p += packed;
  }
  if (d.pos < limit) throw new SevenZipError('LZMA2 stream ended early.');
  return d.out;
}

// ------------------------------------------------------------------------------- 7z container

class Reader {
  constructor(buf) { this.buf = buf; this.p = 0; }
  byte() {
    if (this.p >= this.buf.length) throw new SevenZipError('Corrupt 7z header.');
    return this.buf[this.p++];
  }
  bytes(n) {
    if (this.p + n > this.buf.length) throw new SevenZipError('Corrupt 7z header.');
    const b = this.buf.subarray(this.p, this.p + n); this.p += n; return b;
  }
  num() {
    const first = this.byte();
    let mask = 0x80, value = 0;
    for (let i = 0; i < 8; i++) {
      if ((first & mask) === 0) return value + (first & (mask - 1)) * 2 ** (8 * i);
      value += this.byte() * 2 ** (8 * i);
      mask >>= 1;
    }
    return value;
  }
  bits(n) {
    const v = [];
    let b = 0, mask = 0;
    for (let i = 0; i < n; i++) {
      if (mask === 0) { b = this.byte(); mask = 0x80; }
      v.push((b & mask) !== 0);
      mask >>= 1;
    }
    return v;
  }
  digests(n) {
    const defined = this.byte() ? new Array(n).fill(true) : this.bits(n);
    for (const d of defined) if (d) this.bytes(4);
    return defined;
  }
  expect(id) {
    if (this.byte() !== id) throw new SevenZipError('Unsupported 7z header layout.');
  }
}

function readStreamsInfo(r) {
  const info = { packPos: 0, packSizes: [], folders: [], subSizes: null };
  for (;;) {
    const id = r.byte();
    if (id === 0x00) break;
    if (id === 0x06) {                                // PackInfo
      info.packPos = r.num();
      const n = r.num();
      for (;;) {
        const t = r.byte();
        if (t === 0x00) break;
        if (t === 0x09) for (let i = 0; i < n; i++) info.packSizes.push(r.num());
        else if (t === 0x0A) r.digests(n);
        else throw new SevenZipError('Unsupported 7z header layout.');
      }
    } else if (id === 0x07) {                         // UnPackInfo
      r.expect(0x0B);
      const n = r.num();
      if (r.byte() !== 0) throw new SevenZipError('Unsupported 7z header layout.');
      for (let i = 0; i < n; i++) info.folders.push(readFolder(r));
      r.expect(0x0C);
      for (const f of info.folders) for (let i = 0; i < f.numOut; i++) f.unpackSizes.push(r.num());
      for (;;) {
        const t = r.byte();
        if (t === 0x00) break;
        if (t === 0x0A) r.digests(n);
        else throw new SevenZipError('Unsupported 7z header layout.');
      }
    } else if (id === 0x08) {                         // SubStreamsInfo
      const counts = info.folders.map(() => 1);
      let t = r.byte();
      if (t === 0x0D) { for (let i = 0; i < counts.length; i++) counts[i] = r.num(); t = r.byte(); }
      info.subSizes = info.folders.map((f, i) => {
        const total = f.unpackSizes[f.unpackSizes.length - 1];
        const sizes = [];
        if (counts[i] === 0) return sizes;
        let sum = 0;
        if (t === 0x09) for (let k = 1; k < counts[i]; k++) { const s = r.num(); sizes.push(s); sum += s; }
        sizes.push(total - sum);
        return sizes;
      });
      if (t === 0x09) t = r.byte();
      while (t !== 0x00) {
        if (t !== 0x0A) throw new SevenZipError('Unsupported 7z header layout.');
        r.digests(info.subSizes.reduce((a, s) => a + s.length, 0));
        t = r.byte();
      }
    } else {
      throw new SevenZipError('Unsupported 7z header layout.');
    }
  }
  if (!info.subSizes) info.subSizes = info.folders.map(f => [f.unpackSizes[f.unpackSizes.length - 1]]);
  return info;
}

function readFolder(r) {
  const numCoders = r.num();
  const coders = [];
  let numIn = 0, numOut = 0;
  for (let i = 0; i < numCoders; i++) {
    const flag = r.byte();
    if (flag & 0x80) throw new SevenZipError('Unsupported 7z coder layout.');
    const method = r.bytes(flag & 0x0F).toString('hex');
    let ins = 1, outs = 1;
    if (flag & 0x10) { ins = r.num(); outs = r.num(); }
    const props = flag & 0x20 ? r.bytes(r.num()) : Buffer.alloc(0);
    coders.push({ method, props });
    numIn += ins; numOut += outs;
  }
  for (let i = 0; i < numOut - 1; i++) { r.num(); r.num(); }   // bind pairs
  const numPacked = numIn - (numOut - 1);
  if (numPacked > 1) for (let i = 0; i < numPacked; i++) r.num();
  return { coders, numOut, numPacked, unpackSizes: [] };
}

const METHOD_NAMES = { '00': 'Copy', '030101': 'LZMA', '21': 'LZMA2', '03030103': 'BCJ', '03030205': 'PPC', '03030805': 'SPARC', '0303011b': 'BCJ2', '03': 'Delta', '06f10701': '7zAES (encrypted)',
  '040108': 'Deflate', '040109': 'Deflate64', '040202': 'BZip2', '030401': 'PPMd' };

// Decodes folder `index` of `info` up to `limit` bytes. `source` reads the archive.
async function decodeFolder(source, info, index, limit) {
  const f = info.folders[index];
  if (f.coders.length !== 1) {
    const names = f.coders.map(c => METHOD_NAMES[c.method] || c.method).join(' + ');
    throw new SevenZipError(`This 7z uses ${names}, which the proxy cannot unpack. Repack it as a plain .zip or .7z.`);
  }
  let start = 32 + info.packPos, k = 0;
  for (let i = 0; i < index; i++) for (let j = 0; j < info.folders[i].numPacked; j++) start += info.packSizes[k++];
  const size = info.packSizes[k];
  if (size === undefined || start + size > source.size) throw new SevenZipError('The 7z file is truncated.');
  const { method, props } = f.coders[0];
  if (method !== '00' && method !== '030101' && method !== '21') {
    throw new SevenZipError(`This 7z uses ${METHOD_NAMES[method] || 'method ' + method} compression, which the proxy cannot unpack. Repack it as a .zip or an LZMA/LZMA2 .7z.`);
  }
  // A stored file needs only its own bytes. A compressed one needs the packed data up to the end
  // of the wanted file, which is unknown up front. LZMA hardly ever packs data larger than
  // itself, so first read a little more than `limit`, then as much as the source allows.
  const want = method === '00' ? Math.min(size, limit) : size;
  const most = Math.min(want, source.maxRead);
  for (let take = Math.min(most, limit + (limit >>> 3) + 65536); ; take = most) {
    const src = await source.read(start, start + take);
    try {
      if (method === '00') return Buffer.from(src);
      if (method === '030101') return lzma(src, props, limit);
      return lzma2(src, limit);
    } catch (e) {
      if (!(e instanceof SevenZipError) || take === want) throw e;
      if (take === most) throw new SevenZipError('The ROM is too deep inside this large 7z to unpack. Use a smaller archive, or one with the ROM first.');
    }
  }
}

function readFilesInfo(r) {
  const n = r.num();
  const files = [];
  for (let i = 0; i < n; i++) files.push({ name: '', empty: false });
  for (;;) {
    const type = r.byte();
    if (type === 0x00) break;
    const size = r.num();
    const end = r.p + size;
    if (type === 0x0E) {
      r.bits(n).forEach((e, i) => { files[i].empty = e; });
    } else if (type === 0x11) {
      if (r.byte() !== 0) throw new SevenZipError('Unsupported 7z header layout.');
      for (const f of files) {
        const s = r.p;
        while (r.buf.readUInt16LE(r.p) !== 0) r.p += 2;
        f.name = r.buf.subarray(s, r.p).toString('utf16le');
        r.p += 2;
      }
    }
    r.p = end;
  }
  return files;
}

/**
 * Lists the archive and extracts one file. `pick(names)` returns the index of the wanted name
 * (or -1). Returns { name, data }, or null if nothing was picked, or throws SevenZipError.
 */
async function extract7z(source, pick, maxSize) {
  if (source.size < 32) throw new SevenZipError('The 7z file is truncated.');
  const start = await source.read(0, 32);
  const nextOffset = Number(start.readBigUInt64LE(12));
  const nextSize = Number(start.readBigUInt64LE(20));
  if (nextSize === 0) throw new SevenZipError('The 7z archive is empty.');
  if (32 + nextOffset + nextSize > source.size) throw new SevenZipError('The 7z file is truncated.');
  if (nextSize > 16 * 1024 * 1024) throw new SevenZipError('The 7z header is too large.');
  let header = await source.read(32 + nextOffset, 32 + nextOffset + nextSize);

  for (let guard = 0; header[0] === 0x17 && guard < 4; guard++) {   // encoded header
    const r = new Reader(header);
    r.p = 1;
    const info = readStreamsInfo(r);
    if (!info.folders.length) throw new SevenZipError('Corrupt 7z header.');
    const size = info.folders[0].unpackSizes[0];
    if (size > 16 * 1024 * 1024) throw new SevenZipError('The 7z header is too large.');
    header = await decodeFolder(source, info, 0, size);
  }
  const r = new Reader(header);
  r.expect(0x01);
  let info = null, files = [];
  for (;;) {
    const id = r.byte();
    if (id === 0x00) break;
    if (id === 0x02) {                                // archive properties: skip
      for (;;) { const t = r.byte(); if (t === 0) break; r.bytes(r.num()); }
    } else if (id === 0x04) {
      info = readStreamsInfo(r);
    } else if (id === 0x05) {
      files = readFilesInfo(r);
    } else {
      throw new SevenZipError('Unsupported 7z header layout.');
    }
  }
  if (!info) throw new SevenZipError('The 7z archive is empty.');

  // Map files with data to (folder, offset, size), in order.
  const streams = [];
  for (let fi = 0; fi < info.folders.length; fi++) {
    let offset = 0;
    for (const size of info.subSizes[fi]) { streams.push({ folder: fi, offset, size }); offset += size; }
  }
  const named = [];
  let s = 0;
  for (const f of files) if (!f.empty) named.push({ name: f.name, ...streams[s++] });
  const idx = pick(named.map(e => e.name));
  if (idx < 0) return null;
  const e = named[idx];
  if (!e || e.size === undefined) throw new SevenZipError('Corrupt 7z header.');
  if (e.size > maxSize) throw new SevenZipError('The ROM inside the 7z is too large.');
  if (e.offset + e.size > 64 * 1024 * 1024) throw new SevenZipError('The ROM is too deep inside a large solid 7z. Use a smaller archive.');
  const data = await decodeFolder(source, info, e.folder, e.offset + e.size);
  return { name: e.name, data: Buffer.from(data.subarray(e.offset, e.offset + e.size)) };
}

module.exports = { extract7z, SevenZipError };
