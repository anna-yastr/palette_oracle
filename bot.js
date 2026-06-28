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
const { track, buildStats, ADMIN_ID } = require('./stats');
const { containsProfanity } = require('./profanity');

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

function generateUserPalette(imagePath, title, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('py', [
      PALETTE_PY,
      '--input',  imagePath,
      '--output', outputPath,
      '--title',  title,
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

  track(ctx.from.id, 'omen_shown', { typeName, phrase: primaryLine });

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
        [Markup.button.callback('✦ Создать свою палитру ✦', 'create_palette')],
      ]),
    },
  );
});

bot.command('new_omen', async (ctx) => {
  const { paletteHistory = [] } = session.get(ctx.from.id) ?? {};
  await sendOmen(ctx, getRandomPalette(new Set(paletteHistory)), { deleteMessage: false });
});

bot.action('new_omen', async (ctx) => {
  await ctx.answerCbQuery();
  const { paletteHistory = [] } = session.get(ctx.from.id) ?? {};
  // omen cards carry a reroll button; start and user palette cards do not
  const buttons = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard?.flat() ?? [];
  const shouldDelete = buttons.some(b => b.callback_data?.startsWith('reroll:'));
  await sendOmen(ctx, getRandomPalette(new Set(paletteHistory)), { deleteMessage: shouldDelete });
});

bot.action(/^reroll:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Знамение изменилось…');
  track(ctx.from.id, 'reroll');
  const paletteId = ctx.match[1];
  const state     = session.get(ctx.from.id) ?? {};
  const palette   = state.palette ?? getPaletteById(paletteId) ?? getRandomPalette();
  await sendOmen(ctx, palette, { addToPaletteHistory: false });
});

// ── palette creation flow ─────────────────────────────────────────────────────

bot.command('create_palette', async (ctx) => {
  const last = paletteCooldown.get(ctx.from.id) ?? 0;
  if (Date.now() - last < PALETTE_COOLDOWN_MS) {
    track(ctx.from.id, 'cooldown_hit');
    await ctx.reply('Чернила предсказания ещё не высохли. Возвращайся через минуту.');
    return;
  }
  track(ctx.from.id, 'create_palette_start');
  userFlows.set(ctx.from.id, { step: 'awaiting_image' });
  await ctx.reply('✦ Пришли изображение — Оракул извлечет из него палитру ✦');
});

bot.action('create_palette', async (ctx) => {
  await ctx.answerCbQuery();
  const last = paletteCooldown.get(ctx.from.id) ?? 0;
  if (Date.now() - last < PALETTE_COOLDOWN_MS) {
    track(ctx.from.id, 'cooldown_hit');
    await ctx.reply('Чернила предсказания ещё не высохли. Возвращайтесь через минуту.');
    return;
  }
  track(ctx.from.id, 'create_palette_start');
  userFlows.set(ctx.from.id, { step: 'awaiting_image' });
  await ctx.reply('✦ Пришлите изображение — Оракул извлечет из него палитру ✦');
});

bot.on('photo', async (ctx) => {
  const flow = userFlows.get(ctx.from.id);
  if (!flow || flow.step !== 'awaiting_image') return;

  const photo  = ctx.message.photo[ctx.message.photo.length - 1];
  const tmpImg = path.join(os.tmpdir(), `oracle_in_${ctx.from.id}_${Date.now()}.jpg`);

  try {
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    await downloadFile(String(fileLink), tmpImg);
  } catch (err) {
    console.error('[bot] photo download failed:', err.message);
    track(ctx.from.id, 'photo_failed');
    userFlows.delete(ctx.from.id);
    await ctx.reply('Оракул не смог увидеть ваш образ. Попробуйте ещё раз.');
    return;
  }

  track(ctx.from.id, 'photo_uploaded');
  userFlows.set(ctx.from.id, { step: 'awaiting_author', imagePath: tmpImg });
  await ctx.reply('✦ Назовите своё имя ✦');
});

bot.on('text', async (ctx, next) => {
  const flow = userFlows.get(ctx.from.id);
  if (!flow) return next();

  if (flow.step === 'awaiting_author') {
    const authorName = ctx.message.text;

    if (containsProfanity(authorName)) {
      await ctx.reply('Оракул отверг это имя. Выберите другое.');
      return;
    }

    userFlows.delete(ctx.from.id);

    const outputPath = path.join(os.tmpdir(), `oracle_out_${ctx.from.id}_${Date.now()}.png`);
    const waiting    = await ctx.reply('Оракул читает цвета…');
    let generated    = false;

    try {
      const t0 = Date.now();
      await generateUserPalette(flow.imagePath, 'The Palette Oracle', outputPath);
      generated = true;
      const { text: lore, typeName } = generateLore(new Set());
      const imageBuffer = await renderPaletteCard({ image: outputPath }, lore, typeName, authorName);
      await ctx.replyWithPhoto(
        { source: imageBuffer },
        {
          caption: `— ${typeName} —\n${lore}`,
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✦ Открыть знамение ✦',     'new_omen')],
            [Markup.button.callback('✦ Создать свою палитру ✦', 'create_palette')],
          ]),
        },
      );
      track(ctx.from.id, 'palette_generated', { durationMs: Date.now() - t0 });
      paletteCooldown.set(ctx.from.id, Date.now());
    } catch (err) {
      console.error('[bot] generateUserPalette failed:', err.message);
      track(ctx.from.id, 'palette_failed');
      await ctx.reply('Чернила предсказания ещё не высохли. Возвращайтесь через минуту.');
    } finally {
      try { fs.unlinkSync(flow.imagePath);           } catch {}
      if (generated) try { fs.unlinkSync(outputPath); } catch {}
      try { await ctx.telegram.deleteMessage(ctx.chat.id, waiting.message_id); } catch {}
    }
  }
});

// ── admin stats ───────────────────────────────────────────────────────────────

bot.command('stats', async (ctx) => {
  if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) return;
  try {
    const text = buildStats();
    // Telegram message limit is 4096 chars
    if (text.length <= 4096) {
      await ctx.reply(text);
    } else {
      await ctx.reply(text.slice(0, 4090) + '\n…');
    }
  } catch (err) {
    console.error('[stats] error:', err.message);
    await ctx.reply('Ошибка при сборе статистики: ' + err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────

bot.launch();
console.log('The Oracle awoke.');

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
