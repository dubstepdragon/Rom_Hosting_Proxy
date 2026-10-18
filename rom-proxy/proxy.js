// ROM proxy request handling for the VRChat SNES emulator, shared by server.js (standalone Node)
// and api/ (Vercel serverless functions).
//
//   GET /rom.png?url=<direct link to a .sfc/.smc/.zip>  -> PNG-packed ROM (see romimage.js)
//       X-Rom-Sha1: the ROM's SHA-1; X-Rom-Link: (URI-encoded) the first link this ROM was loaded
//       from, which differs from ?url= when the ROM is already known (see registry.js)
//   GET /health                                         -> "ok"
//
// Errors come back as non-200 responses so VRChat's image downloader reports a failure and the
// emulator returns to a state where another link can be loaded.
//
// MAX_DOWNLOAD_MB, FETCH_TIMEOUT_MS and ALLOWED_HOSTS env vars are optional, as are the
// registry's KV_REST_API_URL / KV_REST_API_TOKEN.
'use strict';
const dns = require('dns').promises;
const net = require('net');
const { RomError, loadRomFile, encodePng } = require('./romimage');
const { romHash, firstLinkFor, replaceLink } = require('./registry');

const MAX_DOWNLOAD = Number(process.env.MAX_DOWNLOAD_MB || 16) * 1024 * 1024;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 25000);
// Optional allow-list of source hosts, comma separated (e.g. "example.org,cdn.example.org").
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const CACHE_ENTRIES = 16;
// Lets the GitHub Pages link builder (docs/) test links through this proxy and read its errors
// and registry headers.
const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-rom-sha1, x-rom-link' };

const cache = new Map();   // url -> { png, hash, link, at }

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
async function open(urlString) {
  let current = urlString;
  for (let hop = 0; hop < 5; hop++) {
    await checkTarget(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current, { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': 'vrchat-snes-rom-proxy/1.0' } });
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
  if (declared > MAX_DOWNLOAD) { clearTimeout(timer); throw new RomError(413, 'The file is too large.'); }
  const parts = [];
  let size = 0;
  try {
    for await (const part of res.body) {
      size += part.length;
      if (size > MAX_DOWNLOAD) throw new RomError(413, 'The file is too large.');
      parts.push(part);
    }
  } finally { clearTimeout(timer); }
  return Buffer.concat(parts.map(p => Buffer.from(p)));
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
  if (hit) return sendPng(res, hit);
  const file = await download(target);
  const parsed = loadRomFile(file);
  const png = encodePng(parsed);
  const hash = romHash(parsed.rom);
  let link = await firstLinkFor(hash, target);
  // The ROM is known under another link. If that link has died, this one takes over.
  if (link !== target && !(await stillServes(link))) {
    console.log(`[rom] ${link} no longer loads; replacing it with ${target}`);
    link = await replaceLink(hash, link, target);
  }
  const entry = { png, hash, link, at: Date.now() };
  cache.set(target, entry);
  if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  console.log(`[rom] ${parsed.title || '(untitled)'} ${parsed.hirom ? 'HiROM' : 'LoROM'} ${parsed.rom.length} bytes <- ${target}${link === target ? '' : ` (known from ${link})`}`);
  sendPng(res, entry);
}

function sendPng(res, { png, hash, link }) {
  res.writeHead(200, {
    'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'public, max-age=3600, s-maxage=3600',
    'x-rom-sha1': hash, 'x-rom-link': encodeURIComponent(link), ...CORS,
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
