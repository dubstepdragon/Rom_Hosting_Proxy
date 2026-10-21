// Cartridge label art for the packed ROM image (see romimage.js).
//
// The world shows the game's box art on the cartridge it spawns. The proxy looks the game up in the
// libretro thumbnail set (an Apache directory listing of No-Intro named box art PNGs), picks the
// closest name, and scales the picture to LABEL_W x LABEL_H (the face of a SNES cartridge label).
// If nothing matches well enough, or the lookup fails or is slow, it draws a label instead: the
// game's name, kept to letters, numbers and spaces, in a pixel font on a colour picked from the name.
// A label never stops a ROM from loading.
//
// No dependencies: the PNG decoder handles the non-interlaced 8-bit RGB, RGBA, grey and palette
// images the thumbnail set uses (and 1/2/4-bit palettes); anything else falls back to a drawn label.
'use strict';
const zlib = require('zlib');

const LABEL_W = 256;
const LABEL_H = 176;
const LABEL_BYTES = LABEL_W * LABEL_H * 3;

const ART_BASE = 'https://thumbnails.libretro.com/Nintendo%20-%20Super%20Nintendo%20Entertainment%20System/Named_Boxarts/';
const LISTING_TTL_MS = 12 * 3600 * 1000;
const ART_TIMEOUT_MS = Number(process.env.ART_TIMEOUT_MS || 6000);
const MIN_SCORE = 0.72;   // bigram similarity a listed name needs to count as the same game

// ------------------------------------------------------------------ names

/** Turns a file name or ROM header title into a display name: no extension, tags or punctuation runs. */
function cleanName(raw) {
  let s = String(raw || '');
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  s = s.replace(/\.(sfc|smc|swc|fig|bin|zip|7z)$/i, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/_/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** The label text: letters, numbers and spaces only, at most 48 characters (cut at a word). */
function sanitizeName(name) {
  let s = String(name || '').replace(/&/g, ' and ').replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > 48) s = s.slice(0, 49).replace(/\s*\S*$/, '') || s.slice(0, 48);
  return s;
}

function compact(name) {
  return cleanName(name).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
}

function bigrams(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i++) { const g = s.substr(i, 2); m.set(g, (m.get(g) || 0) + 1); }
  return m;
}

// Sorensen-Dice similarity of two compacted names (1 = identical).
function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ga = bigrams(a), gb = bigrams(b);
  let common = 0;
  for (const [g, n] of ga) common += Math.min(n, gb.get(g) || 0);
  return (2 * common) / (a.length - 1 + b.length - 1);
}

// Prefers the region the source file names (if any), then USA, World, Europe, Japan; avoids betas and the like.
function regionScore(listed, wantRegion) {
  const tags = (listed.match(/\(([^)]*)\)/g) || []).join(' ').toLowerCase();
  let s = 0;
  if (wantRegion && tags.includes(wantRegion)) s += 0.05;
  if (tags.includes('usa')) s += 0.04;
  else if (tags.includes('world')) s += 0.03;
  else if (tags.includes('europe')) s += 0.02;
  else if (tags.includes('japan')) s += 0.01;
  if (/beta|proto|sample|demo|unl|pirate|kiosk/.test(tags)) s -= 0.06;
  if (/virtual console|switch online|collection/.test(tags)) s -= 0.02;   // re-releases, when the original is listed too
  return s;
}

function regionOf(raw) {
  const m = /\((usa|world|europe|japan)[^)]*\)/i.exec(String(raw || ''));
  return m ? m[1].toLowerCase() : '';
}

// ------------------------------------------------------------------ box art lookup

let listing = null;   // { names: [{ file, key }], at }

async function fetchWithTimeout(url, ms) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'vrchat-snes-rom-proxy/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res;
}

async function boxartListing(ms) {
  if (listing && Date.now() - listing.at < LISTING_TTL_MS) return listing.names;
  const html = await (await fetchWithTimeout(ART_BASE, ms)).text();
  const names = [];
  for (const m of html.matchAll(/href="([^"?/][^"]*\.png)"/gi)) {
    let file;
    try { file = decodeURIComponent(m[1].replace(/&amp;/g, '&')); } catch { continue; }
    names.push({ file, key: compact(file.replace(/\.png$/i, '')) });
  }
  if (!names.length) throw new Error('the box art listing had no images');
  listing = { names, at: Date.now() };
  return names;
}

/** The listed box art file that best matches one of `candidates` (raw names), or null. */
function bestMatch(names, candidates) {
  let best = null, bestScore = 0;
  for (const raw of candidates) {
    const key = compact(raw);
    if (key.length < 3) continue;
    const want = regionOf(raw);
    for (const n of names) {
      const sim = similarity(key, n.key);
      if (sim < MIN_SCORE) continue;
      const score = sim + regionScore(n.file, want);
      if (score > bestScore) { best = n.file; bestScore = score; }
    }
  }
  return best;
}

