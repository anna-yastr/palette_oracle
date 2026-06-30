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

const SRC_DIR     = path.join(__dirname, 'palette_oracle_src');
const PALETTE_PY  = path.join(SRC_DIR, 'palette_maker.py');

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        file.destroy();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

const PYTHON = process.env.PYTHON_CMD
  ?? (process.platform === 'win32' ? 'py' : 'python3');

const GENERATION_TIMEOUT_MS = 30_000;

function generateUserPalette(imagePath, title, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [
      PALETTE_PY,
      '--input',  imagePath,
      '--output', outputPath,
      '--title',  title,
    ], { cwd: SRC_DIR });

    let stderr  = '';
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      settle(reject, new Error('timeout'));
    }, GENERATION_TIMEOUT_MS);

    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') return; // already rejected by timer
      if (code !== 0) settle(reject, new Error(stderr || 'Python script failed'));
      else settle(resolve);
    });
    proc.on('error', err => {
      clearTimeout(timer);
      settle(reject, err);
    });
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
const FLOW_TTL            = 30 * 60_000;
const MAX_MAP_SIZE        = 15;

function setSession(userId, state) {
  session.delete(userId);
  session.set(userId, state);
  if (session.size > MAX_MAP_SIZE) session.delete(session.keys().next().value);
}

function setCooldown(userId) {
  paletteCooldown.delete(userId);
  paletteCooldown.set(userId, Date.now());
  if (paletteCooldown.size > MAX_MAP_SIZE) paletteCooldown.delete(paletteCooldown.keys().next().value);
}

setInterval(() => {
  const cutoff = Date.now() - FLOW_TTL;
  for (const [uid, flow] of userFlows) {
    if (flow.startedAt < cutoff) userFlows.delete(uid);
  }
}, 5 * 60_000);

const MAX_CONCURRENT       = 3;
const GLOBAL_RATE_LIMIT    = 40;
const GLOBAL_RATE_WINDOW   = 5 * 60_000; // 5 minutes

let activeGenerations = 0;
const generationTimestamps = []; // sliding window for global rate limit

function isGlobalRateLimited() {
  const cutoff = Date.now() - GLOBAL_RATE_WINDOW;
  while (generationTimestamps.length && generationTimestamps[0] < cutoff) {
    generationTimestamps.shift();
  }
  return generationTimestamps.length >= GLOBAL_RATE_LIMIT;
}

