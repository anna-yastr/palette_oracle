/**
 * Downloads the Forum font (TTF) into ./fonts/
 * Run once: node downloadFonts.js
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const FONTS_DIR = path.join(__dirname, 'fonts');

// Complete TTF with all glyph ranges (Latin + Cyrillic in a single file)
const FONT_FILES = [
  {
    dest: path.join(FONTS_DIR, 'Forum-Regular.ttf'),
    sources: [
      // Google Fonts official GitHub repo — the canonical complete font file
      'https://raw.githubusercontent.com/google/fonts/main/ofl/forum/Forum-Regular.ttf',
      // Fontsource CDN latin-only fallback (Cyrillic won't render, but at least loads)
      'https://cdn.jsdelivr.net/fontsource/fonts/forum@5.2.5/latin-400-normal.ttf',
    ],
  },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);

    protocol.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        download(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function main() {
  if (!fs.existsSync(FONTS_DIR)) fs.mkdirSync(FONTS_DIR);

  let allOk = true;

  for (const { dest, sources } of FONT_FILES) {
    const name = path.basename(dest);
    if (fs.existsSync(dest)) {
      console.log(`${name} already present.`);
      continue;
    }
    let downloaded = false;
    for (const url of sources) {
      process.stdout.write(`Downloading ${name} from ${url} … `);
      try {
        await download(url, dest);
        console.log('OK');
        downloaded = true;
        break;
      } catch (err) {
        console.log(`failed (${err.message})`);
      }
    }
    if (!downloaded) {
      console.error(`\nCould not download ${name}.`);
      allOk = false;
    }
  }

  if (!allOk) {
    console.error(
      '\nManual fallback: download Forum from https://fonts.google.com/specimen/Forum\n' +
      'and place Forum-latin.ttf and Forum-cyrillic.ttf into ./fonts/',
    );
    process.exit(1);
  }

  console.log('\nAll fonts ready.');
}

main();
