// ROM proxy request handling for the VRChat SNES emulator, shared by server.js (standalone Node)
// and api/ (Vercel serverless functions).
//
//   GET /rom.png?url=<direct link to a .sfc/.smc/.zip/.7z>  -> PNG-packed ROM (see romimage.js)
//       X-Rom-Sha1: the ROM's SHA-1; X-Rom-Link: (URI-encoded) the first link this ROM was loaded
//       from, which differs from ?url= when the ROM is already known (see registry.js); X-Rom-Art:
//       where the cartridge label came from, "boxart:<matched name>" or "drawn:<name>" (URI-encoded,
//       see coverart.js)
//   GET /health                                         -> "ok"
//
// A .7z larger than MAX_DOWNLOAD_MB isn't downloaded whole: if its host serves byte ranges, only
// the headers and the data in front of the first .smc are fetched (see sevenzip.js).
//
// Converted ROMs are kept in memory, up to CACHE_MB. A new ROM that would take the cache past 80%
// of that first evicts the ROMs that have gone longest without being requested.
//
// Errors come back as non-200 responses so VRChat's image downloader reports a failure and the
// emulator returns to a state where another link can be loaded.
//
// MAX_DOWNLOAD_MB, FETCH_TIMEOUT_MS, ALLOWED_HOSTS and CACHE_MB env vars are optional, as are the
// registry's KV_REST_API_URL / KV_REST_API_TOKEN.
'use strict';
const dns = require('dns').promises;
const net = require('net');
const { RomError, loadRomFile, load7zSource, is7z, encodePng } = require('./romimage');
const { romHash, firstLinkFor, replaceLink } = require('./registry');
const { labelFor } = require('./coverart');

const MAX_DOWNLOAD = Number(process.env.MAX_DOWNLOAD_MB || 16) * 1024 * 1024;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 25000);
// Optional allow-list of source hosts, comma separated (e.g. "example.org,cdn.example.org").
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const CACHE_BYTES = Number(process.env.CACHE_MB || 256) * 1024 * 1024;
const CACHE_HIGH_WATER = 0.8;
// Lets the GitHub Pages link builder (docs/) test links through this proxy and read its errors
// and registry headers.
const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-rom-sha1, x-rom-link, x-rom-art' };

const cache = new Map();   // url -> { png, hash, link, art, at }, least recently requested first
let cacheBytes = 0;

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.');
}

async function checkTarget(urlString) {
  let u;
  try { u = new URL(urlString); } catch { throw new RomError(400, 'That is not a valid URL.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new RomError(400, 'Only http(s) links are supported.');
  const host = u.hostname.toLowerCase();
  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h))) {
    throw new RomError(403, `Downloads from ${host} are not allowed by this proxy.`);
  }
  const addrs = await dns.lookup(host, { all: true }).catch(() => { throw new RomError(502, `Could not resolve ${host}.`); });
  if (addrs.some(a => isPrivateAddress(a.address))) throw new RomError(403, 'That address is not reachable through the proxy.');
  return u;
}

