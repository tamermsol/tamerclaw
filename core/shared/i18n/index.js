/**
 * i18n Module — Multi-language support for the TamerClaw Agent Ecosystem
 *
 * Supports: English (en), Arabic (ar)
 * Features:
 *   - Per-user language preference persistence
 *   - Template string interpolation ({var} syntax)
 *   - Nested key access (dot notation: "commands.chat.description")
 *   - RTL awareness
 *   - Fallback to English for missing translations
 *
 * Usage:
 *   import { i18n, getUserLang, setUserLang, t } from '../shared/i18n/index.js';
 *   const lang = getUserLang(userId);
 *   const text = t(lang, 'commands.help.title');
 *   const text2 = t(lang, 'commands.model.switched', { model: 'opus' });
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load Language Files ────────────────────────────────────────────────────

const languages = {};
const SUPPORTED_LANGS = ['en', 'ar'];
const DEFAULT_LANG = 'en';

for (const lang of SUPPORTED_LANGS) {
  try {
    const filePath = join(__dirname, `${lang}.json`);
    languages[lang] = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (e) {
    console.error(`[i18n] Failed to load ${lang}.json:`, e.message);
  }
}

// ── User Language Preferences ──────────────────────────────────────────────

const PREFS_DIR = join(__dirname, '..', '..', '..', 'user', 'data');
const PREFS_FILE = join(PREFS_DIR, 'user-lang-prefs.json');
let userPrefs = {};

function loadPrefs() {
  try {
    if (existsSync(PREFS_FILE)) {
      userPrefs = JSON.parse(readFileSync(PREFS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('[i18n] Failed to load prefs:', e.message);
    userPrefs = {};
  }
}

function savePrefsSafe() {
  try {
    if (!existsSync(PREFS_DIR)) mkdirSync(PREFS_DIR, { recursive: true });
    const tmp = PREFS_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(userPrefs, null, 2));
    renameSync(tmp, PREFS_FILE);
  } catch (e) {
    // Fallback: direct write (no atomic rename)
    try {
      if (!existsSync(PREFS_DIR)) mkdirSync(PREFS_DIR, { recursive: true });
      writeFileSync(PREFS_FILE, JSON.stringify(userPrefs, null, 2));
    } catch (e2) {
      console.error('[i18n] Failed to save prefs:', e2.message);
    }
  }
}

loadPrefs();

// ── Core Functions ─────────────────────────────────────────────────────────

/**
 * Get the nested value from an object using dot notation
 * @param {object} obj
 * @param {string} path - e.g. "commands.chat.description"
 * @returns {string|object|undefined}
 */
function getNestedValue(obj, path) {
  const keys = path.split('.');
  let current = obj;
  for (const key of keys) {
    if (current === undefined || current === null) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Translate a key with optional interpolation
 * @param {string} lang - Language code ('en', 'ar')
 * @param {string} key - Dot-notation key (e.g. "commands.help.title")
 * @param {object} [vars={}] - Variables for interpolation: { model: 'opus' }
 * @returns {string} Translated string
 */
export function t(lang, key, vars = {}) {
  const langData = languages[lang] || languages[DEFAULT_LANG];
  let value = getNestedValue(langData, key);

  // Fallback to English if not found in target language
  if (value === undefined && lang !== DEFAULT_LANG) {
    value = getNestedValue(languages[DEFAULT_LANG], key);
  }

  // Still not found — return the key itself
  if (value === undefined) return key;

  // If it's not a string (e.g. an object), return as-is
  if (typeof value !== 'string') return value;

  // Interpolation: replace {varName} with vars.varName
  if (Object.keys(vars).length > 0) {
    for (const [varName, varValue] of Object.entries(vars)) {
      value = value.replace(new RegExp(`\\{${varName}\\}`, 'g'), String(varValue));
    }
  }

  return value;
}

/**
 * Get user's preferred language
 * @param {string} userId
 * @returns {string} Language code
 */
export function getUserLang(userId) {
  return userPrefs[String(userId)] || DEFAULT_LANG;
}

/**
 * Set user's preferred language
 * @param {string} userId
 * @param {string} lang - 'en' or 'ar'
 * @returns {boolean} Success
 */
export function setUserLang(userId, lang) {
  if (!SUPPORTED_LANGS.includes(lang)) return false;
  userPrefs[String(userId)] = lang;
  savePrefsSafe();
  return true;
}

/**
 * Get language metadata (name, direction, flag)
 * @param {string} lang
 * @returns {object}
 */
export function getLangMeta(lang) {
  const data = languages[lang] || languages[DEFAULT_LANG];
  return data?.meta || { code: lang, name: lang, direction: 'ltr', flag: '' };
}

/**
 * Check if language is RTL
 * @param {string} lang
 * @returns {boolean}
 */
export function isRTL(lang) {
  return getLangMeta(lang).direction === 'rtl';
}

/**
 * Get all supported languages with metadata
 * @returns {Array<{code, name, nativeName, direction, flag}>}
 */
export function getSupportedLanguages() {
  return SUPPORTED_LANGS.map(code => getLangMeta(code));
}

/**
 * Auto-detect language from text (simple heuristic)
 * @param {string} text
 * @returns {string} Language code
 */
export function detectLanguage(text) {
  if (!text) return DEFAULT_LANG;
  // Arabic Unicode range: \u0600-\u06FF, \u0750-\u077F, \uFB50-\uFDFF, \uFE70-\uFEFF
  const arabicChars = (text.match(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  const totalChars = text.replace(/\s/g, '').length;
  if (totalChars > 0 && arabicChars / totalChars > 0.3) return 'ar';
  return DEFAULT_LANG;
}

// ── Convenience: full i18n object ──────────────────────────────────────────

export const i18n = {
  t,
  getUserLang,
  setUserLang,
  getLangMeta,
  isRTL,
  getSupportedLanguages,
  detectLanguage,
  SUPPORTED_LANGS,
  DEFAULT_LANG,
  languages,
};

export default i18n;