// ------------------------------------------------------------------ PNG decoding

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes a PNG to { width, height, rgba }. Throws on formats it does not handle. */
function decodePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504E47) throw new Error('not a PNG');
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  for (let p = 8; p + 8 <= buf.length;) {
    const len = buf.readUInt32BE(p);
    const kind = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; type = data[9]; interlace = data[12];
    } else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    p += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels || interlace || !width || !height || width * height > 16e6) throw new Error('unsupported PNG layout');
  if (type === 3 ? ![1, 2, 4, 8].includes(depth) : depth !== 8) throw new Error(`unsupported PNG depth ${depth}`);
  if (type === 3 && !palette) throw new Error('palette PNG without a palette');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil((width * channels * depth) / 8);
  if (raw.length < (stride + 1) * height) throw new Error('truncated PNG data');
  const cur = Buffer.alloc(stride), prev = Buffer.alloc(stride);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      const x = line[i];
      cur[i] = (f === 0 ? x : f === 1 ? x + a : f === 2 ? x + b : f === 3 ? x + ((a + b) >> 1) : x + paeth(a, b, c)) & 0xFF;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (type === 3) {
        const bit = x * depth;
        const idx = (cur[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        rgba[o] = palette[idx * 3] || 0; rgba[o + 1] = palette[idx * 3 + 1] || 0; rgba[o + 2] = palette[idx * 3 + 2] || 0;
        rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else {
        const s = x * channels;
        const g = cur[s];
        if (type === 0) { rgba[o] = rgba[o + 1] = rgba[o + 2] = g; rgba[o + 3] = 255; }
        else if (type === 4) { rgba[o] = rgba[o + 1] = rgba[o + 2] = g; rgba[o + 3] = cur[s + 1]; }
        else { rgba[o] = g; rgba[o + 1] = cur[s + 1]; rgba[o + 2] = cur[s + 2]; rgba[o + 3] = type === 6 ? cur[s + 3] : 255; }
      }
    }
    cur.copy(prev);
  }
  return { width, height, rgba };
}

/** Scales an image to fill LABEL_W x LABEL_H (cropping the longer side, centred) by box averaging. */
function fitLabel({ width, height, rgba }) {
  const aspect = LABEL_W / LABEL_H;
  let cw = width, ch = height;
  if (width / height > aspect) cw = height * aspect; else ch = width / aspect;
  const x0 = (width - cw) / 2, y0 = (height - ch) / 2;
  const out = Buffer.alloc(LABEL_BYTES);
  for (let ty = 0; ty < LABEL_H; ty++) {
    const sy0 = Math.floor(y0 + (ty * ch) / LABEL_H), sy1 = Math.max(sy0 + 1, Math.floor(y0 + ((ty + 1) * ch) / LABEL_H));
    for (let tx = 0; tx < LABEL_W; tx++) {
      const sx0 = Math.floor(x0 + (tx * cw) / LABEL_W), sx1 = Math.max(sx0 + 1, Math.floor(x0 + ((tx + 1) * cw) / LABEL_W));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1 && sy < height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < width; sx++) {
          const o = (sy * width + sx) * 4, a = rgba[o + 3] / 255;
          r += rgba[o] * a; g += rgba[o + 1] * a; b += rgba[o + 2] * a; n++;   // transparent parts go black
        }
      }
      const o = (ty * LABEL_W + tx) * 3;
      out[o] = Math.round(r / Math.max(n, 1)); out[o + 1] = Math.round(g / Math.max(n, 1)); out[o + 2] = Math.round(b / Math.max(n, 1));
    }
  }
  return out;
}

// ------------------------------------------------------------------ drawn label

// 5x7 pixel font, rows top to bottom, for the characters sanitizeName keeps.
const FONT = {
  A: '01110 10001 10001 11111 10001 10001 10001', B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110', D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111', F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111', H: '10001 10001 10001 11111 10001 10001 10001',
  I: '01110 00100 00100 00100 00100 00100 01110', J: '00111 00010 00010 00010 00010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001', L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001', N: '10001 10001 11001 10101 10011 10001 10001',
  O: '01110 10001 10001 10001 10001 10001 01110', P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101', R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110', T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110', V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 10101 01010', X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100', Z: '11111 00001 00010 00100 01000 10000 11111',
  0: '01110 10001 10011 10101 11001 10001 01110', 1: '00100 01100 00100 00100 00100 00100 01110',
  2: '01110 10001 00001 00010 00100 01000 11111', 3: '11111 00010 00100 00010 00001 10001 01110',
  4: '00010 00110 01010 10010 11111 00010 00010', 5: '11111 10000 11110 00001 00001 10001 01110',
  6: '00110 01000 10000 11110 10001 10001 01110', 7: '11111 00001 00010 00100 01000 01000 01000',
  8: '01110 10001 10001 01110 10001 10001 01110', 9: '01110 10001 10001 01111 00001 00010 01100',
};

