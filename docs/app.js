// Link builder for the GitHub Pages site. It never stores ROMs: it builds
// <proxy>/rom.png?url=<ROM link> for VRCImageDownloader and can test that link through the proxy.

// Set this to your deployed rom-proxy so visitors don't have to enter one (e.g. 'https://rom.example.org').
const DEFAULT_PROXY = '';

const $ = (id) => document.getElementById(id);

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { /* storage blocked */ } },
};

function status(el, text, kind = '') { el.textContent = text; el.className = 'status ' + kind; }

function proxyBase() { return $('proxy').value.trim().replace(/\/+$/, ''); }

function build() {
  const el = $('src-status');
  $('result').hidden = true;
  const link = $('src-url').value.trim();
  let url;
  try { url = new URL(link); } catch { return status(el, 'That is not a valid URL.', 'err'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return status(el, 'Only http(s) links are supported.', 'err');
  const proxy = proxyBase();
  if (!proxy) { $('proxy-box').open = true; return status(el, 'Enter your rom-proxy server URL first.', 'err'); }
  if (!/^https:\/\//i.test(proxy)) return status(el, 'The proxy must use https://. VRChat only loads https URLs.', 'err');
  store.set('proxy', proxy === DEFAULT_PROXY ? '' : proxy);
  status(el, '');
  $('link').textContent = `${proxy}/rom.png?url=${encodeURIComponent(url.href)}`;
  status($('test-status'), '');
  $('info').hidden = true;
  $('result').hidden = false;
}

// Reads the packed header (first 48 payload bytes) back out of the proxy's PNG to show what it found.
async function readHeader(png) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const parts = [];
  let height = 0;
  for (let p = 8; p + 8 <= png.length;) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(...png.subarray(p + 4, p + 8));
    if (type === 'IHDR') height = view.getUint32(p + 12);
    if (type === 'IDAT') parts.push(png.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const stream = new Blob(parts).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  const head = new Uint8Array(49);         // row 0's filter byte + the 48 header bytes
  for (let got = 0; got < head.length;) {
    const { done, value } = await reader.read();
    if (done) throw new Error('The proxy returned a truncated image.');
    const n = Math.min(value.length, head.length - got);
    head.set(value.subarray(0, n), got);
    got += n;
  }
  reader.cancel();
  const h = head.subarray(1);
  if (String.fromCharCode(h[0], h[1], h[2]) !== 'SNS') throw new Error('The proxy returned an image without a ROM header.');
  const romLength = h[3] | (h[4] << 8) | (h[5] << 16);
  const title = String.fromCharCode(...h.subarray(8, 29)).replace(/[^\x20-\x7E]/g, '').trim();
  return { title, hirom: (h[6] & 2) !== 0, sramCode: h[7], romLength, height };
}

async function test() {
  const el = $('test-status');
  $('test-btn').disabled = true;
  $('info').hidden = true;
  status(el, 'Asking the proxy to download and convert the ROM…');
  try {
    let res;
    try { res = await fetch($('link').textContent); }
    catch { throw new Error('Could not reach the proxy. Check its URL and that it is running behind HTTPS.'); }
    if (!res.ok) {
      // rom-proxy explains its errors in plain text.
      const detail = /text\/plain/i.test(res.headers.get('content-type') || '') ? await res.text() : '';
      throw new Error(detail || `The proxy answered HTTP ${res.status}.`);
    }
    const png = new Uint8Array(await res.arrayBuffer());
    const h = await readHeader(png);
    $('info').replaceChildren(...[
      ['Title', h.title || '(untitled)'],
      ['Mapping', h.hirom ? 'HiROM' : 'LoROM'],
      ['ROM size', `${(h.romLength / 1024).toFixed(0)} KB`],
      ['SRAM', h.sramCode ? `${1 << (h.sramCode - 1)} KB` : 'none'],
      ['Image', `2048 × ${h.height} px, ${(png.length / 1024).toFixed(0)} KB`],
    ].flatMap(([k, v]) => {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      return [dt, dd];
    }));
    $('info').hidden = false;
    status(el, 'Works. Paste the link into your VRChat world.', 'ok');
  } catch (e) {
    status(el, e.message, 'err');
  } finally {
    $('test-btn').disabled = false;
  }
}

async function copyLink() {
  const btn = $('copy-btn');
  try { await navigator.clipboard.writeText($('link').textContent); btn.textContent = 'Copied'; }
  catch { getSelection().selectAllChildren($('link')); btn.textContent = 'Press Ctrl+C'; }
  setTimeout(() => { btn.textContent = 'Copy link'; }, 1500);
}

function init() {
  // ?proxy=<url> lets a world creator share a page link with their proxy pre-filled.
  const fromQuery = new URLSearchParams(location.search).get('proxy');
  if (fromQuery) store.set('proxy', fromQuery);
  $('proxy').value = store.get('proxy') || DEFAULT_PROXY;
  if (!$('proxy').value) $('proxy-box').open = true;

  $('build-btn').addEventListener('click', build);
  $('src-url').addEventListener('keydown', e => { if (e.key === 'Enter') build(); });
  $('copy-btn').addEventListener('click', copyLink);
  $('test-btn').addEventListener('click', test);
}

init();
