const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;

const SESSION_GAP = 15 * 60_000;
const EVENTS_TTL  = 7 * 24 * 3600_000;
const DAY         = 86_400_000;

// ── Permanent aggregates (never pruned, reset only on restart) ────────────────
const agg = {
  omens:             0,
  rerolls:           0,
  newOmens:          0,
  palettes:          0,
  cooldowns:         0,
  photoFailed:       0,
  palFailed:         0,
  photoUploaders:    new Set(),
  paletteUsers:      new Set(),
  genDurSum:         0,
  genDurCount:       0,
  rerollDeltaSum:    0,
  rerollDeltaCount:  0,
  newOmenDeltaSum:   0,
  newOmenDeltaCount: 0,
};

// ── Per-user permanent metadata ───────────────────────────────────────────────
const userMeta = new Map(); // uid -> { firstSeen, activeDays: Set<dayIdx>, lastEvent, lastEventTs }

function getMeta(uid) {
  if (!userMeta.has(uid)) {
    userMeta.set(uid, { firstSeen: Date.now(), activeDays: new Set(), lastEvent: null, lastEventTs: 0 });
  }
  return userMeta.get(uid);
}

// ── Sliding-window events (7 days) ────────────────────────────────────────────
const events = [];

function pruneEvents() {
  const cutoff = Date.now() - EVENTS_TTL;
  let i = 0;
  while (i < events.length && events[i].ts < cutoff) i++;
  if (i > 0) events.splice(0, i);
}

// ── Write ─────────────────────────────────────────────────────────────────────

function track(userId, event, extra = {}) {
  const ts  = Date.now();
  const uid = String(userId);

  const meta = getMeta(uid);
  meta.activeDays.add(Math.floor(ts / DAY));

  switch (event) {
    case 'omen_shown':
      agg.omens++;
      break;
    case 'reroll':
      agg.rerolls++;
      if (meta.lastEvent === 'omen_shown') {
        agg.rerollDeltaSum += ts - meta.lastEventTs;
        agg.rerollDeltaCount++;
      }
      break;
    case 'new_omen':
      agg.newOmens++;
      if (meta.lastEvent === 'omen_shown') {
        agg.newOmenDeltaSum += ts - meta.lastEventTs;
        agg.newOmenDeltaCount++;
      }
      break;
    case 'cooldown_hit':
      agg.cooldowns++;
      break;
    case 'photo_uploaded':
      agg.photoUploaders.add(uid);
      break;
    case 'palette_generated':
      agg.palettes++;
      agg.paletteUsers.add(uid);
      if (extra.durationMs) { agg.genDurSum += extra.durationMs; agg.genDurCount++; }
      break;
    case 'photo_failed':
      agg.photoFailed++;
      break;
    case 'palette_failed':
      agg.palFailed++;
      break;
  }

  meta.lastEvent   = event;
  meta.lastEventTs = ts;

  pruneEvents();
  events.push({ ts, uid, event, ...extra });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDuration(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)} сек`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m} мин ${s} сек` : `${m} мин`;
}

// ── Report ────────────────────────────────────────────────────────────────────

