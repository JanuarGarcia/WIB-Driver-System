const fs = require('fs');
const path = require('path');

const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;

let cache = { at: 0, stemToFile: /** @type {Map<string, string> | null} */ (null) };
const CACHE_MS = 45_000;

function readStemIndex(dir) {
  const stemToFile = new Map();
  if (!fs.existsSync(dir)) return stemToFile;
  const names = fs.readdirSync(dir);
  for (const n of names) {
    if (!IMAGE_EXT.test(n)) continue;
    const stem = n.replace(/\.[^.]+$/, '');
    stemToFile.set(stem.toLowerCase(), n);
  }
  return stemToFile;
}

/**
 * @param {string} merchantsDir absolute path to uploads/merchants
 */
function getMerchantsStemIndex(merchantsDir) {
  const now = Date.now();
  if (!cache.stemToFile || now - cache.at > CACHE_MS) {
    cache.stemToFile = readStemIndex(merchantsDir);
    cache.at = now;
  }
  return cache.stemToFile;
}

function nameWords(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\u2019/g, "'")
    .replace(/['`]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function addSlug(set, words) {
  if (!words.length) return;
  const s = words.join('-');
  if (s.length >= 2) set.add(s);
}

function emitSlugVariants(words, slugs) {
  addSlug(slugs, words);
  let w2 = [...words];
  while (w2.length && ['the', 'a', 'an'].includes(w2[0])) w2 = w2.slice(1);
  addSlug(slugs, w2);
}

/** Hyphen slugs to try against filenames in uploads/merchants (e.g. rose-cafe, the-good-taste-restaurant). */
function logoSlugCandidates(restaurantName) {
  const words = nameWords(restaurantName);
  const slugs = new Set();
  if (!words.length) return [];

  emitSlugVariants(words, slugs);
  const fillers = ['original', 'new', 'old'];
  for (const f of fillers) {
    const w2 = words.filter((x) => x !== f);
    if (w2.length !== words.length) emitSlugVariants(w2, slugs);
  }
  return [...slugs];
}

function basenameOnly(logoRaw) {
  let s = String(logoRaw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  s = s.replace(/\\/g, '/');
  s = s.replace(/^.*\/uploads\/merchants\//i, '').replace(/^\/?uploads\/merchants\//i, '');
  const parts = s.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

/**
 * On-disk filename under uploads/merchants, or null if none matched.
 * @param {string | null | undefined} dbLogo
 * @param {string | null | undefined} restaurantName
 * @param {string} merchantsDir
 * @returns {string | null}
 */
function resolveMerchantLogoFileBasename(dbLogo, restaurantName, merchantsDir) {
  const index = getMerchantsStemIndex(merchantsDir);
  if (!index.size) return null;

  const tryStem = (stem) => {
    if (!stem) return null;
    return index.get(String(stem).toLowerCase()) || null;
  };

  const db = String(dbLogo || '').trim();
  if (db && !/^https?:\/\//i.test(db)) {
    const base = basenameOnly(db);
    if (base && !/^https?:\/\//i.test(base)) {
      if (IMAGE_EXT.test(base)) {
        const stem = base.replace(/\.[^.]+$/, '');
        const hit = tryStem(stem);
        if (hit) return hit;
        for (const file of index.values()) {
          if (file.toLowerCase() === base.toLowerCase()) return file;
        }
      } else {
        const hit = tryStem(base);
        if (hit) return hit;
      }
    }
  }

  for (const slug of logoSlugCandidates(restaurantName)) {
    const hit = tryStem(slug);
    if (hit) return hit;
  }
  return null;
}

/**
 * Value for API `logo` / `logo_url`: external URL unchanged, else basename in uploads/merchants when found on disk.
 * @param {{ logo?: unknown, logo_url?: unknown, image_url?: unknown, restaurant_name?: unknown }} row
 * @param {string} merchantsDir
 */
function resolveMerchantLogoForApi(row, merchantsDir) {
  const raw = row.logo_url ?? row.logo ?? row.image_url;
  const s = raw != null && String(raw).trim() ? String(raw).trim() : '';
  if (/^https?:\/\//i.test(s)) return s;
  const onDisk = resolveMerchantLogoFileBasename(s, row.restaurant_name, merchantsDir);
  return onDisk || (s ? basenameOnly(s) : null);
}

module.exports = {
  resolveMerchantLogoFileBasename,
  resolveMerchantLogoForApi,
  getMerchantsStemIndex,
};