function hsl(h, s, l) {
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

// Splits words into lines of at most `max` characters. A word longer than that is broken up, and
// the returned array's `split` is then true.
function wrap(words, max) {
  const lines = [];
  lines.split = false;
  let line = '';
  for (let w of words) {
    while (w.length > max) { if (line) { lines.push(line); line = ''; } lines.push(w.slice(0, max)); w = w.slice(max); lines.split = true; }
    if (!w) continue;
    if (!line) line = w;
    else if (line.length + 1 + w.length <= max) line += ' ' + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

/** Draws a label with the game's name, sized to fit the label face. */
function drawNameLabel(name) {
  const text = (sanitizeName(name) || 'UNKNOWN GAME').toUpperCase();
  let hash = 2166136261;
  for (const ch of text) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  const hue = hash % 360;
  const top = hsl(hue, 0.55, 0.42), bottom = hsl(hue, 0.6, 0.18);
  const out = Buffer.alloc(LABEL_BYTES);
  const put = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= LABEL_W || y >= LABEL_H) return;
    const o = (y * LABEL_W + x) * 3; out[o] = r; out[o + 1] = g; out[o + 2] = b;
  };
  for (let y = 0; y < LABEL_H; y++) {
    const t = y / (LABEL_H - 1);
    const c = top.map((v, i) => Math.round(v + (bottom[i] - v) * t));
    for (let x = 0; x < LABEL_W; x++) put(x, y, c);
  }
  // A dark band along the top with four button-coloured dots, like the console's controller.
  const band = 22;
  for (let y = 0; y < band; y++) for (let x = 0; x < LABEL_W; x++) put(x, y, [28, 28, 34]);
  [[200, 40, 50], [235, 190, 40], [40, 160, 80], [50, 90, 200]].forEach((c, i) => {
    const cx = LABEL_W - 74 + i * 16, cy = band / 2;
    for (let y = -5; y <= 5; y++) for (let x = -5; x <= 5; x++) if (x * x + y * y <= 25) put(cx + x, cy + y, c);
  });

  // The largest pixel scale at which the wrapped name fits under the band without breaking a word.
  const margin = 12, areaW = LABEL_W - 2 * margin, areaH = LABEL_H - band - 2 * margin;
  const words = text.split(' ');
  let scale = 1, lines = wrap(words, Math.floor((areaW + 1) / 6));
  for (let s = 5; s >= 1; s--) {
    const l = wrap(words, Math.floor((areaW / s + 1) / 6));
    if ((!l.split || s === 1) && l.length * 9 * s - 2 * s <= areaH && l.every(x => x.length * 6 * s - s <= areaW)) { scale = s; lines = l; break; }
  }
  const lineH = 9 * scale;
  let y0 = band + margin + Math.floor((areaH - (lines.length * lineH - 2 * scale)) / 2);
  for (const line of lines) {
    const w = line.length * 6 * scale - scale;
    let x0 = Math.floor((LABEL_W - w) / 2);
    for (const ch of line) {
      const rows = FONT[ch] ? FONT[ch].split(' ') : null;
      if (rows) {
        for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
          if (rows[r][c] !== '1') continue;
          for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
            put(x0 + c * scale + dx + Math.max(1, scale >> 1), y0 + r * scale + dy + Math.max(1, scale >> 1), [10, 10, 14]);   // shadow
            put(x0 + c * scale + dx, y0 + r * scale + dy, [250, 250, 245]);
          }
        }
      }
      x0 += 6 * scale;
    }
    y0 += lineH;
  }
  return out;
}

// ------------------------------------------------------------------ entry point

/**
 * Label art for a ROM: { rgb (LABEL_BYTES, rows top to bottom), source: 'boxart' | 'drawn', name }.
 * `fileName` is the ROM's file name (or the link's), `title` the ROM header's title. Never throws.
 */
async function labelFor({ fileName, title }) {
  const name = cleanName(fileName) || cleanName(title);
  const deadline = Date.now() + ART_TIMEOUT_MS;
  try {
    const names = await boxartListing(ART_TIMEOUT_MS);
    const file = bestMatch(names, [fileName, title].filter(Boolean));
    if (file) {
      const left = deadline - Date.now();
      if (left < 500) throw new Error('out of time for the box art download');
      const png = Buffer.from(await (await fetchWithTimeout(ART_BASE + encodeURIComponent(file), left)).arrayBuffer());
      return { rgb: fitLabel(decodePng(png)), source: 'boxart', name: file.replace(/\.png$/i, '') };
    }
  } catch (e) {
    console.warn(`[art] ${name || '(untitled)'}: ${e.message}; drawing a label`);
  }
  return { rgb: drawNameLabel(name), source: 'drawn', name: sanitizeName(name) };
}

module.exports = { labelFor, drawNameLabel, decodePng, fitLabel, cleanName, sanitizeName, similarity, bestMatch, LABEL_W, LABEL_H, LABEL_BYTES };
