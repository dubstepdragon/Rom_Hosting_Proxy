// Offline converter: node rom2png.js <game.sfc|game.zip|game.7z> <out.png> [--no-art]
// Host the PNG anywhere VRChat can load images from (e.g. GitHub Pages) and paste its URL.
// The cartridge label is looked up online like the proxy does (coverart.js); --no-art draws the
// game's name instead without going online.
'use strict';
const fs = require('fs');
const path = require('path');
const { loadRomFile, encodePng, RomError } = require('./romimage');
const { labelFor, drawNameLabel, cleanName } = require('./coverart');

const args = process.argv.slice(2);
const offline = args.includes('--no-art');
const [input, output] = args.filter(a => a !== '--no-art');
if (!input || !output) {
  console.error('usage: node rom2png.js <rom.sfc|rom.zip|rom.7z> <out.png> [--no-art]');
  process.exit(2);
}
loadRomFile(fs.readFileSync(input)).then(async parsed => {
  const fileName = parsed.fileName || path.basename(input);
  const label = offline ? { rgb: drawNameLabel(cleanName(fileName) || parsed.title), source: 'drawn', name: cleanName(fileName) }
    : await labelFor({ fileName, title: parsed.title });
  fs.writeFileSync(output, encodePng(parsed, label.rgb));
  console.log(`${parsed.title || '(untitled)'}: ${parsed.hirom ? 'HiROM' : 'LoROM'}, ${parsed.rom.length} bytes, SRAM code ${parsed.sramCode}, label ${label.source}:${label.name} -> ${output}`);
}, e => {
  console.error(e instanceof RomError ? e.message : e);
  process.exit(1);
});
