// workshop/api.js — unofficial client for the Arma Reforger Workshop site.
//
// The site is a Next.js app; we read its data routes (/_next/data/<buildId>/…).
// buildId changes on every redeploy, so we scrape + cache it and re-scrape on 404.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN       = 'https://reforger.armaplatform.com';
const WORKSHOP_DIR = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE   = join(WORKSHOP_DIR, '.cache.json');
const BUILD_ID_TTL = 60 * 60 * 1000; // 1h
const NET_RETRIES  = 4;

// the site sits behind a CDN that 403s requests without a browser-like UA
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let buildIdMem = null; // { buildId, fetchedAt }

async function readCache() {
  if (!existsSync(CACHE_FILE)) return null;
  try { return JSON.parse(await readFile(CACHE_FILE, 'utf8')); }
  catch { return null; }
}
async function writeCache(obj) {
  try { await writeFile(CACHE_FILE, JSON.stringify(obj, null, 2)); }
  catch { /* cache is best-effort */ }
}

// fetch with exponential-backoff retry on network errors (not on HTTP responses).
async function fetchRetry(url, opts = {}) {
  let delay = 2000;
  const merged = { ...opts, headers: { 'user-agent': USER_AGENT, ...(opts.headers ?? {}) } };
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, merged);
    } catch (e) {
      if (attempt >= NET_RETRIES) {
        throw new Error(`network error after ${NET_RETRIES} retries: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

async function scrapeBuildId() {
  const res = await fetchRetry(`${ORIGIN}/workshop`, { headers: { accept: 'text/html' } });
  if (!res.ok) throw new Error(`workshop page returned HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('could not locate __NEXT_DATA__ in workshop page');
  let data;
  try { data = JSON.parse(m[1]); }
  catch (e) { throw new Error(`__NEXT_DATA__ is not valid JSON: ${e.message}`); }
  if (!data.buildId) throw new Error('__NEXT_DATA__ has no buildId');
  return data.buildId;
}

export async function getBuildId({ force = false } = {}) {
  const now = Date.now();
  if (!force && buildIdMem && now - buildIdMem.fetchedAt < BUILD_ID_TTL) {
    return buildIdMem.buildId;
  }
  if (!force) {
    const cached = await readCache();
    if (cached?.buildId && now - cached.fetchedAt < BUILD_ID_TTL) {
      buildIdMem = { buildId: cached.buildId, fetchedAt: cached.fetchedAt };
      return cached.buildId;
    }
  }
  const buildId = await scrapeBuildId();
  buildIdMem = { buildId, fetchedAt: now };
  await writeCache({ buildId, fetchedAt: now });
  return buildId;
}

// GET a Next.js data route, transparently re-scraping buildId once on 404.
async function getData(pathAndQuery) {
  let buildId = await getBuildId();
  for (let stale = 0; stale < 2; stale++) {
    const url = `${ORIGIN}/_next/data/${buildId}${pathAndQuery}`;
    const res = await fetchRetry(url, { headers: { accept: 'application/json' } });
    if (res.status === 404 && stale === 0) {
      buildId = await getBuildId({ force: true });
      continue;
    }
    if (!res.ok) throw new Error(`workshop API returned HTTP ${res.status} for ${pathAndQuery}`);
    return res.json();
  }
  throw new Error(`workshop API 404 even after buildId refresh: ${pathAndQuery}`);
}

// Build the detail-route slug: "<id>-<NameWithoutSpaces>". The site derives the
// real id by splitting on the first "-", so the name portion is cosmetic — but
// the route still needs a slug segment.
export function detailSlug(id, name) {
  const namePart = String(name ?? '')
    .replace(/[^a-zA-Z0-9 ]+/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join('');
  return namePart ? `${id}-${namePart}` : id;
}

export async function search(query, page = 1) {
  const q = encodeURIComponent(query ?? '');
  const data = await getData(`/workshop.json?search=${q}&page=${page}`);
  const assets = data?.pageProps?.assets ?? { count: 0, rows: [] };
  return { count: assets.count ?? 0, page, rows: assets.rows ?? [] };
}

export async function fetchDetail(id, name) {
  const slug = detailSlug(id, name);
  const data = await getData(
    `/workshop/${encodeURIComponent(slug)}.json?id=${encodeURIComponent(slug)}`,
  );
  const asset = data?.pageProps?.asset;
  if (!asset) throw new Error(`no asset in detail response for ${id}`);
  return asset;
}
