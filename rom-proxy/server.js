// Standalone ROM proxy for the VRChat SNES emulator (see proxy.js for the endpoints).
//
// Usage: node server.js   (PORT, MAX_DOWNLOAD_MB, ALLOWED_HOSTS env vars are optional)
// Put it behind HTTPS (e.g. a reverse proxy or tunnel); VRChat requires https URLs.
'use strict';
const http = require('http');
const { handleRequest } = require('./proxy');

const PORT = Number(process.env.PORT || 8787);

http.createServer(handleRequest).listen(PORT, () => console.log(`SNES ROM proxy listening on :${PORT}`));
