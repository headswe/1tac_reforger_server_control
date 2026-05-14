// workshop/catalog.js — local catalog of subscribed workshop items.
//
// catalog.json maps modId → a slim entry derived from the workshop API. It is
// the source of truth for available scenarios and for update checking.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchDetail } from './api.js';

const WORKSHOP_DIR = dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = join(WORKSHOP_DIR, 'catalog.json');

export async function load() {
  if (!existsSync(CATALOG_FILE)) return {};
  try { return JSON.parse(await readFile(CATALOG_FILE, 'utf8')); }
  catch (e) { throw new Error(`workshop/catalog.json is invalid JSON: ${e.message}`); }
}

export async function save(catalog) {
  await mkdir(WORKSHOP_DIR, { recursive: true });
  await writeFile(CATALOG_FILE, JSON.stringify(catalog, null, 2));
}

// Reforger tags game modes with "#AR-..." localization keys; turn them into
// something human-readable, falling back to the raw value.
function cleanGameMode(s) {
  if (!s) return '';
  const gm = String(s).match(/GameMode_(\w+)/);
  if (gm) return gm[1];
  if (/ServerScenario/.test(s)) return 'Scenario';
  return s.startsWith('#') ? s.replace(/^#AR-[^_]*_?/, '') : s;
}

// Map a workshop API `asset` object to our slim catalog entry.
export function toEntry(asset) {
  return {
    name:        asset.name,
    version:     asset.currentVersionNumber ?? null,
    versionId:   asset.currentVersionId ?? null,
    size:        asset.currentVersionSize ?? null,
    gameVersion: asset.gameVersion ?? null,
    obsolete:    asset.obsolete ?? false,
    dependencies: (asset.dependencies ?? [])
      .map(d => ({ modId: d.asset?.id, name: d.asset?.name }))
      .filter(d => d.modId),
    scenarios: (asset.scenarios ?? [])
      .map(s => ({
        name:        s.name,
        scenarioId:  s.gameId,
        gameMode:    cleanGameMode(s.gameMode),
        playerCount: s.playerCount ?? null,
      }))
      .filter(s => s.scenarioId),
    lastChecked: new Date().toISOString(),
  };
}

// Subscribe a mod and (recursively) its dependencies. Mutates + returns catalog.
export async function subscribe(catalog, id, name, { _seen = new Set() } = {}) {
  if (_seen.has(id)) return catalog;
  _seen.add(id);
  const asset = await fetchDetail(id, name);
  catalog[id] = toEntry(asset);
  for (const dep of catalog[id].dependencies) {
    await subscribe(catalog, dep.modId, dep.name, { _seen });
  }
  return catalog;
}

// Re-fetch every entry, return a list of changes. Does not mutate the catalog;
// each change carries a fresh `entry` the caller can commit if it wants.
export async function checkUpdates(catalog) {
  const changes = [];
  for (const [id, entry] of Object.entries(catalog)) {
    let asset;
    try {
      asset = await fetchDetail(id, entry.name);
    } catch (e) {
      changes.push({ modId: id, name: entry.name, error: e.message });
      continue;
    }
    const fresh = toEntry(asset);
    if (fresh.versionId !== entry.versionId || fresh.obsolete !== entry.obsolete) {
      changes.push({
        modId:       id,
        name:        entry.name,
        from:        entry.version,
        to:          fresh.version,
        obsolete:    fresh.obsolete,
        gameVersion: fresh.gameVersion,
        entry:       fresh,
      });
    }
  }
  return changes;
}

// Flatten all scenarios across the catalog, each tagged with its providing mod.
export function allScenarios(catalog) {
  const out = [];
  for (const [id, entry] of Object.entries(catalog)) {
    for (const sc of entry.scenarios ?? []) {
      out.push({ ...sc, modId: id, modName: entry.name });
    }
  }
  return out;
}

export function findScenario(catalog, scenarioId) {
  for (const [id, entry] of Object.entries(catalog)) {
    const sc = (entry.scenarios ?? []).find(s => s.scenarioId === scenarioId);
    if (sc) return { ...sc, modId: id, modName: entry.name };
  }
  return null;
}

// Resolve a scenario + chosen addon modIds into a flat, deduped mod list ready
// for game.mods. Walks dependency trees; last-wins on modId conflicts.
export function resolveMods(catalog, scenarioId, addonIds = []) {
  const provider = findScenario(catalog, scenarioId);
  if (!provider) throw new Error(`no catalog mod provides scenario ${scenarioId}`);

  const out = new Map();
  const visit = (id) => {
    const entry = catalog[id];
    if (!entry) {
      // unknown dependency — still list it so Reforger fetches it
      if (!out.has(id)) out.set(id, { modId: id });
      return;
    }
    for (const dep of entry.dependencies ?? []) visit(dep.modId);
    const mod = { modId: id, name: entry.name };
    if (entry.version) mod.version = entry.version;
    out.set(id, mod);
  };

  visit(provider.modId);
  for (const a of addonIds) visit(a);
  return [...out.values()];
}
