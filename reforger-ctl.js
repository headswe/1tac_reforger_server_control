#!/usr/bin/env node
// reforger-ctl.js — interactive control for one Arma Reforger server.
//
// Layout:
//   base.json          — shared infrastructure (ports, rcon, passwords, defaults)
//   servers/*.json     — per-server slim configs (name, scenario, mods, overrides)
//   compiled/*.json    — merged configs actually fed to Reforger (auto-generated)
//   logs/              — per-run server logs
//   state/server.json  — running server tracking

import { select, confirm, input } from '@inquirer/prompts';
import { readdir, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { existsSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import * as api from './workshop/api.js';
import * as catalog from './workshop/catalog.js';

// ── paths ─────────────────────────────────────────────────────────────────
const SCRIPT_DIR   = dirname(fileURLToPath(import.meta.url));
const BASE_FILE    = join(SCRIPT_DIR, 'base.json');
const SERVERS_DIR  = join(SCRIPT_DIR, 'servers');
const MODPACKS_DIR = join(SCRIPT_DIR, 'modpacks');
const COMPILED_DIR = join(SCRIPT_DIR, 'compiled');
const PROFILES_DIR = join(SCRIPT_DIR, 'profiles');
const LOGS_DIR     = join(SCRIPT_DIR, 'logs');
const STATE_DIR    = join(SCRIPT_DIR, 'state');
const STATE_FILE   = join(STATE_DIR, 'server.json');

const REFORGER_DIR = '/home/arma/reforger/reforger';
const REFORGER_BIN = join(REFORGER_DIR, 'ArmaReforgerServer');

// ── colors / cursor ───────────────────────────────────────────────────────
const ESC = '\x1b[';
const c = {
  dim:    s => `${ESC}2m${s}${ESC}0m`,
  bold:   s => `${ESC}1m${s}${ESC}0m`,
  red:    s => `${ESC}31m${s}${ESC}0m`,
  green:  s => `${ESC}32m${s}${ESC}0m`,
  yellow: s => `${ESC}33m${s}${ESC}0m`,
  cyan:   s => `${ESC}36m${s}${ESC}0m`,
  fg:     (n, s) => `${ESC}38;5;${n}m${s}${ESC}0m`,
};
const cur = {
  hide:  () => process.stdout.write(`${ESC}?25l`),
  show:  () => process.stdout.write(`${ESC}?25h`),
  clrLn: () => process.stdout.write(`\r${ESC}K`),
};
process.on('SIGINT',  () => { cur.show(); process.exit(130); });
process.on('SIGTERM', () => { cur.show(); process.exit(143); });

// ── banner ────────────────────────────────────────────────────────────────
const BANNER = [
  ' ____  _____ _____ ___  ____   ____ _____ ____  ',
  '|  _ \\| ____|  ___/ _ \\|  _ \\ / ___| ____|  _ \\ ',
  '| |_) |  _| | |_ | | | | |_) | |  _|  _| | |_) |',
  '|  _ <| |___|  _|| |_| |  _ <| |_| | |___|  _ < ',
  '|_| \\_\\_____|_|   \\___/|_| \\_\\\\____|_____|_| \\_\\',
];
const GRADIENT = [51, 45, 39, 33, 27];

async function showBanner() {
  cur.hide();
  console.log();
  for (let i = 0; i < BANNER.length; i++) {
    console.log('  ' + c.fg(GRADIENT[i], BANNER[i]));
    await sleep(45);
  }
  const tag = 'reforger control · base + servers';
  process.stdout.write('\n  ');
  for (const ch of tag) {
    process.stdout.write(c.dim(ch));
    await sleep(12);
  }
  process.stdout.write('\n\n');
  cur.show();
}

// ── spinner ───────────────────────────────────────────────────────────────
class Spinner {
  constructor() {
    this.frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    this.i = 0; this.text = ''; this.timer = null;
  }
  start(text) {
    this.text = text ?? '';
    cur.hide(); this._tick();
    this.timer = setInterval(() => this._tick(), 80);
    return this;
  }
  update(text) { this.text = text; this._tick(); return this; }
  _tick() {
    cur.clrLn();
    process.stdout.write(`${c.cyan(this.frames[this.i])} ${this.text}`);
    this.i = (this.i + 1) % this.frames.length;
  }
  _end(icon, text) {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    cur.clrLn();
    if (icon || text) process.stdout.write(`${icon} ${text ?? this.text}\n`);
    cur.show();
  }
  succeed(text) { this._end(c.green('✓'), text); }
  fail(text)    { this._end(c.red('✗'),   text); }
  warn(text)    { this._end(c.yellow('!'),text); }
}

async function pulse(label) {
  const beats = [c.fg(22,'●'), c.fg(34,'●'), c.fg(46,'●'), c.fg(34,'●')];
  cur.hide();
  for (let i = 0; i < beats.length * 2; i++) {
    cur.clrLn();
    process.stdout.write(`${beats[i % beats.length]}  ${label}`);
    await sleep(110);
  }
  cur.clrLn();
  process.stdout.write(`${c.green('●')}  ${label}\n`);
  cur.show();
}

// ── deep merge (objects merge, arrays/primitives replace) ─────────────────
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return structuredClone(over ?? base);
  const out = structuredClone(base);
  for (const k of Object.keys(over)) {
    out[k] = (isPlainObject(out[k]) && isPlainObject(over[k]))
      ? deepMerge(out[k], over[k])
      : structuredClone(over[k]);
  }
  return out;
}

// ── helpers ───────────────────────────────────────────────────────────────
async function ensureDirs() {
  await mkdir(SERVERS_DIR,  { recursive: true });
  await mkdir(MODPACKS_DIR, { recursive: true });
  await mkdir(COMPILED_DIR, { recursive: true });
  await mkdir(PROFILES_DIR, { recursive: true });
  await mkdir(LOGS_DIR,     { recursive: true });
  await mkdir(STATE_DIR,    { recursive: true });
}
function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}
function formatSize(bytes) {
  if (bytes == null) return '—';
  const mb = bytes / 1048576;
  return mb < 1024 ? `${mb.toFixed(0)} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

// ── load base + modpacks + servers ────────────────────────────────────────
async function loadBase() {
  if (!existsSync(BASE_FILE)) {
    throw new Error(`Missing ${BASE_FILE} — see README for the template`);
  }
  try { return JSON.parse(await readFile(BASE_FILE, 'utf8')); }
  catch (e) { throw new Error(`base.json is invalid JSON: ${e.message}`); }
}

async function loadModpacks() {
  const packs = {};
  if (!existsSync(MODPACKS_DIR)) return packs;
  const files = await readdir(MODPACKS_DIR);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const name = file.replace(/\.json$/, '');
    try {
      const data = JSON.parse(await readFile(join(MODPACKS_DIR, file), 'utf8'));
      if (!Array.isArray(data.mods)) {
        packs[name] = { error: 'mods array missing' };
        continue;
      }
      packs[name] = { mods: data.mods, description: data.description ?? '' };
    } catch (e) {
      packs[name] = { error: e.message };
    }
  }
  return packs;
}

// Resolve game.modpacks → flat game.mods array, dedup by modId (last wins).
// Returns { merged, packCount, modCount } or { error }.
function expandModpacks(merged, packs) {
  const requested = merged?.game?.modpacks;
  if (requested != null && !Array.isArray(requested)) {
    return { error: 'game.modpacks must be an array' };
  }
  const reqList = requested ?? [];

  const collected = [];
  const missing = [];
  const broken = [];
  for (const name of reqList) {
    const pack = packs[name];
    if (!pack)        { missing.push(name); continue; }
    if (pack.error)   { broken.push(`${name} (${pack.error})`); continue; }
    collected.push(...pack.mods);
  }
  if (missing.length) return { error: `unknown modpack: ${missing.join(', ')}` };
  if (broken.length)  return { error: `broken modpack: ${broken.join(', ')}` };

  // explicit mods come after packs, so they override on modId conflicts
  const explicit = Array.isArray(merged?.game?.mods) ? merged.game.mods : [];
  const all = [...collected, ...explicit];

  const seen = new Map();
  for (const mod of all) {
    if (!mod?.modId) continue;
    seen.set(mod.modId, mod);
  }

  const out = structuredClone(merged);
  out.game.mods = [...seen.values()];
  delete out.game.modpacks;
  return { merged: out, packCount: reqList.length, modCount: out.game.mods.length };
}

async function loadServers(base, packs) {
  if (!existsSync(SERVERS_DIR)) return [];
  const files = await readdir(SERVERS_DIR);
  const out = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const path = join(SERVERS_DIR, file);
    try {
      const data = JSON.parse(await readFile(path, 'utf8'));
      const merged = deepMerge(base, data);

      let error = validateMerged(merged);
      let finalMerged = merged;
      let packCount = 0;

      if (!error) {
        const expanded = expandModpacks(merged, packs);
        if (expanded.error) {
          error = expanded.error;
        } else {
          finalMerged = expanded.merged;
          packCount = expanded.packCount;
        }
      }

      out.push({ file, path, data, merged: finalMerged, packCount, error });
    } catch (e) {
      out.push({ file, path, data: null, merged: null, packCount: 0, error: e.message });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function validateMerged(m) {
  if (!m?.game?.name)       return 'missing game.name';
  if (!m?.game?.scenarioId) return 'missing game.scenarioId';
  const grass = m?.game?.gameProperties?.serverMinGrassDistance;
  if (grass != null && grass < 50) {
    return `serverMinGrassDistance must be >= 50 (got ${grass})`;
  }
  return null;
}

function summarize(cfg) {
  if (cfg.error) return `${cfg.file}  ${c.red('⚠ ' + cfg.error)}`;
  const d = cfg.merged;
  const name     = d.game.name;
  const scenario = basename(d.game.scenarioId)
    .replace(/\.conf$/, '').replace(/^\{[^}]+\}/, '');
  const maxP = d.game.maxPlayers ?? '?';
  const port = d.bindPort ?? '?';
  const mods = d.game.mods?.length ?? 0;
  const modsLabel = cfg.packCount > 0
    ? `${mods} mods (${cfg.packCount} pack${cfg.packCount === 1 ? '' : 's'})`
    : `${mods} mods`;
  const left  = `${c.bold(name.padEnd(28))} ${c.dim('·')} ${scenario.padEnd(22)}`;
  const right = `${c.dim('·')} ${String(maxP).padStart(3)}p ${c.dim('·')} :${port} ${c.dim('·')} ${modsLabel}`;
  return `${left} ${right}  ${c.dim('(' + cfg.file + ')')}`;
}

// ── state ─────────────────────────────────────────────────────────────────
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    const s = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    if (!isAlive(s.pid)) { await unlink(STATE_FILE).catch(() => {}); return null; }
    return s;
  } catch { return null; }
}
async function writeState(s) { await writeFile(STATE_FILE, JSON.stringify(s, null, 2)); }
async function clearState()  { await unlink(STATE_FILE).catch(() => {}); }

// ── start / stop ──────────────────────────────────────────────────────────
async function compileConfig(cfg) {
  const compiledName = cfg.file; // keeps same name → easy to correlate
  const compiledPath = join(COMPILED_DIR, compiledName);
  await writeFile(compiledPath, JSON.stringify(cfg.merged, null, 2));
  return compiledPath;
}

async function startServer(cfg) {
  const name = cfg.merged.game.name;
  const spin = new Spinner().start(`Compiling ${c.bold(name)}…`);

  if (!existsSync(REFORGER_BIN)) {
    spin.fail(`Reforger binary not found at ${REFORGER_BIN}`);
    return null;
  }

  const compiledPath = await compileConfig(cfg);

  const profileName = cfg.file.replace(/\.json$/, '');
  const profilePath = join(PROFILES_DIR, profileName);
  await mkdir(profilePath, { recursive: true });

  spin.update(`Spawning ${c.bold(name)}…`);

  const logName = `${profileName}_${timestamp()}.log`;
  const logPath = join(LOGS_DIR, logName);
  const logFd   = openSync(logPath, 'a');

  const args = [
    `-config=${compiledPath}`,
    `-profile=${profilePath}`,
    '-maxFPS=60',
    `-logFile=${logPath}`,
    '-noLauncher',
    '-headless',
  ];

  const child = spawn(REFORGER_BIN, args, {
    cwd: REFORGER_DIR,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();

  spin.update('Verifying process is alive…');
  await sleep(1200);
  if (!isAlive(child.pid)) {
    spin.fail(`Server exited immediately — check ${logPath}`);
    return null;
  }

  await writeState({
    pid: child.pid,
    serverFile: cfg.file,
    compiledFile: compiledPath,
    profileDir: profilePath,
    serverName: name,
    logFile: logPath,
    startedAt: new Date().toISOString(),
  });

  spin.succeed(`Server up — pid ${c.bold(child.pid)}`);
  console.log(`  ${c.dim('compiled:')} ${compiledPath}`);
  console.log(`  ${c.dim('profile:')}  ${profilePath}`);
  console.log(`  ${c.dim('log:')}      ${logPath}`);
  return { pid: child.pid, logPath };
}

async function stopServer(state) {
  const spin = new Spinner().start(`Sending SIGTERM to pid ${state.pid}…`);
  try { process.kill(state.pid, 'SIGTERM'); }
  catch { spin.warn('Process already gone'); await clearState(); return; }

  spin.update('Waiting for clean shutdown…');
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (!isAlive(state.pid)) {
      spin.succeed(`Stopped cleanly after ${((i + 1) * 0.5).toFixed(1)}s`);
      await clearState();
      return;
    }
    if (i === 10) spin.update('Still running, holding on…');
    if (i === 20) spin.update('Almost out of patience…');
  }
  spin.warn('Timeout — escalating to SIGKILL');
  try { process.kill(state.pid, 'SIGKILL'); } catch {}
  await sleep(500);
  await clearState();
}

// ── menus ─────────────────────────────────────────────────────────────────
async function runningMenu(state, firstView) {
  const uptime = formatDuration(Date.now() - new Date(state.startedAt).getTime());
  const header = `${c.bold(state.serverName)}  ${c.dim('·')}  up ${uptime}`;

  console.log();
  if (firstView) await pulse(header);
  else console.log(`${c.green('●')}  ${header}`);
  console.log(`   ${c.dim('server:')}   ${state.serverFile}    ${c.dim('pid:')} ${state.pid}`);
  console.log(`   ${c.dim('compiled:')} ${state.compiledFile}`);
  console.log(`   ${c.dim('profile:')}  ${state.profileDir ?? '—'}`);
  console.log(`   ${c.dim('log:')}      ${state.logFile}`);
  console.log();

  const choice = await select({
    message: 'Action:',
    choices: [
      { name: 'Stop server',              value: 'stop' },
      { name: 'Tail log (Ctrl+C exits)',  value: 'tail' },
      { name: 'Refresh',                  value: 'refresh' },
      { name: 'Quit (leave running)',     value: 'exit' },
    ],
  });

  if (choice === 'stop') {
    if (await confirm({ message: `Stop ${state.serverName}?`, default: false })) {
      await stopServer(state);
    }
  } else if (choice === 'tail') {
    await tailLog(state.logFile);
  } else if (choice === 'exit') {
    return 'exit';
  }
}

async function tailLog(logFile) {
  console.log(c.dim(`\n  tailing ${logFile} — Ctrl+C to return\n`));
  return new Promise(resolve => {
    const p = spawn('tail', ['-n', '50', '-f', logFile], { stdio: 'inherit' });
    const onSig = () => p.kill('SIGTERM');
    process.once('SIGINT', onSig);
    p.on('exit', () => { process.off('SIGINT', onSig); resolve(); });
  });
}

// ── workshop ──────────────────────────────────────────────────────────────
function catalogLine(id, entry) {
  const scn  = entry.scenarios?.length ?? 0;
  const dep  = entry.dependencies?.length ?? 0;
  const meta = `${entry.version ?? '?'} · ${scn} scn · ${dep} dep`;
  const flag = entry.obsolete ? '  ' + c.red('obsolete') : '';
  return `${c.bold(entry.name)}  ${c.dim('· ' + meta)}${flag}  ${c.dim(id)}`;
}

async function workshopSearch() {
  const query = (await input({ message: 'Search workshop (name):' })).trim();
  if (!query) return;

  let page = 1;
  let pageSize = 0;
  while (true) {
    const spin = new Spinner().start(`Searching “${query}” — page ${page}…`);
    let res;
    try { res = await api.search(query, page); }
    catch (e) { spin.fail(`Search failed: ${e.message}`); await sleep(900); return; }

    if (page === 1) pageSize = res.rows.length || 1;
    spin.succeed(`${res.count} result${res.count === 1 ? '' : 's'} for “${query}” — page ${page}`);

    if (res.rows.length === 0) { console.log(c.dim('  no results')); await sleep(800); return; }

    const choices = res.rows.map(r => ({
      name: `${c.bold(r.name)}  ${c.dim('· ' + (r.currentVersionNumber ?? '?') +
        ' · ' + (r.subscriberCount ?? 0) + ' subs')}  ${c.dim(r.id)}`,
      value: { kind: 'mod', id: r.id, name: r.name },
    }));
    if (page > 1)                          choices.push({ name: c.dim('‹ previous page'), value: { kind: 'prev' } });
    if (page * pageSize < res.count)        choices.push({ name: c.dim('next page ›'),    value: { kind: 'next' } });
    choices.push({ name: c.dim('— back —'), value: { kind: 'back' } });

    const pick = await select({ message: 'Subscribe to:', choices, pageSize: 20 });
    if (pick.kind === 'back') return;
    if (pick.kind === 'next') { page++; continue; }
    if (pick.kind === 'prev') { page--; continue; }

    const cat  = await catalog.load();
    const spin2 = new Spinner().start(`Subscribing ${c.bold(pick.name)}…`);
    try {
      await catalog.subscribe(cat, pick.id, pick.name);
      await catalog.save(cat);
      const e = cat[pick.id];
      spin2.succeed(`Subscribed ${c.bold(pick.name)} — ` +
        `${e.scenarios.length} scenario(s), ${e.dependencies.length} dependency(ies)`);
    } catch (e) {
      spin2.fail(`Subscribe failed: ${e.message}`);
    }
    await sleep(900);
    return;
  }
}

async function workshopCatalog() {
  let cat;
  try { cat = await catalog.load(); }
  catch (e) { console.log(c.red(`  ${e.message}`)); await sleep(1200); return; }

  const ids = Object.keys(cat);
  if (ids.length === 0) {
    console.log(c.dim('\n  catalog is empty — subscribe to mods first\n'));
    await sleep(900);
    return;
  }

  const choices = ids.map(id => ({ name: catalogLine(id, cat[id]), value: id }));
  choices.push({ name: c.dim('— back —'), value: '__back__' });

  const pick = await select({ message: `Catalog — ${ids.length} mods:`, choices, pageSize: 20 });
  if (pick === '__back__') return;

  const entry = cat[pick];
  console.log();
  console.log(`  ${c.bold(entry.name)}  ${c.dim(pick)}`);
  console.log(`  ${c.dim('version:')} ${entry.version ?? '—'}   ` +
    `${c.dim('game:')} ${entry.gameVersion ?? '—'}   ${c.dim('size:')} ${formatSize(entry.size)}` +
    (entry.obsolete ? `   ${c.red('obsolete')}` : ''));
  if (entry.dependencies?.length) {
    console.log(`  ${c.dim('deps:')}    ${entry.dependencies.map(d => d.name).join(', ')}`);
  }
  if (entry.scenarios?.length) {
    console.log(`  ${c.dim('scenarios:')}`);
    for (const s of entry.scenarios) {
      console.log(`    ${s.name}  ${c.dim('· ' + s.gameMode + ' · ' + (s.playerCount ?? '?') + 'p')}`);
    }
  }
  console.log();

  const action = await select({
    message: 'Action:',
    choices: [
      { name: 'Unsubscribe (remove from catalog)', value: 'remove' },
      { name: c.dim('— back —'),                   value: 'back'   },
    ],
  });
  if (action === 'remove' &&
      await confirm({ message: `Remove ${entry.name}?`, default: false })) {
    delete cat[pick];
    await catalog.save(cat);
    console.log(c.dim(`  removed ${entry.name}`));
    await sleep(600);
  }
}

async function workshopUpdates() {
  let cat;
  try { cat = await catalog.load(); }
  catch (e) { console.log(c.red(`  ${e.message}`)); await sleep(1200); return; }

  const ids = Object.keys(cat);
  if (ids.length === 0) {
    console.log(c.dim('\n  catalog is empty\n'));
    await sleep(900);
    return;
  }

  const spin = new Spinner().start(`Checking ${ids.length} mods for updates…`);
  let changes;
  try { changes = await catalog.checkUpdates(cat); }
  catch (e) { spin.fail(`Update check failed: ${e.message}`); await sleep(900); return; }

  const errors  = changes.filter(ch => ch.error);
  const updates = changes.filter(ch => !ch.error);

  if (updates.length === 0 && errors.length === 0) {
    spin.succeed('All mods up to date');
    await sleep(900);
    return;
  }
  spin.succeed(`${updates.length} update(s) available` +
    (errors.length ? `, ${errors.length} check error(s)` : ''));

  console.log();
  for (const u of updates) {
    const flag = u.obsolete ? '  ' + c.red('OBSOLETE') : '';
    console.log(`  ${c.yellow('↑')} ${c.bold(u.name)}  ${u.from ?? '?'} ${c.dim('→')} ${c.green(u.to ?? '?')}${flag}`);
  }
  for (const e of errors) {
    console.log(`  ${c.red('✗')} ${c.bold(e.name)}  ${c.dim(e.error)}`);
  }
  console.log();

  if (updates.length &&
      await confirm({ message: `Apply ${updates.length} update(s) to catalog?`, default: true })) {
    for (const u of updates) cat[u.modId] = u.entry;
    await catalog.save(cat);
    console.log(c.dim('  catalog updated'));
    await sleep(600);
  }
}

async function workshopMenu() {
  while (true) {
    let count = 0;
    try { count = Object.keys(await catalog.load()).length; } catch {}
    console.log();
    const choice = await select({
      message: `Workshop  ${c.dim('· ' + count + ' mods in catalog')}`,
      choices: [
        { name: 'Search & subscribe', value: 'search'  },
        { name: 'View catalog',       value: 'catalog' },
        { name: 'Check for updates',  value: 'updates' },
        { name: c.dim('— back —'),    value: 'back'    },
      ],
    });
    if (choice === 'back')    return;
    if (choice === 'search')  await workshopSearch();
    if (choice === 'catalog') await workshopCatalog();
    if (choice === 'updates') await workshopUpdates();
  }
}

async function idleMenu(base, servers) {
  // base summary line for context
  const bport = base.bindPort ?? '?';
  const rport = base.rcon?.port ?? '—';
  const aport = base.a2s?.port ?? '—';
  const maxP  = base.game?.maxPlayers ?? '?';
  console.log();
  console.log(c.dim(`  base · :${bport} game · :${aport} a2s · :${rport} rcon · ${maxP}p default`));
  console.log(`${c.dim('○')}  ${c.dim('no server running')}`);
  console.log();

  const choices = servers.map(cfg => ({
    name:  summarize(cfg),
    value: cfg,
    disabled: cfg.error ? c.red(' ' + cfg.error) : false,
  }));
  choices.push({
    name:  `${c.cyan('⚙  Workshop')}  ${c.dim('(search · catalog · updates)')}`,
    value: '__workshop__',
  });
  choices.push({ name: c.dim('— quit —'), value: '__quit__' });

  const pick = await select({
    message: 'Pick a server to start:',
    choices,
    pageSize: 20,
  });

  if (pick === '__quit__')     return 'exit';
  if (pick === '__workshop__') { await workshopMenu(); return; }

  console.log();
  await startServer(pick);
  await sleep(700);
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  await ensureDirs();
  await showBanner();

  let firstRunningView = true;
  let prevPid = null;

  while (true) {
    let base;
    try { base = await loadBase(); }
    catch (e) { console.log(c.red(`fatal: ${e.message}`)); return; }

    const packs   = await loadModpacks();
    const state   = await readState();
    const servers = await loadServers(base, packs);

    if (state && state.pid !== prevPid) firstRunningView = true;
    prevPid = state?.pid ?? null;

    if (!state && servers.length === 0) {
      console.log(c.red(`No *.json files in ${SERVERS_DIR}`));
      return;
    }

    const result = state
      ? await runningMenu(state, firstRunningView)
      : await idleMenu(base, servers);

    firstRunningView = false;
    if (result === 'exit') return;
  }
}

main().catch(e => {
  cur.show();
  if (e?.name === 'ExitPromptError') { console.log(); process.exit(0); }
  console.error(c.red('fatal:'), e.message);
  process.exit(1);
});
