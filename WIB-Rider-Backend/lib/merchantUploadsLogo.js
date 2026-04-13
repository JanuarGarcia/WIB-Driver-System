const fs = require('fs');
const path = require('path');

const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;

/** @type {{ at: number, key: string, stemToFile: Map<string, string> | null }} */
let cache = { at: 0, key: '', stemToFile: null };
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
 * Primary uploads/merchants dir plus legacy sibling uploads/merchant (singular), de-duped.
 * @param {string} merchantsDir absolute path to uploads/merchants (canonical)
 * @returns {string[]}
 */
function merchantLogoSearchDirs(merchantsDir) {
  const p = merchantsDir != null ? String(merchantsDir).trim() : '';
  if (!p) return [];
  const dirs = [p];
  const parent = path.dirname(p);
  const base = path.basename(p).toLowerCase();
  const altName = base === 'merchants' ? 'merchant' : base === 'merchant' ? 'merchants' : null;
  if (altName) {
    const alt = path.join(parent, altName);
    if (alt.toLowerCase() !== p.toLowerCase()) dirs.push(alt);
  }
  return dirs;
}

function readStemIndexMerged(dirs) {
  const merged = new Map();
  for (const dir of dirs) {
    const part = readStemIndex(dir);
    for (const [stem, file] of part) {
      if (!merged.has(stem)) merged.set(stem, file);
    }
  }
  return merged;
}

/**
 * @param {string} merchantsDir absolute path to uploads/merchants (also scans sibling uploads/merchant)
 */
function getMerchantsStemIndex(merchantsDir) {
  const dirs = merchantLogoSearchDirs(merchantsDir);
  const key = dirs.join('\n');
  const now = Date.now();
  if (!cache.stemToFile || cache.key !== key || now - cache.at > CACHE_MS) {
    cache.stemToFile = dirs.length ? readStemIndexMerged(dirs) : new Map();
    cache.key = key;
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

/** Drop last 1–2 tokens so "Mang Inasal Legarda" → tries mang-inasal for mang-inasal.jpg */
function emitTruncatedSlugs(words, slugs) {
  for (let drop = 1; drop <= 2 && words.length - drop >= 1; drop++) {
    const slice = words.slice(0, words.length - drop);
    if (slice.length >= 1) emitSlugVariants(slice, slugs);
  }
}

/** Hyphen slugs to try against filenames in uploads/merchants (e.g. rose-cafe, the-good-taste-restaurant). */
function logoSlugCandidates(restaurantName) {
  const words = nameWords(restaurantName);
  const slugs = new Set();
  if (!words.length) return [];

  emitSlugVariants(words, slugs);
  emitTruncatedSlugs(words, slugs);
  const fillers = ['original', 'new', 'old'];
  for (const f of fillers) {
    const w2 = words.filter((x) => x !== f);
    if (w2.length !== words.length) {
      emitSlugVariants(w2, slugs);
      emitTruncatedSlugs(w2, slugs);
    }
  }
  return [...slugs];
}

function basenameOnly(logoRaw) {
  let s = String(logoRaw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  s = s.replace(/\\/g, '/');
  s = s
    .replace(/^.*\/uploads\/merchants\//i, '')
    .replace(/^\/?uploads\/merchants\//i, '')
    .replace(/^.*\/uploads\/merchant\//i, '')
    .replace(/^\/?uploads\/merchant\//i, '');
  const parts = s.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

function fileExistsInMerchantDirs(canonicalMerchantsDir, base) {
  if (!base || !canonicalMerchantsDir) return false;
  const bn = path.basename(base);
  for (const dir of merchantLogoSearchDirs(canonicalMerchantsDir)) {
    if (!dir) continue;
    try {
      const fp = path.join(dir, bn);
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * Last resort: match longest restaurant tokens against on-disk stems (handles branch names vs file slug).
 */
function fuzzyMatchRestaurantToFile(restaurantName, index) {
  const words = nameWords(restaurantName).filter((w) => w.length >= 3);
  if (!words.length || !index.size) return null;
  let bestFile = null;
  let bestScore = 0;
  for (const file of index.values()) {
    const stem = file.replace(/\.[^.]+$/, '').toLowerCase();
    let score = 0;
    for (const w of words) {
      if (stem.includes(w)) score += w.length;
    }
    if (score > bestScore) {
      bestScore = score;
      bestFile = file;
    }
  }
  return bestScore >= 5 ? bestFile : null;
}

/** Collect slug strings from one word list (legacy DB filename hints). */
function emitSlugVariantsToList(words) {
  const slugs = new Set();
  emitSlugVariants(words, slugs);
  return [...slugs];
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

  const tryFileOnDisk = (base) => {
    if (!base || !IMAGE_EXT.test(base)) return null;
    const bn = path.basename(base);
    if (fileExistsInMerchantDirs(merchantsDir, bn)) return bn;
    for (const file of index.values()) {
      if (file.toLowerCase() === bn.toLowerCase()) return file;
    }
    return null;
  };

  const db = String(dbLogo || '').trim();
  if (db && !/^https?:\/\//i.test(db)) {
    const base = basenameOnly(db);
    if (base && !/^https?:\/\//i.test(base)) {
      const direct = tryFileOnDisk(base);
      if (direct) return direct;

      if (IMAGE_EXT.test(base)) {
        const stem = base.replace(/\.[^.]+$/, '');
        const hit = tryStem(stem);
        if (hit) return hit;

        /* Legacy: 1741611241-logo.jpg → try logo.jpg / stem "logo" */
        const legacy = base.match(/^(\d+)-(.+)$/);
        if (legacy) {
          const rest = legacy[2].trim();
          const rDirect = tryFileOnDisk(rest);
          if (rDirect) return rDirect;
          if (IMAGE_EXT.test(rest)) {
            const restStem = rest.replace(/\.[^.]+$/, '');
            const h2 = tryStem(restStem);
            if (h2) return h2;
            const restWords = nameWords(restStem.replace(/-/g, ' '));
            if (restWords.length) {
              for (const slug of emitSlugVariantsToList(restWords)) {
                const h3 = tryStem(slug);
                if (h3) return h3;
              }
            }
          }
        }

        /* Spaces in legacy filename: tea house.jpg → tea-house style */
        const deSpaceStem = stem.replace(/\s+/g, '-').replace(/-+/g, '-');
        const h4 = tryStem(deSpaceStem);
        if (h4) return h4;
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

  return fuzzyMatchRestaurantToFile(restaurantName, index);
}

/**
 * Basename of a file in uploads/merchants (or sibling uploads/merchant) for dashboard map + merchant list.
 * Does not use DB `logo` / `logo_url` / `image_url` — only on-disk files matched from `restaurant_name` (slug + fuzzy rules).
 * @param {{ restaurant_name?: unknown, restaurantName?: unknown }} row
 * @param {string} merchantsDir
 * @returns {string | null}
 */
function resolveMerchantLogoForApi(row, merchantsDir) {
  const name = row?.restaurant_name ?? row?.restaurantName;
  return resolveMerchantLogoFileBasename('', name, merchantsDir);
}

module.exports = {
  resolveMerchantLogoFileBasename,
  resolveMerchantLogoForApi,
  getMerchantsStemIndex,
  merchantLogoSearchDirs,
};
