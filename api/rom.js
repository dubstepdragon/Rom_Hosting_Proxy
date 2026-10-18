// Vercel serverless function; vercel.json rewrites /rom.png here.
module.exports = require('../rom-proxy/proxy').handleRequest;
