const WHITELIST = require('./profanity_whitelist');

// ── Latin → Cyrillic lookalike map ────────────────────────────────────────────
const LATIN_MAP = {
  'a': 'а', 'e': 'е', 'o': 'о', 'p': 'р', 'c': 'с',
  'x': 'х', 'y': 'у', 'k': 'к', 'b': 'б', 'm': 'м',
  '0': 'о', '@': 'а', '3': 'з', '$': 'с', '4': 'ч',
};

const LATIN_RE = new RegExp(`[${Object.keys(LATIN_MAP).join('').replace(/[-[\]]/g, '\\$&')}]`, 'g');

// ── Banned roots ──────────────────────────────────────────────────────────────
const RUSSIAN_ROOTS = [
  // specific first so they mask before shorter overlapping roots
  'хуй', 'пизд', 'пёзд', 'ёб', 'ебл', 'еб', 'блят', 'бля',
  'залуп', 'гандон', 'дроч', 'шлюх', 'пидор', 'педер', 'педр',
  'манд', 'муд', 'сук', 'хер', 'ху', 'анал',
];

const ENGLISH_ROOTS = [
  'fuck', 'fuk', 'shit', 'bitch', 'cunt', 'dick', 'cock',
  'asshole', 'whore', 'slut', 'nigg', 'fagg', 'rape', 'cum',
  'twat', 'pussy', 'bastard', 'anal',
];

// ── Normalizers ───────────────────────────────────────────────────────────────

function normalizeCyrillic(name) {
  return name
    .toLowerCase()
    .replace(/[\s_\-.]+/g, '')                // strip separators: е-б → еб
    .replace(LATIN_RE, ch => LATIN_MAP[ch])   // map lookalikes: x→х, y→у
    .replace(/[^а-яё]/g, '')                   // strip remaining non-Cyrillic
    .replace(/(.)\1+/g, '$1');                 // collapse repeats: хуууй → хуй
}

function normalizeLatin(name) {
  return name
    .toLowerCase()
    .replace(/[\s_\-.]+/g, '')                // strip separators
    .replace(/[^a-z]/g, '')                    // strip non-Latin
    .replace(/(.)\1+/g, '$1');                 // collapse repeats
}

// ── Pre-normalise at load time ────────────────────────────────────────────────
const CYRILLIC_WHITELIST = WHITELIST.ru.map(normalizeCyrillic);
const LATIN_WHITELIST    = WHITELIST.en.map(normalizeLatin);
const LATIN_ROOTS_NORM   = ENGLISH_ROOTS.map(normalizeLatin);

// ── Masking helper ────────────────────────────────────────────────────────────
function maskWhitelist(s, whitelist, minLen) {
  for (const safe of whitelist) {
    if (safe && safe.length >= minLen && s.includes(safe)) {
      s = s.split(safe).join('\x00'.repeat(safe.length));
    }
  }
  return s;
}

// ── Hit counter ───────────────────────────────────────────────────────────────
// Returns true if string contains >= threshold banned roots after masking.
// 2+ roots = reject immediately (catches compound pseudo-names like "Аналио де Пидеросьён").
function hasHits(s, roots, threshold = 1) {
  let hits = 0;
  for (const root of roots) {
    if (s.includes(root)) {
      hits++;
      if (hits >= threshold) return true;
    }
  }
  return false;
}

// ── Check functions ───────────────────────────────────────────────────────────

function checkCyrillic(name) {
  const hasCyrillic = /[а-яёА-ЯЁ]/.test(name);
  let s = normalizeCyrillic(name);
  if (!s) return false;

  // For purely Latin input: if Cyrillic normalization kept less than half the
  // original Latin letters, most chars were stripped (not lookalikes) — this
  // is a real English word, not a disguised Cyrillic one. Skip Cyrillic check
  // and let checkLatin handle it.
  // Example: 'sebastian' (9 Latin) → 'еба' (3 Cyrillic) → ratio 0.33 → skip
  // Example: 'xep'        (3 Latin) → 'хер' (3 Cyrillic) → ratio 1.0  → check
  if (!hasCyrillic) {
    const latinLen = name.toLowerCase().replace(/[^a-z]/g, '').length;
    if (latinLen > 0 && s.length / latinLen < 0.5) return false;
  }

  // Whitelist first, then scan — 1 root = reject, but also catch 2+ before masking
  // covers edge case where two soft roots survive partial masking
  if (hasHits(s, RUSSIAN_ROOTS, 2)) return true;
  s = maskWhitelist(s, CYRILLIC_WHITELIST, 4);
  return hasHits(s, RUSSIAN_ROOTS, 1);
}

function checkLatin(name) {
  let s = normalizeLatin(name);
  if (!s) return false;
  if (hasHits(s, LATIN_ROOTS_NORM, 2)) return true;
  s = maskWhitelist(s, LATIN_WHITELIST, 4);
  return hasHits(s, LATIN_ROOTS_NORM, 1);
}

function containsProfanity(name) {
  return checkCyrillic(name) || checkLatin(name);
}

module.exports = { normalizeNickname: normalizeCyrillic, containsProfanity };
