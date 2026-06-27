const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');
const fs = require('fs');

const FONT_PATH = path.join(__dirname, 'fonts', 'Forum-Regular.ttf');
let forumFamily = 'Georgia';
if (fs.existsSync(FONT_PATH)) {
  try {
    GlobalFonts.registerFromPath(FONT_PATH, 'Forum');
    forumFamily = 'Forum';
  } catch (e) {
    console.warn('[imageRenderer] Forum font registration failed:', e.message);
  }
} else {
  console.warn('[imageRenderer] Forum-Regular.ttf not found — run `node downloadFonts.js`.');
}

const WIDTH    = 1024;
const HEIGHT   = 1024;
const CENTER_X = WIDTH / 2;
const PAD_X    = 80;

const SEPARATOR_Y   = 816;
const SIGIL_Y       = 848;
const LORE_Y_FIRST  = 876;
const LORE_Y_SECOND = 901;
const LORE_Y_THIRD  = 924;
const LORE_Y_CENTER = (LORE_Y_FIRST + LORE_Y_SECOND) / 2;

const SEP_D   = 4;
const SEP_LEN = 90;
const SEP_GAP = SEP_D + 10;

const COLOR_SEP       = 'rgba(35, 28, 20, 0.55)';
const COLOR_SIGIL     = 'rgba(28, 20, 14, 0.92)';
const COLOR_LORE      = 'rgba(28, 20, 14, 0.88)';
const COLOR_LORE_DIM  = 'rgba(28, 20, 14, 0.704)';
const COLOR_LORE_DIM2 = 'rgba(28, 20, 14, 0.50)';

// ── text utilities ────────────────────────────────────────────────────────────

function wrapLine(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function getWrappedLines(ctx, loreText, maxWidth) {
  const paragraphs = loreText.split('\n').map(p => p.trim()).filter(Boolean);
  return paragraphs.flatMap(p => wrapLine(ctx, p, maxWidth)).slice(0, 3);
}

// ── drawing helpers ───────────────────────────────────────────────────────────

function drawDiamond(ctx, cx, cy, half) {
  ctx.beginPath();
  ctx.moveTo(cx,        cy - half);
  ctx.lineTo(cx + half, cy);
  ctx.lineTo(cx,        cy + half);
  ctx.lineTo(cx - half, cy);
  ctx.closePath();
  ctx.fill();
}

function drawSeparator(ctx) {
  ctx.strokeStyle = COLOR_SEP;
  ctx.lineWidth   = 0.7;
  ctx.beginPath();
  ctx.moveTo(CENTER_X - SEP_GAP - SEP_LEN, SEPARATOR_Y);
  ctx.lineTo(CENTER_X - SEP_GAP,           SEPARATOR_Y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(CENTER_X + SEP_GAP,           SEPARATOR_Y);
  ctx.lineTo(CENTER_X + SEP_GAP + SEP_LEN, SEPARATOR_Y);
  ctx.stroke();
  ctx.fillStyle = COLOR_SEP;
  drawDiamond(ctx, CENTER_X, SEPARATOR_Y, SEP_D);
}

function drawSigil(ctx, typeName) {
  ctx.font          = `25px "${forumFamily}"`;
  ctx.fillStyle     = COLOR_SIGIL;
  ctx.textAlign     = 'center';
  ctx.letterSpacing = '4px';
  ctx.fillText(`—  ${typeName}  —`, CENTER_X, SIGIL_Y);
  ctx.letterSpacing = '0px';
}

function drawLore(ctx, loreText) {
  const lines = getWrappedLines(ctx, loreText, WIDTH - PAD_X * 2);

  ctx.textAlign = 'center';

  if (lines.length === 1) {
    ctx.font      = `italic 25px "${forumFamily}"`;
    ctx.fillStyle = COLOR_LORE;
    ctx.fillText(lines[0], CENTER_X, LORE_Y_CENTER);
  } else if (lines.length === 2) {
    ctx.font      = `italic 25px "${forumFamily}"`;
    ctx.fillStyle = COLOR_LORE;
    ctx.fillText(lines[0], CENTER_X, LORE_Y_FIRST);
    ctx.font      = `italic 24px "${forumFamily}"`;
    ctx.fillStyle = COLOR_LORE_DIM;
    ctx.fillText(lines[1], CENTER_X, LORE_Y_SECOND);
  } else {
    ctx.font      = `italic 25px "${forumFamily}"`;
    ctx.fillStyle = COLOR_LORE;
    ctx.fillText(lines[0], CENTER_X, LORE_Y_FIRST);
    ctx.font      = `italic 24px "${forumFamily}"`;
    ctx.fillStyle = COLOR_LORE_DIM;
    ctx.fillText(lines[1], CENTER_X, LORE_Y_SECOND);
    ctx.font      = `italic 22px "${forumFamily}"`;
    ctx.fillStyle = COLOR_LORE_DIM2;
    ctx.fillText(lines[2], CENTER_X, LORE_Y_THIRD);
  }
}

// ── main export ───────────────────────────────────────────────────────────────

async function renderPaletteCard(palette, loreText, typeName = 'Знамение') {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx    = canvas.getContext('2d');

  const img = await loadImage(palette.image);
  ctx.drawImage(img, 0, 0, WIDTH, HEIGHT);

  drawSeparator(ctx);
  drawSigil(ctx, typeName);
  drawLore(ctx, loreText);

  return canvas.toBuffer('image/png');
}

module.exports = { renderPaletteCard };
