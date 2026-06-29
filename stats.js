const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;

const SESSION_GAP = 15 * 60 * 1000; // 15 min gap = new session

// ── In-memory event log (resets on restart) ───────────────────────────────────
const events = [];

// ── Write ─────────────────────────────────────────────────────────────────────

function track(userId, event, extra = {}) {
  events.push({ ts: Date.now(), uid: String(userId), event, ...extra });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDuration(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)} сек`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m} мин ${s} сек` : `${m} мин`;
}

// ── Report ────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;

function buildStats() {
  if (!events.length) return '— Оракул молчал с начала времён —';

  const todayStart = new Date().setHours(0, 0, 0, 0);

  // Group and sort events per user
  const byUser = {};
  for (const e of events) {
    (byUser[e.uid] ??= []).push(e);
  }
  for (const uid of Object.keys(byUser)) {
    byUser[uid].sort((a, b) => a.ts - b.ts);
  }

  // ── Activity ──────────────────────────────────────────────────────────────
  const firstSeen    = {};
  const callsPerUser = {};
  const userDays     = {};
  for (const e of events) {
    if (!firstSeen[e.uid] || e.ts < firstSeen[e.uid]) firstSeen[e.uid] = e.ts;
    callsPerUser[e.uid] = (callsPerUser[e.uid] ?? 0) + 1;
    (userDays[e.uid] ??= new Set()).add(Math.floor(e.ts / DAY));
  }

  const totalUsers = Object.keys(firstSeen).length;
  const newToday   = Object.values(firstSeen).filter(t => t >= todayStart).length;
  const retained   = Object.values(userDays).filter(s => s.size > 1).length;
  const active24h  = new Set(events.filter(e => e.ts > Date.now() - DAY).map(e => e.uid)).size;

  // Session depth: gap > 15 min = new session
  let totalSessions = 0;
  let totalDepth    = 0;
  for (const evs of Object.values(byUser)) {
    let sessionStart = 0;
    for (let i = 1; i < evs.length; i++) {
      if (evs[i].ts - evs[i - 1].ts > SESSION_GAP) {
        totalSessions++;
        totalDepth += i - sessionStart;
        sessionStart = i;
      }
    }
    totalSessions++;
    totalDepth += evs.length - sessionStart;
  }
  const avgSessionDepth = totalSessions > 0
    ? (totalDepth / totalSessions).toFixed(1)
    : '—';

  // ── Omen stats ────────────────────────────────────────────────────────────
  const omens        = events.filter(e => e.event === 'omen_shown');
  const typeCounts   = {};
  const phraseCounts = {};
  const omensPerUser = {};
  for (const e of omens) {
    if (e.typeName) typeCounts[e.typeName] = (typeCounts[e.typeName] ?? 0) + 1;
    if (e.phrase)   phraseCounts[e.phrase] = (phraseCounts[e.phrase] ?? 0) + 1;
    omensPerUser[e.uid] = (omensPerUser[e.uid] ?? 0) + 1;
  }
  const avgOmens    = totalUsers
    ? (Object.values(omensPerUser).reduce((a, b) => a + b, 0) / totalUsers).toFixed(1)
    : 0;
  const typesSorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
  const topPhrase   = Object.entries(phraseCounts).sort((a, b) => b[1] - a[1])[0];

  // Time-to-reroll: omen_shown → reroll delta per user
  const rerollDeltas = [];
  for (const evs of Object.values(byUser)) {
    for (let i = 0; i < evs.length - 1; i++) {
      if (evs[i].event === 'omen_shown' && evs[i + 1].event === 'reroll') {
        rerollDeltas.push(evs[i + 1].ts - evs[i].ts);
      }
    }
  }
  const avgRerollMs = rerollDeltas.length
    ? Math.round(rerollDeltas.reduce((a, b) => a + b, 0) / rerollDeltas.length)
    : null;

  const rerolls = events.filter(e => e.event === 'reroll').length;

  // ── Technical ─────────────────────────────────────────────────────────────
  const cooldowns   = events.filter(e => e.event === 'cooldown_hit').length;
  const palettes    = events.filter(e => e.event === 'palette_generated');
  const palFailed   = events.filter(e => e.event === 'palette_failed').length;
  const photoFailed = events.filter(e => e.event === 'photo_failed').length;
  const avgGenMs    = palettes.length
    ? Math.round(palettes.reduce((a, e) => a + (e.durationMs ?? 0), 0) / palettes.length)
    : null;

  const photoUploaders = new Set(events.filter(e => e.event === 'photo_uploaded').map(e => e.uid));
  const paletteUsers   = new Set(palettes.map(e => e.uid));
  const abandoned          = [...photoUploaders].filter(u => !paletteUsers.has(u)).length;
  const paletteConversion  = photoUploaders.size
    ? Math.round((paletteUsers.size / photoUploaders.size) * 100)
    : 0;

  const mostCursed  = Object.entries(callsPerUser).sort((a, b) => b[1] - a[1])[0];
  const lastEvent   = events[events.length - 1];
  const lastAgoMs   = Date.now() - lastEvent.ts;
  const lastAgoStr  = lastAgoMs < 60_000
    ? `${Math.round(lastAgoMs / 1000)} сек назад`
    : lastAgoMs < 3_600_000
      ? `${Math.round(lastAgoMs / 60_000)} мин назад`
      : `${Math.round(lastAgoMs / 3_600_000)} ч назад`;

  // ── Build output ──────────────────────────────────────────────────────────
  const out = [
    '📊 Хроники Оракула',
    '',
    '👁 Активность',
    `Последний зов: ${lastAgoStr}`,
    `Всего душ: ${totalUsers}`,
    `Активных за 24ч: ${active24h}`,
    `Новых сегодня: ${newToday}`,
    `Вернулись (2+ дня): ${retained}`,
    `Ср. знамений на душу: ${avgOmens}`,
    `Ср. глубина сессии: ${avgSessionDepth} событий`,
    `Упёрлись в кулдаун: ${cooldowns}`,
    '',
    '🔮 Оракул',
    `Знамений открыто: ${omens.length}`,
    `Перечитано (reroll): ${rerolls}`,
    avgRerollMs !== null ? `Ср. время до перечтения: ${fmtDuration(avgRerollMs)}` : '',
    `Создано палитр: ${palettes.length}`,
  ];

  if (typesSorted.length) {
    out.push('', 'Типы предсказаний:');
    for (const [t, c] of typesSorted) out.push(`  ${t}: ${c}`);
  }

  if (topPhrase) {
    const short = topPhrase[0].length > 70 ? topPhrase[0].slice(0, 67) + '…' : topPhrase[0];
    out.push('', `Самое частое пророчество (${topPhrase[1]}×):`, `  "${short}"`);
  }

  out.push(
    '',
    '⚙️ Техника',
    `Ошибок загрузки фото: ${photoFailed}`,
    `Фейлов генерации: ${palFailed}`,
    avgGenMs !== null ? `Ср. время генерации: ${fmtDuration(avgGenMs)}` : '',
    `Бросили процесс: ${abandoned}`,
    `Конверсия палитры: ${paletteConversion}%`,
    '',
    '☠️ Самый проклятый',
    mostCursed ? `${mostCursed[1]} призывов` : 'Никто',
    '',
    `(событий с запуска: ${events.length})`,
  );

  return out.filter(Boolean).join('\n');
}

module.exports = { track, buildStats, ADMIN_ID };
