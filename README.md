# SNES ROM Proxy for VRChat

**Link builder page: https://dubstepdragon.github.io/Rom_Hosting_Proxy/**

Udon can only download text (`VRCStringDownloader`) or images (`VRCImageDownloader`), and it cannot
build a `VRCUrl` from a string at runtime. So the ROM travels as a lossless PNG. The proxy fetches
a ROM from its original host and packs it into that PNG on the fly. The link builder page makes the
URLs you paste into your world.

Nothing in this project stores or hosts ROMs. The page only builds links, and the proxy
(`https://romhostingproxy.vercel.app`) fetches each ROM from its original host when VRChat asks
for it. The only thing kept is a small registry of each ROM's SHA-1 hash and the first link it
was loaded from (see [Duplicate ROMs](#duplicate-roms)).

## Using the page

1. Open the [link builder](https://dubstepdragon.github.io/Rom_Hosting_Proxy/).
2. Paste a **direct link** to a `.sfc` / `.smc` file, or a `.zip` / `.7z` that contains one, and
   click **Make link**. If a `.7z` holds `.smc` files, the proxy loads the first `.smc` in the
   archive's listing. Otherwise, if an archive holds several versions of a game (a GoodSNES set,
   for example), the proxy picks a verified `[!]` dump and prefers USA/Japan releases.
3. The page tests the link through the proxy right away. The proxy downloads and converts the
   ROM, and the page shows the title, LoROM/HiROM mapping, ROM size, SRAM size and the cartridge
   label it picked (see [Cartridge labels](#cartridge-labels)), or the reason the ROM was rejected. If the ROM was already added from another link, the page gives you that
   existing link instead.
4. Click **Copy link** and paste it into a `VRCUrlInputField` (or wherever your world takes a
   `VRCUrl`) for `VRCImageDownloader`.

The generated link looks like this:

```
https://romhostingproxy.vercel.app/rom.png?url=https%3A%2F%2Fexample.org%2Fhomebrew.zip
```

### What links work

* **Direct file links only.** A download page (HTML) is rejected with a clear error. The proxy
  does not scrape download sites.
* Copier headers are stripped, and LoROM/HiROM is detected automatically.
* Games that need enhancement chips (SuperFX, SA-1, DSP-1, Cx4, S-DD1, SPC7110) and ExHiROM
  cartridges are **rejected**, so they fail cleanly instead of crashing.
* ROMs up to 8 MB.
* Files up to 16 MB (`MAX_DOWNLOAD_MB`). A larger `.7z` still works if its host supports
  partial downloads (HTTP range requests, as archive.org does): the proxy reads only the archive's
  headers and the data in front of the first `.smc`, and converts just that ROM. If the ROM sits
  too deep inside a large solid archive, the link is rejected with an error.

Image URLs outside VRChat's trusted list, including the proxy's `vercel.app` domain, only load for players who
have **Allow Untrusted URLs** turned on.

### Cartridge labels

The world spawns a cartridge for each game, with the game's box art on its label. The proxy finds
that art itself: it looks the game up in the [libretro thumbnail set](https://thumbnails.libretro.com/)
(No-Intro named box art) by the ROM's file name (the file inside a `.zip` / `.7z`, or the
link's file name), falling back to the title in the ROM header, and takes the closest match. A
match in the file's own region is preferred, then USA, World, Europe and Japan releases; betas,
prototypes and re-releases come last. The art is cropped to the label's shape and scaled to
256x176 pixels.

If no listed name is close enough, or the lookup fails or takes longer than `ART_TIMEOUT_MS`, the
proxy draws a label instead: the game's name, kept to letters, numbers and spaces and wrapped to
fit the label, on a colour picked from the name. A label never stops a ROM from loading. The
response's `X-Rom-Art` header says which it was: `boxart:<matched name>` or `drawn:<name>`.

### Duplicate ROMs

Every time the proxy converts a ROM, it hashes the ROM data (after unzipping and stripping any
copier header) and records the first link that ROM came from. If the same game arrives later from
a different link, such as a mirror, a renamed file, or the `.zip` instead of the `.sfc`, the
proxy returns that first link in an `X-Rom-Link` response header, and the page hands it out in
place of the new one, so each ROM ends up with one shared image URL.

Before reusing a first link, the proxy checks that it still serves a file. If that link now
returns an error, or a web page (such as a "file removed" notice), the new link replaces it in
the registry and becomes the one handed out from then on.

The registry lives in an Upstash Redis database (see setup step 4 below). Without it, the proxy
works as before and treats every link as new.

## Deploying the proxy (Vercel)

The proxy runs as a Vercel serverless function on the free Hobby plan (non-commercial use).
[`api/`](api) holds the functions, [`vercel.json`](vercel.json) maps `/rom.png` and `/health` to
them, and [`.vercelignore`](.vercelignore) makes sure only the proxy code is deployed.

One-time setup:

1. On [vercel.com](https://vercel.com/new), choose **Add New → Project** and import this GitHub
   repository.
2. Name the project `romhostingproxy` (that gives it the `romhostingproxy.vercel.app` domain),
   choose Framework Preset **Other**, and leave the build command empty. Click **Deploy**.
3. Check that `https://romhostingproxy.vercel.app/health` answers `ok`.
4. For [duplicate detection](#duplicate-roms), open the project's **Storage** tab, choose
   **Create Database → Upstash for Redis** (the free plan is enough) and connect it to the
   project. That adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`. Then redeploy so the proxy picks
   them up.

After that, every push to `main` redeploys the proxy. If Vercel gives the project a different
domain, update `PROXY` at the top of [`docs/app.js`](docs/app.js) and the link above.

Vercel caches each converted ROM on its CDN for an hour, so a whole instance loading the same
link only converts it once. Each running proxy also keeps converted ROMs in memory, up to
`CACHE_MB`. When a new ROM would take that cache past 80%, the ROMs that have gone longest
without being requested are dropped first. Vercel limits function responses to 4.5 MB, so the very largest ROMs
(roughly 6–8 MB) may fail there. Use the standalone server for those.

## Running the proxy yourself

`rom-proxy/server.js` needs Node 22+ and has no dependencies.

```
cd rom-proxy
node server.js              # PORT=8787 by default
```

VRChat requires `https` URLs, so put it behind HTTPS (a reverse proxy, a Cloudflare Tunnel, or a
host such as Render). To point the page at it, change `PROXY` in [`docs/app.js`](docs/app.js).

| Variable          | Default | Purpose                                              |
| ----------------- | ------- | ---------------------------------------------------- |
| `PORT`            | `8787`  | Port to listen on                                    |
| `MAX_DOWNLOAD_MB` | `16`    | Largest file the proxy will download                 |
| `FETCH_TIMEOUT_MS`| `25000` | Download timeout                                     |
| `ALLOWED_HOSTS`   | (none)  | Comma-separated hosts to allow, e.g. `a.com,b.org`   |
| `CACHE_MB`        | `256`   | Memory for converted ROMs; trimmed at 80%            |
| `ART_TIMEOUT_MS`  | `6000`  | Time allowed for finding and downloading box art     |
| `KV_REST_API_URL` | (none)  | Upstash Redis REST URL for the duplicate registry    |
| `KV_REST_API_TOKEN`| (none) | Upstash Redis REST token for the duplicate registry  |

On Vercel, set these (except `PORT`) under Project Settings → Environment Variables.
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` also work for the registry.

Private and LAN addresses are always blocked. Endpoints:

* `GET /rom.png?url=<ROM link>` returns the packed PNG, or a non-200 plain-text error so VRChat
  reports a failure. Successful responses carry `X-Rom-Sha1` (the ROM's hash) and `X-Rom-Link`
  (the URI-encoded first link this ROM was loaded from) and `X-Rom-Art` (where the cartridge label
  came from, see [Cartridge labels](#cartridge-labels)).
* `GET /health` returns `ok`.

## Offline converter

To convert a ROM without a proxy:

```
node rom-proxy/rom2png.js game.sfc game.png            # looks up box art online
node rom-proxy/rom2png.js game.sfc game.png --no-art   # draws the name label, no network
```

You can host that PNG yourself. GitHub Pages is on VRChat's trusted list by default. A Pages site
is public even when its repo is private, so only publish ROMs you have the right to share, such as
homebrew.

## PNG layout

RGB, 2048 pixels wide, 3 bytes per pixel, read row-major from the top-left:

| Bytes   | Contents                                  |
| ------- | ----------------------------------------- |
| 0-2     | `S`, `N`, `S`                             |
| 3-5     | ROM length (little endian)                |
| 6       | Flags (bit 1 = HiROM)                     |
| 7       | SRAM size code (log2(KB)+1, 0 = none)     |
| 8-28    | Title (for debugging)                     |
| 29      | Label art format (0 = none, 1 = 256x176 RGB) |
| 30-47   | Reserved                                  |
| 48+     | Label art when byte 29 is 1: 256x176 pixels, 3 bytes each, rows top to bottom (135,168 bytes) |
| then    | ROM data: from byte 135,216 with label art, from byte 48 without |

This must match `Assets/SNES/Shaders/SnesRomDecode.shader` and `SnesLabelDecode.shader` in the
emulator project. Images without label art (byte 29 = 0) still load.

## Deploying the page

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes `docs/` to GitHub Pages on
every push to `main`. One-time setup: **Settings → Pages → Build and deployment → Source:
GitHub Actions**.
