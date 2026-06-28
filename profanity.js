const WHITELIST = require('./profanity_whitelist');

// ── Latin → Cyrillic lookalike map ────────────────────────────────────────────
const LATIN_MAP = {
  'a': 'а', 'e': 'е', 'o': 'о', 'p': 'р', 'c': 'с',
  'x': 'х', 'y': 'у', 'k': 'к', 'b': 'б', 'm': 'м',
  // digits / symbols used as letter substitutes
  '0': 'о', '@': 'а', '3': 'з', '$': 'с', '4': 'ч',
};

const LATIN_RE = new RegExp(`[${Object.keys(LATIN_MAP).join('').replace(/[-[\]]/g, '\\$&')}]`, 'g');

// ── Banned roots ──────────────────────────────────────────────────────────────
const RUSSIAN_ROOTS = [
  'ху', 'пизд', 'пёзд', 'еб', 'ёб', 'бля', 'блят', 'сук', 'муд',
  'залуп', 'гандон', 'дроч', 'шлюх', 'пидор', 'манд', 'хер',
];

const ENGLISH_ROOTS = [
  'fuck', 'fuk', 'shit', 'bitch', 'cunt', 'dick', 'cock',
  'asshole', 'whore', 'slut', 'nigg', 'fagg', 'rape', 'cum',
  'twat', 'pussy', 'bastard',
];

// ── Normalizers ───────────────────────────────────────────────────────────────

function normalizeCyrillic(name) {
  return name
    .toLowerCase()
    .replace(LATIN_RE, ch => LATIN_MAP[ch])   // map lookalikes to Cyrillic
    .replace(/[^а-яё]/g, '')                   // strip remaining non-Cyrillic
    .replace(/(.)\1+/g, '$1');                 // collapse repeats: хуууй → хуй
}

function normalizeLatin(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z]/g, '')                    // strip non-Latin
    .replace(/(.)\1+/g, '$1');                 // collapse repeats: fuuuck → fuck
}

// ── Pre-normalise at load time ────────────────────────────────────────────────
const CYRILLIC_WHITELIST = WHITELIST.ru.map(normalizeCyrillic);
const LATIN_WHITELIST    = WHITELIST.en.map(normalizeLatin);
// Normalize English roots too so collapsed inputs still match (nigg→nig, pussy→pusy)
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

  s = maskWhitelist(s, CYRILLIC_WHITELIST, 4);
  return RUSSIAN_ROOTS.some(root => s.includes(root));
}

function checkLatin(name) {
  let s = normalizeLatin(name);
  if (!s) return false;
  s = maskWhitelist(s, LATIN_WHITELIST, 4);
  return LATIN_ROOTS_NORM.some(root => s.includes(root));
}

function containsProfanity(name) {
  return checkCyrillic(name) || checkLatin(name);
}

module.exports = { normalizeNickname: normalizeCyrillic, containsProfanity };
