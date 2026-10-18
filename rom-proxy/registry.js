// Remembers the first link each ROM was loaded from, so the same game pasted from another link
// (a mirror, a renamed file, the .zip instead of the .sfc) reuses the link that already works.
// Only the ROM's SHA-1 and its source URL are stored, never the ROM itself.
//
// Uses an Upstash Redis database over its REST API. Vercel's Upstash integration sets
// KV_REST_API_URL / KV_REST_API_TOKEN; UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN also work.
// Without them the registry is off and every link is treated as new.
'use strict';
const crypto = require('crypto');

const REST_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const TIMEOUT_MS = 3000;

function romHash(rom) { return crypto.createHash('sha1').update(rom).digest('hex'); }

async function redis(...command) {
  const res = await fetch(REST_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${REST_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || `Upstash answered HTTP ${res.status}`);
  return body.result;
}

/**
 * Records `url` as the home of this ROM unless another link got there first, and returns the
 * link to use: the earlier one, or `url` itself. Returns `url` if the registry is off or down,
 * since a missing registry must never stop a ROM from loading.
 */
async function firstLinkFor(hash, url) {
  if (!REST_URL || !REST_TOKEN) return url;
  const key = `rom:${hash}`;
  try {
    if (await redis('SET', key, url, 'NX') === 'OK') return url;
    return (await redis('GET', key)) || url;
  } catch (e) {
    console.warn(`[registry] ${e.message}`);
    return url;
  }
}

module.exports = { romHash, firstLinkFor };
