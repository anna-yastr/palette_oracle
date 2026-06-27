require('dotenv').config();
const path     = require('path');
const https    = require('https');
const fs       = require('fs');
const os       = require('os');
const { spawn }       = require('child_process');
const { Telegraf, Markup } = require('telegraf');
const { getRandomPalette, getPaletteById } = require('./palettes');
const { generateLore } = require('./loreGenerator');
const { renderPaletteCard } = require('./imageRenderer');

const SRC_DIR     = path.join(__dirname, 'palette_oracle_src');
const PALETTE_PY  = path.join(SRC_DIR, 'palette_maker.py');

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (res) => {
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

function generateUserPalette(imagePath, title, author, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('py', [
      PALETTE_PY,
      '--input',  imagePath,
      '--output', outputPath,
      '--title',  title,
      '--author', author,
    ], { cwd: SRC_DIR });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) reject(new Error(stderr || 'Python script failed'));
      else resolve();
    });
    proc.on('error', reject);
  });
}

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN is missing from .env');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

const HISTORY_SIZE = 10;

// lore is always regenerated on request — only palette + histories are cached
const session         = new Map();
const userFlows       = new Map(); // palette-creation conversation state per user
const paletteCooldown = new Map(); // userId -> timestamp of last completed generation

const PALETTE_COOLDOWN_MS = 60_000;

function omenKeyboard(paletteId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('↺ Перечесть', `reroll:${paletteId}`),
      Markup.button.callback('✦ Узреть иное', 'new_omen'),
    ],
  ]);
}

async function sendOmen(ctx, palette, { addToPaletteHistory = true, deleteMessage = true } = {}) {
  const state          = session.get(ctx.from.id) ?? {};
  const loreHistory    = state.loreHistory    ?? [];
  const paletteHistory = state.paletteHistory ?? [];

  const { text: lore, typeName, primaryLine } = generateLore(new Set(loreHistory));

  let imageBuffer;
  try {
    imageBuffer = await renderPaletteCard(palette, lore, typeName);
  } catch (err) {
    console.error('[bot] renderPaletteCard failed:', err.message);
    await ctx.reply('Связь с Оракулом потеряна…\nПопробуй чуть позже ещё раз.');
    return;
  }

  session.set(ctx.from.id, {
    palette,
    paletteHistory: addToPaletteHistory
      ? [...paletteHistory, palette.id].slice(-HISTORY_SIZE)
      : paletteHistory,
    loreHistory: [...loreHistory, primaryLine].slice(-HISTORY_SIZE),
  });

  if (deleteMessage && ctx.callbackQuery?.message) {
    try { await ctx.deleteMessage(); } catch {}
  }

  await ctx.replyWithPhoto(
    { source: imageBuffer },
    { caption: `— ${typeName} —\n${lore}`, ...omenKeyboard(palette.id) },
  );
}

bot.start(async (ctx) => {
  await ctx.replyWithPhoto(
    { source: path.join(__dirname, 'Oracle.jpg') },
    {
      caption: '✦ Глаза Оракула открыты ✦\n\nКаждая палитра несёт знамение.',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✦ Открыть знамение ✦', 'new_omen')],
        [Markup.button.callback('✦ Создать свою палитру ✦',  'create_palette')],
      ]),
    },
  );
});

bot.action('new_omen', async (ctx) => {
  await ctx.answerCbQuery();
  const { paletteHistory = [] } = session.get(ctx.from.id) ?? {};
  const caption = ctx.callbackQuery?.message?.caption ?? '';
  // удалять только карточки знамений (caption начинается с тире)
  // стартовая карточка и пользовательские палитры (без caption) остаются
  const shouldDelete = caption.startsWith('—');
  await sendOmen(ctx, getRandomPalette(new Set(paletteHistory)), { deleteMessage: shouldDelete });
});

bot.action(/^reroll:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Знамение изменилось…');
  const paletteId = ctx.match[1];
  const state     = session.get(ctx.from.id) ?? {};
  const palette   = state.palette ?? getPaletteById(paletteId) ?? getRandomPalette();
  await sendOmen(ctx, palette, { addToPaletteHistory: false });
});

// ── palette creation flow ─────────────────────────────────────────────────────

bot.action('create_palette', async (ctx) => {
  await ctx.answerCbQuery();
  const last = paletteCooldown.get(ctx.from.id) ?? 0;
  if (Date.now() - last < PALETTE_COOLDOWN_MS) {
    await ctx.reply('Связь с Оракулом на мгновение потеряна.');
    return;
  }
  userFlows.set(ctx.from.id, { step: 'awaiting_image' });
  await ctx.reply('✦ Пришли изображение — я извлеку из него палитру ✦');
});

bot.on('photo', async (ctx) => {
  const flow = userFlows.get(ctx.from.id);
  if (!flow || flow.step !== 'awaiting_image') return;

  const photo    = ctx.message.photo[ctx.message.photo.length - 1];
  const fileLink = await ctx.telegram.getFileLink(photo.file_id);
  const tmpImg   = path.join(os.tmpdir(), `oracle_in_${ctx.from.id}_${Date.now()}.jpg`);

  try {
    await downloadFile(String(fileLink), tmpImg);
  } catch (err) {
    console.error('[bot] photo download failed:', err.message);
    userFlows.delete(ctx.from.id);
    await ctx.reply('Не удалось получить картинку. Попробуй ещё раз.');
    return;
  }

  userFlows.set(ctx.from.id, { step: 'awaiting_name', imagePath: tmpImg });
  await ctx.reply('✦ Дай палитре имя ✦');
});

bot.on('text', async (ctx) => {
  const flow = userFlows.get(ctx.from.id);
  if (!flow) return;

  if (flow.step === 'awaiting_name') {
    userFlows.set(ctx.from.id, { ...flow, step: 'awaiting_author', paletteName: ctx.message.text });
    await ctx.reply('✦ Назови своё имя ✦');
    return;
  }

  if (flow.step === 'awaiting_author') {
    const authorName = ctx.message.text;
    userFlows.delete(ctx.from.id);

    const outputPath = path.join(os.tmpdir(), `oracle_out_${ctx.from.id}_${Date.now()}.png`);
    const waiting    = await ctx.reply('Оракул читает цвета…');

    try {
      await generateUserPalette(flow.imagePath, flow.paletteName, authorName, outputPath);
      await ctx.replyWithPhoto(
        { source: outputPath },
        Markup.inlineKeyboard([
          [Markup.button.callback('✦ Открыть знамение ✦',     'new_omen')],
          [Markup.button.callback('✦ Создать свою палитру ✦', 'create_palette')],
        ]),
      );
      paletteCooldown.set(ctx.from.id, Date.now());
    } catch (err) {
      console.error('[bot] generateUserPalette failed:', err.message);
      await ctx.reply('Связь с Оракулом потеряна…\nПопробуй чуть позже ещё раз.');
    } finally {
      try { fs.unlinkSync(flow.imagePath); } catch {}
      try { fs.unlinkSync(outputPath);     } catch {}
      try { await ctx.telegram.deleteMessage(ctx.chat.id, waiting.message_id); } catch {}
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────

bot.launch();
console.log('The Oracle awoke.');

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