const ANONYMOUS_NAMES = [
  'Безымянное дитя',
  'Дитя пепла',
  'Дитя сумерек',
  'Заблудшее дитя',
  'Дитя звёзд',
  'Эхо у порога',
  'Голос из тишины',
  'Искра в пепле',
  'Лик без имени',
  'Око в темноте',
  'Имя без лица',
  'Безымянная душа',
];

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
    await ctx.reply('Нить предсказания оборвалась.\nПовторите зов.');
    return;
  }

  track(ctx.from.id, 'omen_shown', { typeName, phrase: primaryLine });

  setSession(ctx.from.id, {
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
  track(ctx.from.id, 'new_omen');
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

async function startPaletteCreation(ctx) {
  const last = paletteCooldown.get(ctx.from.id) ?? 0;
  if (Date.now() - last < PALETTE_COOLDOWN_MS) {
    track(ctx.from.id, 'cooldown_hit');
    await ctx.reply('Чернила предсказания ещё не высохли. Возвращайтесь через минуту.');
    return;
  }
  track(ctx.from.id, 'create_palette_start');
  userFlows.set(ctx.from.id, { step: 'awaiting_image', startedAt: Date.now() });
  await ctx.reply('✦ Пришлите изображение — Оракул извлечёт из него палитру ✦');
}

bot.command('create_palette', (ctx) => startPaletteCreation(ctx));

bot.action('create_palette', async (ctx) => {
  await ctx.answerCbQuery();
  await startPaletteCreation(ctx);
});

bot.on('photo', async (ctx) => {
  const flow = userFlows.get(ctx.from.id);
  if (!flow || flow.step !== 'awaiting_image') return;

  if (Date.now() - flow.startedAt > FLOW_TTL) {
    userFlows.delete(ctx.from.id);
    await ctx.reply('Оракул пробуждается.');
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
    return;
  }

  // Global rate limit: 40 palettes per 5 minutes across all users
  if (isGlobalRateLimited()) {
    await ctx.reply('Храм переполнен. Энергия Оракула исчерпана — возвращайтесь позже.');
    return;
  }

  // Concurrency limit: max 3 simultaneous Python processes
  if (activeGenerations >= MAX_CONCURRENT) {
    await ctx.reply('Туман будущего сгущается. Оракулу нужно время, чтобы вглядеться в вашу нить.');
    return;
  }
  activeGenerations++;

  const photo  = ctx.message.photo[ctx.message.photo.length - 1];
  const tmpImg = path.join(os.tmpdir(), `oracle_in_${ctx.from.id}_${Date.now()}.jpg`);

  try {
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    await downloadFile(String(fileLink), tmpImg);
  } catch (err) {
    console.error('[bot] photo download failed:', err.message);
    track(ctx.from.id, 'photo_failed');
    userFlows.delete(ctx.from.id);
    try { fs.unlinkSync(tmpImg); } catch {}
    activeGenerations--;
    await ctx.reply('Оракул не смог увидеть ваш образ. Попробуйте ещё раз.');
    return;
  }

  track(ctx.from.id, 'photo_uploaded');
  userFlows.delete(ctx.from.id);

  const authorName = ctx.from.username
    ? `@${ctx.from.username}`
    : ANONYMOUS_NAMES[Math.floor(Math.random() * ANONYMOUS_NAMES.length)];

  const outputPath = path.join(os.tmpdir(), `oracle_out_${ctx.from.id}_${Date.now()}.png`);
  const waiting    = await ctx.reply('Оракул читает цвета…');
  generationTimestamps.push(Date.now());
  try {
    const t0 = Date.now();
    await generateUserPalette(tmpImg, 'The Palette Oracle', outputPath);
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
    setCooldown(ctx.from.id);
  } catch (err) {
    track(ctx.from.id, 'palette_failed');
    if (err.message === 'timeout') {
      console.error('[bot] generateUserPalette timeout');
      await ctx.reply('Нить знамения истончилась и оборвалась. Повторите зов.');
    } else {
      console.error('[bot] generateUserPalette failed:', err.message);
      await ctx.reply('Чернила предсказания ещё не высохли. Возвращайтесь через минуту.');
    }
  } finally {
    activeGenerations--;
    try { fs.unlinkSync(tmpImg);                     } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
    try { await ctx.telegram.deleteMessage(ctx.chat.id, waiting.message_id); } catch {}
  }
});

bot.on(['video', 'animation', 'document', 'sticker', 'voice', 'video_note'], async (ctx) => {
  const flow = userFlows.get(ctx.from.id);
  if (!flow || flow.step !== 'awaiting_image') return;
  await ctx.reply('Вы принесли ложные дары. Оракул ждёт изображения.');
});

// ── rules ─────────────────────────────────────────────────────────────────────

const RULES_TEXT = `✦ Свод правил и ограничений ✦

Добро пожаловать! Настоящие Правила определяют условия использования бота @ametanami_palette_oracle_bot (далее — Бот) и являются соглашением между пользователем (далее — Вы) и создателем Бота (@ametanami, далее — Создатель).

Нажимая кнопку «Старт» или иным образом используя Бот, Вы полностью и безоговорочно соглашаетесь с данными Правилами.

1. Статус Бота и инструментарий
Бот является некоммерческим творческим инструментом, предназначенным для автоматической генерации цветовых палитр, вдохновляющих текстовых предсказаний и визуальных материалов. 

Все текстовые предсказания являются художественными и развлекательными элементами и не должны восприниматься как фактические рекомендации, советы или гарантии.

Все изображения и тексты обрабатываются и генерируются Ботом в автоматическом режиме в реальном времени. Создатель Бота не осуществляет предварительную модерацию действий пользователей.

2. Ограничение ответственности (Disclaimer)
Ответственность за контент: Пользователь самостоятельно несёт полную ответственность за содержание загружаемых материалов, вводимые текстовые данные и гарантирует наличие прав на их использование.

Позиция Создателя: Создатель Бота не разделяет, не поддерживает и не несет ответственности за смысловую нагрузку, политические, религиозные, этические или любые иные высказывания и визуальные образы, созданные Пользователями с помощью Бота.

Наличие водяных знаков / никнеймов: Наличие на сгенерированном изображении никнейма Создателя указывает исключительно на авторство самого программного инструмента (Бота) и не означает одобрения Создателем того контента, который сгенерировал Пользователь.

3. Правила поведения и запреты
Пользователям строго запрещено использовать Бот для создания, обработки или распространения контента, который:

— нарушает законодательство (включая призывы к насилию, экстремизм, разжигание ненависти или вражды);
— нарушает авторские права третьих лиц;
— содержит материалы порнографического характера или иные неприемлемые изображения;
— имеет целью оскорбление, травлю или дискредитацию третьих лиц.

4. Права Создателя
Создатель оставляет за собой право в одностороннем порядке и без объяснения причин ограничить или полностью заблокировать доступ к Боту любому пользователю в случае нарушения данных Правил или при обнаружении подозрительной активности.

Программное обеспечение Бота предоставляется по принципу «как есть» (as is). Создатель не гарантирует бесперебойную работу Бота и не несет ответственности за временные технические сбои.

5. Обработка данных
Загружаемые изображения и пользовательские данные используются исключительно для временной обработки и генерации результата. Создатель Бота не хранит исходные изображения, введённые пользователем данные и созданные результаты после завершения обработки.`;


bot.command('rules', async (ctx) => {
  await ctx.reply(RULES_TEXT);
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
