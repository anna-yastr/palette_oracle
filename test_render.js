const { renderPaletteCard } = require('./imageRenderer');
const { PALETTES } = require('./palettes');
const { generateLore } = require('./loreGenerator');
const fs = require('fs');
const path = require('path');

async function main() {
  for (const palette of PALETTES) {
    const { text, typeName } = generateLore();
    console.log(`\n[${palette.id}] ${palette.title}`);
    console.log(text.split('\n').map((l, i) => `  ${i + 1}: ${l}`).join('\n'));
    const buf = await renderPaletteCard(palette, text, typeName);
    const out = path.join(__dirname, `test_${palette.id}.png`);
    fs.writeFileSync(out, buf);
    console.log(`  → ${path.basename(out)}`);
  }
  console.log('\nAll done.');
}

main().catch(console.error);
