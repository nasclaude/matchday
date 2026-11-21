#!/usr/bin/env node
// Encrypts the day's slips for every device key in keys/ and writes:
//   data/latest.json            (newest report)
//   data/archive/<date>.json    (history)
// Only these encrypted files may be committed. Keep slips.json / report.md OUTSIDE the repository.
//
// Usage:
//   node tools/publish.mjs --slips /tmp/matchday/slips.json [--report /tmp/matchday/report.md] [--dry-run]
//   node tools/publish.mjs --self-test
//
// Format of slips.json: see tools/SCHEMA.md.
// Crypto (must match app.js): ECDH P-256 with a fresh ephemeral key per device -> HKDF-SHA256
// (random 16-byte salt, info "matchday-v1") -> AES-256-GCM (random 12-byte IV, AAD = device kid).

import { readFile, writeFile, readdir, mkdir, unlink, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { subtle } = globalThis.crypto;
const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const enc = new TextEncoder();
const dec = new TextDecoder();
const INFO = enc.encode('matchday-v1');
const ALG = { name: 'ECDH', namedCurve: 'P-256' };
const KEEP_ARCHIVE = 180;

const b64u = (buf) => Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf).toString('base64url');
const unb64u = (s) => new Uint8Array(Buffer.from(String(s), 'base64url'));
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

function fail(msg) {
  console.error(`publish: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--self-test') opt.selfTest = true;
    else if (a === '--dry-run') opt.dryRun = true;
    else if (a === '--slips') opt.slips = argv[++i];
    else if (a === '--report') opt.report = argv[++i];
    else if (a === '--help' || a === '-h') opt.help = true;
    else fail(`unknown argument ${a}`);
  }
  return opt;
}

export async function computeKid(jwk) {
  const d = await subtle.digest('SHA-256', enc.encode(`${jwk.x}.${jwk.y}`));
  return b64u(d).slice(0, 16);
}

async function importPublic(jwk) {
  return subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, ALG, false, []);
}

async function loadKeys() {
  const dir = path.join(ROOT, 'keys');
  if (!existsSync(dir)) return [];
  const keys = [];
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()) {
    let j;
    try {
      j = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    } catch (e) {
      console.warn(`publish: skipping keys/${f}: not valid JSON (${e.message})`);
      continue;
    }
    const jwk = j.jwk || j;
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y || jwk.d) {
      console.warn(`publish: skipping keys/${f}: not a P-256 PUBLIC key`);
      continue;
    }
    const kid = await computeKid(jwk);
    if (j.kid && j.kid !== kid) console.warn(`publish: keys/${f}: kid in file (${j.kid}) doesn't match the key; using ${kid}`);
    keys.push({ file: f, name: j.name || f.replace(/\.json$/, ''), kid, pub: await importPublic(jwk) });
  }
  return keys;
}

async function encryptFor(key, plaintext) {
  const eph = await subtle.generateKey(ALG, true, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: key.pub }, eph.privateKey, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const aes = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(key.kid) }, aes, plaintext);
  const e = await subtle.exportKey('jwk', eph.publicKey);
  return { kid: key.kid, epk: { kty: 'EC', crv: 'P-256', x: e.x, y: e.y }, salt: b64u(salt), iv: b64u(iv), ct: b64u(ct) };
}

async function decryptFor(env, kid, privateKey) {
  const r = env.recipients.find((x) => x.kid === kid);
  if (!r) throw new Error('no recipient entry for this key');
  const epk = await importPublic(r.epk);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: epk }, privateKey, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const aes = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: unb64u(r.salt), info: INFO }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(r.iv), additionalData: enc.encode(kid) }, aes, unb64u(r.ct));
  return JSON.parse(dec.decode(pt));
}

async function buildEnvelope(keys, payload) {
  const plaintext = enc.encode(JSON.stringify(payload));
  const recipients = [];
  for (const k of keys) recipients.push(await encryptFor(k, plaintext));
  return { v: 1, alg: 'ECDH-P256+HKDF-SHA256+A256GCM', recipients };
}

