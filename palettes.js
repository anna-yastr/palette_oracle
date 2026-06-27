const path = require('path');
const fs   = require('fs');

const PALETTES_DIR = path.join(__dirname, 'palettes');

function toId(filename) {
  return filename.replace(/_palette\.png$/, '');
}

function toTitle(id) {
  return id
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function loadPalettes() {
  return fs.readdirSync(PALETTES_DIR)
    .filter(f => f.endsWith('_palette.png'))
    .sort()
    .map(f => {
      const id = toId(f);
      return { id, title: toTitle(id), image: path.join(PALETTES_DIR, f) };
    });
}

let PALETTES = loadPalettes();

function getRandomPalette(exclude = new Set()) {
  const pool = exclude.size ? PALETTES.filter(p => !exclude.has(p.id)) : PALETTES;
  return pool[Math.floor(Math.random() * pool.length)];
}

function getPaletteById(id) {
  return PALETTES.find(p => p.id === id) || null;
}

module.exports = { PALETTES, getRandomPalette, getPaletteById };