// Follows redirects (checking every hop) and returns the final OK response. The caller must
// clearTimeout(timer) once it has read or cancelled the body.
async function open(urlString, headers = {}) {
  let current = urlString;
  for (let hop = 0; hop < 5; hop++) {
    await checkTarget(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current, { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': 'vrchat-snes-rom-proxy/1.0', ...headers } });
    } catch (e) {
      clearTimeout(timer);
      throw new RomError(504, e.name === 'AbortError' ? 'The ROM download timed out.' : `Could not download the ROM (${e.message}).`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(timer);
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    if (!res.ok) { clearTimeout(timer); throw new RomError(502, `The ROM host answered HTTP ${res.status}.`); }
    return { res, timer };
  }
  throw new RomError(508, 'Too many redirects.');
}

async function download(urlString) {
  const { res, timer } = await open(urlString);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_DOWNLOAD) {
    clearTimeout(timer);
    res.body?.cancel().catch(() => {});
    throw new RomError(413, 'The file is too large.');
  }
  return readBody(res, timer, MAX_DOWNLOAD);
}

async function readBody(res, timer, max) {
  const parts = [];
  let size = 0;
  try {
    for await (const part of res.body) {
      size += part.length;
      if (size > max) throw new RomError(413, 'The file is too large.');
      parts.push(part);
    }
  } finally { clearTimeout(timer); }
  return Buffer.concat(parts.map(p => Buffer.from(p)));
}

// Fetches bytes [start, end) of a remote file. Returns { data, total }, or null if the host
// ignores the Range header.
async function fetchRange(urlString, start, end) {
  const { res, timer } = await open(urlString, { range: `bytes=${start}-${end - 1}` });
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') || '');
  if (res.status !== 206 || !m || Number(m[1]) !== start) {
    clearTimeout(timer);
    res.body?.cancel().catch(() => {});
    return null;
  }
  const data = await readBody(res, timer, end - start);
  if (data.length !== Math.min(end, Number(m[3])) - start) throw new RomError(502, 'The ROM host sent an incomplete part of the file.');
  return { data, total: Number(m[3]) };
}

// A sevenzip.js source that reads a remote file in byte ranges of up to MAX_DOWNLOAD each, or null
// if the host can't serve ranges. `head` holds the file's first 32 bytes.
async function rangedSource(urlString) {
  const first = await fetchRange(urlString, 0, 32);
  if (!first) return null;
  return {
    head: first.data,
    size: first.total,
    maxRead: MAX_DOWNLOAD,
    async read(start, end) {
      if (end <= first.data.length) return first.data.subarray(start, end);
      if (end - start > MAX_DOWNLOAD) throw new RomError(413, 'The file is too large.');
      const part = await fetchRange(urlString, start, end);
      if (!part) throw new RomError(502, 'The ROM host stopped serving parts of the file.');
      return part.data;
    },
  };
}

// Downloads and parses the ROM. A .7z too large to download is read in byte ranges instead.
async function loadRom(urlString) {
  try {
    return await loadRomFile(await download(urlString));
  } catch (e) {
    if (!(e instanceof RomError) || e.status !== 413) throw e;
    const source = await rangedSource(urlString).catch(() => null);
    if (!source || !is7z(source.head)) throw e;
    console.log(`[rom] ${urlString} is ${(source.size / 1048576).toFixed(1)} MB; reading the 7z in parts`);
    return load7zSource(source);
  }
}

// Adds a converted ROM to the cache. If that would take the cache past CACHE_HIGH_WATER, the ROMs
// requested least recently are evicted first. A ROM too large to fit at all isn't cached.
function remember(url, entry) {
  const limit = CACHE_BYTES * CACHE_HIGH_WATER;
  if (entry.png.length > limit) return;
  for (const [oldUrl, old] of cache) {
    if (cacheBytes + entry.png.length <= limit) break;
    cache.delete(oldUrl);
    cacheBytes -= old.png.length;
    console.log(`[cache] evicted ${oldUrl} (last requested ${new Date(old.at).toISOString()})`);
  }
  cache.set(url, entry);
  cacheBytes += entry.png.length;
}

// Whether a registered link still serves a file: it answers OK and isn't an HTML page (hosts
// often replace removed files with one). Only the response headers are fetched.
async function stillServes(urlString) {
  try {
    const { res, timer } = await open(urlString);
    clearTimeout(timer);
    res.body?.cancel().catch(() => {});
    return !/text\/html/i.test(res.headers.get('content-type') || '');
  } catch {
    return false;
  }
}

// The file name at the end of a link (e.g. "Super Mario World (USA).zip"), for finding box art.
function fileFromUrl(urlString) {
  try { return decodeURIComponent(new URL(urlString).pathname.split('/').pop() || ''); } catch { return ''; }
}

// The ROM link is everything after "url=" so users can paste unencoded links after the prefix.
function targetFromRequest(reqUrl) {
  const i = reqUrl.indexOf('url=');
  if (i < 0) return null;
  let raw = reqUrl.slice(i + 4);
  if (/^https?%3A/i.test(raw)) { try { raw = decodeURIComponent(raw); } catch { /* keep raw */ } }
  return raw.trim();
}

async function handleRom(req, res) {
  const target = targetFromRequest(req.url);
  if (!target) throw new RomError(400, 'Missing ?url=<ROM link>.');
  const hit = cache.get(target);
  if (hit) {
    cache.delete(target);   // move to the most recently requested end
    cache.set(target, hit);
    hit.at = Date.now();
    return sendPng(res, hit);
  }
  const parsed = await loadRom(target);
  const label = await labelFor({ fileName: parsed.fileName || fileFromUrl(target), title: parsed.title });
  const png = encodePng(parsed, label.rgb);
  const art = `${label.source}:${label.name}`;
  const hash = romHash(parsed.rom);
  let link = await firstLinkFor(hash, target);
  // The ROM is known under another link. If that link has died, this one takes over.
  if (link !== target && !(await stillServes(link))) {
    console.log(`[rom] ${link} no longer loads; replacing it with ${target}`);
    link = await replaceLink(hash, link, target);
  }
  const entry = { png, hash, link, art, at: Date.now() };
  remember(target, entry);
  console.log(`[rom] ${parsed.title || '(untitled)'} ${parsed.hirom ? 'HiROM' : 'LoROM'} ${parsed.rom.length} bytes <- ${target}${link === target ? '' : ` (known from ${link})`}, label ${art}`);
  sendPng(res, entry);
}

function sendPng(res, { png, hash, link, art }) {
  res.writeHead(200, {
    'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'public, max-age=3600, s-maxage=3600',
    'x-rom-sha1': hash, 'x-rom-link': encodeURIComponent(link), 'x-rom-art': encodeURIComponent(art), ...CORS,
  });
  res.end(png);
}

// Vercel rewrites /rom.png and /health to its api/ functions, so accept both spellings.
async function handleRequest(req, res) {
  const path = req.url.split('?')[0];
  try {
    if (req.method !== 'GET') throw new RomError(405, 'GET only.');
    if (path === '/health' || path === '/api/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    if (path === '/rom.png' || path === '/api/rom') return await handleRom(req, res);
    throw new RomError(404, 'Use /rom.png?url=<ROM link>.');
  } catch (e) {
    const status = e instanceof RomError ? e.status : 500;
    if (!(e instanceof RomError)) console.error(e);
    else console.warn(`[rom] ${status} ${e.message}`);
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...CORS });
    res.end(e.message || 'Internal error');
  }
}

module.exports = { handleRequest };