function buildStats() {
  if (!userMeta.size) return '— Оракул молчал с начала времён —';

  const todayStart = new Date().setHours(0, 0, 0, 0);

  // ── Activity (permanent userMeta) ─────────────────────────────────────────
  const totalUsers = userMeta.size;
  const newToday   = [...userMeta.values()].filter(m => m.firstSeen >= todayStart).length;
  const retained   = [...userMeta.values()].filter(m => m.activeDays.size > 1).length;
  const active24h  = new Set(events.filter(e => e.ts > Date.now() - DAY).map(e => e.uid)).size;
  const avgOmens   = (agg.omens / totalUsers).toFixed(1);

  // ── Session depth (7-day events window) ───────────────────────────────────
  const byUser = {};
  for (const e of events) (byUser[e.uid] ??= []).push(e);
  for (const uid of Object.keys(byUser)) byUser[uid].sort((a, b) => a.ts - b.ts);

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
  const avgSessionDepth = totalSessions > 0 ? (totalDepth / totalSessions).toFixed(1) : '—';

  // ── Types & phrases (7-day window) ────────────────────────────────────────
  const typeCounts   = {};
  const phraseCounts = {};
  for (const e of events.filter(e => e.event === 'omen_shown')) {
    if (e.typeName) typeCounts[e.typeName] = (typeCounts[e.typeName] ?? 0) + 1;
    if (e.phrase)   phraseCounts[e.phrase] = (phraseCounts[e.phrase] ?? 0) + 1;
  }
  const typesSorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
  const topPhrase   = Object.entries(phraseCounts).sort((a, b) => b[1] - a[1])[0];

  // ── Most cursed (7-day window) ────────────────────────────────────────────
  const callsPerUser = {};
  for (const e of events) callsPerUser[e.uid] = (callsPerUser[e.uid] ?? 0) + 1;
  const mostCursed = Object.entries(callsPerUser).sort((a, b) => b[1] - a[1])[0];

  // ── Averages (permanent agg) ──────────────────────────────────────────────
  const avgRerollMs  = agg.rerollDeltaCount
    ? Math.round(agg.rerollDeltaSum / agg.rerollDeltaCount) : null;
  const avgNewOmenMs = agg.newOmenDeltaCount
    ? Math.round(agg.newOmenDeltaSum / agg.newOmenDeltaCount) : null;
  const avgGenMs     = agg.genDurCount
    ? Math.round(agg.genDurSum / agg.genDurCount) : null;

  // ── Conversion (permanent agg) ────────────────────────────────────────────
  const abandoned         = [...agg.photoUploaders].filter(u => !agg.paletteUsers.has(u)).length;
  const paletteConversion = agg.photoUploaders.size
    ? Math.round((agg.paletteUsers.size / agg.photoUploaders.size) * 100) : 0;

  // ── Last event ────────────────────────────────────────────────────────────
  const lastEvent = events[events.length - 1];
  let lastAgoStr  = '—';
  if (lastEvent) {
    const ms = Date.now() - lastEvent.ts;
    lastAgoStr = ms < 60_000
      ? `${Math.round(ms / 1000)} сек назад`
      : ms < 3_600_000
        ? `${Math.round(ms / 60_000)} мин назад`
        : `${Math.round(ms / 3_600_000)} ч назад`;
  }

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
    `Упёрлись в кулдаун: ${agg.cooldowns}`,
    '',
    '🔮 Оракул',
    `Знамений открыто: ${agg.omens}`,
    `Перечитано (reroll): ${agg.rerolls}`,
    avgRerollMs  !== null ? `Ср. время до перечтения: ${fmtDuration(avgRerollMs)}`      : '',
    `Узрели иное (new card): ${agg.newOmens}`,
    avgNewOmenMs !== null ? `Ср. время до видения иного: ${fmtDuration(avgNewOmenMs)}`  : '',
    `Создано палитр: ${agg.palettes}`,
  ];

  if (typesSorted.length) {
    out.push('', 'Типы предсказаний (7 дн.):');
    for (const [t, c] of typesSorted) out.push(`  ${t}: ${c}`);
  }

  if (topPhrase) {
    const short = topPhrase[0].length > 70 ? topPhrase[0].slice(0, 67) + '…' : topPhrase[0];
    out.push('', `Самое частое пророчество за 7 дн. (${topPhrase[1]}×):`, `  "${short}"`);
  }

  out.push(
    '',
    '⚙️ Техника',
    `Ошибок загрузки фото: ${agg.photoFailed}`,
    `Фейлов генерации: ${agg.palFailed}`,
    avgGenMs !== null ? `Ср. время генерации: ${fmtDuration(avgGenMs)}` : '',
    `Бросили процесс: ${abandoned}`,
    `Конверсия палитры: ${paletteConversion}%`,
    '',
    '☠️ Самый проклятый (7 дн.)',
    mostCursed ? `${mostCursed[1]} призывов` : 'Никто',
    '',
    `(событий за 7 дн.: ${events.length})`,
  );

  return out.filter(Boolean).join('\n');
}

module.exports = { track, buildStats, ADMIN_ID };
