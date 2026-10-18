// Vercel serverless function; vercel.json rewrites /health here.
module.exports = require('../rom-proxy/proxy').handleRequest;
