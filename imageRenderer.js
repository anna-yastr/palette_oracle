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
const PAD_X    = 90;

// ── oracle zone ───────────────────────────────────────────────────────────────
//
//  670  ─── SEPARATOR_Y  (dashes + diamond)
//  714  ─── SIGIL_Y      ("— Знамение —")
//  [prophecy block centred in 754…888, LINE_STEP=48]
//  920  ─── FOOTER_Y     (attribution, pinned; bottom padding = 122px)

const SEPARATOR_Y    = 670;
const SIGIL_Y        = 714;
const PROPHECY_TOP   = 744;
const PROPHECY_BOT   = 878;
const PROPHECY_MID   = (PROPHECY_TOP + PROPHECY_BOT) / 2;  // 811
const FOOTER_Y       = 920;
const LINE_STEP      = 38;
const PROPHECY_PAD_X = 140;   // ~12% narrower than PAD_X → poetic line width

// ── separator geometry ────────────────────────────────────────────────────────
const SEP_D   = 4;
const SEP_LEN = 110;
const SEP_GAP = SEP_D + 12;

// ── colours ───────────────────────────────────────────────────────────────────
const COLOR_SEP       = 'rgba(35, 28, 20, 0.55)';
const COLOR_SIGIL     = 'rgba(28, 20, 14, 0.92)';
const COLOR_LORE      = 'rgba(28, 20, 14, 0.88)';
const COLOR_LORE_DIM  = 'rgba(28, 20, 14, 0.76)';
const COLOR_LORE_DIM2 = 'rgba(28, 20, 14, 0.56)';
const COLOR_FOOTER    = 'rgba(28, 20, 14, 0.78)';

// ── helpers ───────────────────────────────────────────────────────────────────

// Split lore text into individual sentences (one line each).
// Handles both \n paragraph breaks and in-sentence punctuation (. ! ?).
function splitIntoSentences(loreText) {
  return loreText
    .split('\n')
    .flatMap(para => {
      const trimmed = para.trim();
      if (!trimmed) return [];
      // split on sentence-ending punctuation followed by whitespace
      return trimmed.replace(/([.!?])\s+/g, '$1\n').split('\n').map(s => s.trim()).filter(Boolean);
    });
}

// Particles that must not be left at the end of a line before a break.
const NO_BREAK_AFTER = new Set(['не', 'ни', 'бы', 'же', 'ли', 'бь']);

// Split one sentence into two lines at the word boundary that equalises widths.
function splitIntoTwo(ctx, text, fontSpec, maxWidth) {
  ctx.font = fontSpec;
  const words = text.split(' ');
  if (words.length <= 1) return [text];
  let bestSplit = Math.floor(words.length / 2);
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    if (NO_BREAK_AFTER.has(words[i - 1].toLowerCase())) continue;
    const l1 = words.slice(0, i).join(' ');
    const l2 = words.slice(i).join(' ');
    const w1 = ctx.measureText(l1).width;
    const w2 = ctx.measureText(l2).width;
    if (w1 <= maxWidth && w2 <= maxWidth) {
      const score = Math.abs(w1 - w2);
      if (score < bestScore) { bestScore = score; bestSplit = i; }
    }
  }
  return [words.slice(0, bestSplit).join(' '), words.slice(bestSplit).join(' ')];
}

function fitSize(ctx, text, maxWidth, baseSize, minSize = 18) {
  let size = baseSize;
  while (size >= minSize) {
    ctx.font = `italic ${size}px "${forumFamily}"`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 1;
  }
  return size;
}

function drawStar4(ctx, cx, cy, outerR, innerR) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI / 4) - Math.PI / 2;
    const r = i % 2 === 0 ? outerR : innerR;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

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

// Prophecy:
//   • 1 sentence = 1 line, max 3, no word-wrap
//   • font shrinks to fit narrowed PROPHECY_PAD_X width
//   • lines cascade in size and opacity
//   • block vertically centred; footer pinned at FOOTER_Y
function drawLore(ctx, loreText, author = null) {
  const MAX_W     = WIDTH - PROPHECY_PAD_X * 2;
  const BASE_SIZE = [33, 29, 26];
  const colors    = [COLOR_LORE, COLOR_LORE_DIM, COLOR_LORE_DIM2];

  const sentences = splitIntoSentences(loreText).slice(0, 3);

  // 1 sentence → wrap into 2 equal-width lines; 2-3 sentences → one line each
  let lines, lineSizes, lineColors;
  if (sentences.length === 1) {
    const fontSpec = `italic ${BASE_SIZE[0]}px "${forumFamily}"`;
    lines      = splitIntoTwo(ctx, sentences[0], fontSpec, MAX_W);
    lineSizes  = lines.map(() => BASE_SIZE[0]);
    lineColors = lines.map(() => COLOR_LORE);
  } else {
    lines      = sentences;
    lineSizes  = sentences.map((s, i) => fitSize(ctx, s, MAX_W, BASE_SIZE[i]));
    lineColors = colors.slice(0, sentences.length);
  }

  const blockH = (lines.length - 1) * LINE_STEP;
  // +8px optical shift: baseline sits below visual text centre
  const startY = PROPHECY_MID + 8 - blockH / 2;

  const starColor = 'rgba(28, 20, 14, 0.55)';

  ctx.fillStyle     = starColor;
  ctx.textAlign     = 'center';
  ctx.letterSpacing = '0px';
  drawStar4(ctx, CENTER_X, PROPHECY_TOP, 6, 1.8);

  lines.forEach((line, i) => {
    ctx.font      = `italic ${lineSizes[i]}px "${forumFamily}"`;
    ctx.fillStyle = lineColors[i];
    ctx.fillText(line, CENTER_X, startY + i * LINE_STEP);
  });

  ctx.fillStyle = starColor;
  drawStar4(ctx, CENTER_X, PROPHECY_BOT, 6, 1.8);

  if (author) {
    const prefix = ', для вас особое знамение';
    ctx.letterSpacing = '0px';

    ctx.font    = `bold italic 20px "${forumFamily}"`;
    const nameW = ctx.measureText(author).width;
    const ascent = ctx.measureText(author).actualBoundingBoxAscent ?? 7;

    ctx.font      = `italic 20px "${forumFamily}"`;
    const prefixW = ctx.measureText(prefix).width;
    const tw      = nameW + prefixW;
    const startX  = CENTER_X - tw / 2;

    ctx.fillStyle = COLOR_FOOTER;
    ctx.textAlign = 'left';
    ctx.font = `bold italic 20px "${forumFamily}"`;
    ctx.fillText(author, startX, FOOTER_Y);
    ctx.font = `italic 20px "${forumFamily}"`;
    ctx.fillText(prefix, startX + nameW, FOOTER_Y);

    const D_GAP  = 14;
    const D_HALF = 3;
    drawDiamond(ctx, startX - D_GAP,      FOOTER_Y - ascent / 2, D_HALF);
    drawDiamond(ctx, startX + tw + D_GAP, FOOTER_Y - ascent / 2, D_HALF);

    ctx.textAlign = 'center';
  }
}

// ── main export ───────────────────────────────────────────────────────────────

async function renderPaletteCard(palette, loreText, typeName = 'Знамение', author = null) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx    = canvas.getContext('2d');

  const img = await loadImage(palette.image);
  ctx.drawImage(img, 0, 0, WIDTH, HEIGHT);

  drawSeparator(ctx);
  drawSigil(ctx, typeName);
  drawLore(ctx, loreText, author);

  return canvas.toBuffer('image/png');
}

module.exports = { renderPaletteCard };
