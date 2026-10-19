// Offline converter: node rom2png.js <game.sfc|game.zip|game.7z> <out.png>
// Host the PNG anywhere VRChat can load images from (e.g. GitHub Pages) and paste its URL.
'use strict';
const fs = require('fs');
const { loadRomFile, encodePng, RomError } = require('./romimage');

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node rom2png.js <rom.sfc|rom.zip|rom.7z> <out.png>');
  process.exit(2);
}
loadRomFile(fs.readFileSync(input)).then(parsed => {
  fs.writeFileSync(output, encodePng(parsed));
  console.log(`${parsed.title || '(untitled)'}: ${parsed.hirom ? 'HiROM' : 'LoROM'}, ${parsed.rom.length} bytes, SRAM code ${parsed.sramCode} -> ${output}`);
}, e => {
  console.error(e instanceof RomError ? e.message : e);
  process.exit(1);
});