// Checks the agent's data and recalculates every derived number from the legs.
export function normalise(data) {
  const notes = [];
  if (!data || typeof data !== 'object') throw new Error('slips.json must contain a JSON object');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.date || ''))) throw new Error('"date" must be YYYY-MM-DD');
  data.schema = 1;
  if (!data.generatedAt) data.generatedAt = new Date().toISOString();
  if (!Array.isArray(data.slips)) throw new Error('"slips" must be an array');

  const fix = (obj, key, value, label) => {
    if (obj[key] != null && obj[key] !== '' && Math.abs(Number(obj[key]) - value) > Math.max(Math.abs(value) * 0.02, 0.05)) {
      notes.push(`${label}: ${key} ${obj[key]} corrected to ${value}`);
    }
    obj[key] = value;
  };
  const checkPick = (l, label) => {
    if (!l || typeof l !== 'object') throw new Error(`${label}: must be an object`);
    if (!l.bet || typeof l.bet !== 'string') throw new Error(`${label}: "bet" is required`);
    l.odds = Number(l.odds);
    l.winPct = Number(l.winPct);
    if (!(l.odds > 1)) throw new Error(`${label}: "odds" must be a decimal price above 1`);
    if (!(l.winPct > 0 && l.winPct <= 100)) throw new Error(`${label}: "winPct" must be between 0 and 100`);
    l.bookiePct = round(100 / l.odds, 1);
  };

  for (const [si, s] of data.slips.entries()) {
    const label = `slip ${s.id || si + 1}`;
    if (!s.id) s.id = String.fromCharCode(65 + si);
    s.legs = Array.isArray(s.legs) ? s.legs : [];
    s.stake = Number(s.stake) > 0 ? Number(s.stake) : 5;
    if (!s.legs.length) {
      if (!s.reason) s.reason = 'Not built today.';
      delete s.system;
      continue;
    }
    s.legs.forEach((l, i) => checkPick(l, `${label} leg ${i + 1}`));
    const T = s.legs.reduce((a, l) => a * l.odds, 1);
    const P = s.legs.reduce((a, l) => a * (l.winPct / 100), 1);
    const B = s.legs.reduce((a, l) => a / l.odds, 1);
    fix(s, 'totalOdds', round(T, 2), label);
    fix(s, 'return', round(s.stake * T, 2), label);
    fix(s, 'winChance', round(P * 100, 1), label);
    s.bookieChance = round(B * 100, 1);
    s.profit = round(s.stake * T - s.stake, 2);

    if (s.system && s.legs.length >= 3) {
      const N = s.legs.length;
      const per = s.stake / N;
      const ps = s.legs.map((l) => l.winPct / 100);
      const allWin = ps.reduce((a, p) => a * p, 1);
      let oneMiss = 0;
      ps.forEach((p, i) => {
        oneMiss += (1 - p) * ps.reduce((a, q, j) => (j === i ? a : a * q), 1);
      });
      const missReturns = s.legs.map((l) => (per * T) / l.odds);
      s.system = {
        label: `${N - 1} from ${N}`,
        lines: N,
        stakePerLine: round(per, 2),
        returnAllWin: round(per * T * s.legs.reduce((a, l) => a + 1 / l.odds, 0), 2),
        returnOneMissMin: round(Math.min(...missReturns), 2),
        returnOneMissMax: round(Math.max(...missReturns), 2),
        chanceAllWin: round(allWin * 100, 1),
        chanceOneMiss: round(oneMiss * 100, 1),
        chanceAnyReturn: round((allWin + oneMiss) * 100, 1),
        note: typeof s.system === 'object' && s.system.note ? String(s.system.note) : undefined,
      };
    } else {
      delete s.system;
    }
  }

  data.singles = Array.isArray(data.singles) ? data.singles : [];
  data.singles.forEach((x, i) => {
    checkPick(x, `single ${i + 1}`);
    x.stake = Number(x.stake) > 0 ? Number(x.stake) : 5;
    fix(x, 'return', round(x.stake * x.odds, 2), `single ${i + 1}`);
  });
  for (const k of ['warnings', 'avoid']) if (data[k] != null && !Array.isArray(data[k])) data[k] = [data[k]];
  return notes;
}

function insideRepo(p) {
  const rel = path.relative(ROOT, path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

async function selfTest() {
  const kp = await subtle.generateKey(ALG, false, ['deriveBits']);
  const jwk = await subtle.exportKey('jwk', kp.publicKey);
  const kid = await computeKid(jwk);
  const sample = {
    date: '2026-01-01',
    slips: [{ id: 'A', name: 'Test', stake: 5, legs: [{ bet: 'Team A to win', odds: 1.5, winPct: 70 }, { bet: 'Over 1.5 goals', odds: 1.3, winPct: 80 }] }],
  };
  normalise(sample);
  if (sample.slips[0].totalOdds !== 1.95 || sample.slips[0].return !== 9.75 || sample.slips[0].winChance !== 56) throw new Error('maths check failed');
  const env = await buildEnvelope([{ kid, pub: await importPublic(jwk) }], sample);
  const back = await decryptFor(env, kid, kp.privateKey);
  if (JSON.stringify(back) !== JSON.stringify(sample)) throw new Error('round trip mismatch');
  const other = await subtle.generateKey(ALG, false, ['deriveBits']);
  let rejected = false;
  try {
    await decryptFor(env, kid, other.privateKey);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('a different key could decrypt the data');
  console.log('publish: self-test passed (maths, encryption round trip, wrong key rejected)');
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) {
    console.log('Usage: node tools/publish.mjs --slips <file outside repo> [--report <file outside repo>] [--dry-run] | --self-test');
    return;
  }
  if (opt.selfTest) return selfTest();
  if (!opt.slips) fail('missing --slips <path>');
  if (insideRepo(opt.slips) || (opt.report && insideRepo(opt.report))) {
    fail('keep slips.json and report.md OUTSIDE the repository (e.g. /tmp/matchday/) so plaintext can never be committed');
  }

  let data;
  try {
    data = JSON.parse(await readFile(opt.slips, 'utf8'));
  } catch (e) {
    fail(`can't read ${opt.slips}: ${e.message}`);
  }
  if (opt.report) data.reportMarkdown = await readFile(opt.report, 'utf8');

  let notes;
  try {
    notes = normalise(data);
  } catch (e) {
    fail(`invalid slips.json: ${e.message}`);
  }

  const keys = await loadKeys();
  if (!keys.length) fail('no device keys in keys/. The user must set up the app and add the key it shows as keys/<name>.json');

  const archiveDir = path.join(ROOT, 'data', 'archive');
  await mkdir(archiveDir, { recursive: true });
  const existing = (await readdir(archiveDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10));
  const dates = [...new Set([...existing, data.date])].sort().reverse();
  const keep = dates.slice(0, KEEP_ARCHIVE);
  data.history = keep;

  for (const n of notes) console.log(`publish: ${n}`);
  for (const s of data.slips) {
    console.log(
      s.legs.length
        ? `publish: slip ${s.id}: ${s.legs.length} legs, odds ${s.totalOdds}, €${s.stake} -> €${s.return}, win ${s.winChance}%${s.system ? `, system any-return ${s.system.chanceAnyReturn}%` : ''}`
        : `publish: slip ${s.id}: not built (${s.reason})`,
    );
  }
  if (opt.dryRun) {
    console.log(`publish: dry run, nothing written (${keys.length} device key(s) found)`);
    return;
  }

  const envelope = JSON.stringify(await buildEnvelope(keys, data));
  await writeAtomic(path.join(archiveDir, `${data.date}.json`), envelope);
  const latest = keep[0] === data.date;
  if (latest) await writeAtomic(path.join(ROOT, 'data', 'latest.json'), envelope);
  for (const d of dates.slice(KEEP_ARCHIVE)) await unlink(path.join(archiveDir, `${d}.json`)).catch(() => {});

  console.log(`publish: encrypted for ${keys.length} device(s): ${keys.map((k) => `${k.name} (${k.kid})`).join(', ')}`);
  console.log(`publish: wrote data/archive/${data.date}.json${latest ? ' and data/latest.json' : ' (older than latest.json, which was left unchanged)'}`);
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
