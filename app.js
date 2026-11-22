'use strict';
/*
 * Matchday: shows the daily slips that the research agent publishes.
 *
 * Privacy model
 *  - On first use the app creates an ECDH P-256 key pair with WebCrypto. The private key is
 *    stored on this device only (IndexedDB, non-extractable where the browser allows it).
 *  - The agent encrypts every report with the device's PUBLIC key (ECDH + HKDF-SHA256 +
 *    AES-256-GCM) and uploads only the encrypted file (data/latest.json).
 *  - This page downloads that file from its own origin and decrypts it locally.
 *  - The only other server it talks to is GitHub's API, and only from the Send tab: screenshots
 *    the user picks go straight from this phone to their own PRIVATE inbox repository, using a
 *    token the user pasted into this app (stored on this device only, encrypted at rest with a
 *    non-extractable key). See the Content-Security-Policy in index.html.
 */
(() => {
  const DB_NAME = 'matchday';
  const STORE = 'kv';
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const INFO = enc.encode('matchday-v1');
  const ALG = { name: 'ECDH', namedCurve: 'P-256' };
  const LATEST_URL = 'data/latest.json';
  const archiveUrl = (d) => `data/archive/${encodeURIComponent(d)}.json`;
  const APP_VERSION = 'v4';
  const GH_API = 'https://api.github.com';
  const MAX_SHOTS = 10;
  const MAX_SIDE = 2800; // longest side of an uploaded screenshot, in pixels (keeps odds legible)
  const NOTE_MAX = 500;
  const FINAL = new Set(['done', 'failed', 'cancelled']);

  const $view = document.getElementById('view');
  const $tabbar = document.getElementById('tabbar');
  const $sub = document.getElementById('subtitle');
  const $refresh = document.getElementById('refresh');
  const $toast = document.getElementById('toast');

  const state = {
    dev: null, latest: null, viewing: null, tab: 'slips', offline: false, error: null, lastFetch: 0,
    // Send tab
    inbox: null, requests: [], compose: { files: [], note: '' }, sending: false, sendMsg: '',
  };

  // ---------------------------------------------------------------- icons (static, trusted)
  const SVG = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  const ICONS = {
    slips: SVG('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>'),
    report: SVG('<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>'),
    history: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    key: SVG('<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M16 7l3 3M14 9l2 2"/>'),
    refresh: SVG('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>'),
    lock: SVG('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    chevron: SVG('<path d="m9 6 6 6-6 6"/>'),
    check: SVG('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    send: SVG('<path d="M12 15V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5"/>'),
    x: SVG('<path d="M6 6l12 12M18 6 6 18"/>'),
  };

  // ---------------------------------------------------------------- DOM helpers
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v; // only static icons or escaped Markdown output
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : String(v));
      }
    }
    add(n, kids);
    return n;
  }
  function add(n, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false || k === '') continue;
      n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
  }
  const icon = (name, cls = 'ico') => el('span', { class: cls, html: ICONS[name] });
  function mount(kids) {
    $view.replaceChildren();
    add($view, [kids]);
  }

  // ---------------------------------------------------------------- storage (IndexedDB key/value)
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('aborted'));
    });
  }
  const kvGet = (k) => tx('readonly', (s) => s.get(k));
  const kvSet = (k, v) => tx('readwrite', (s) => s.put(v, k));

  // ---------------------------------------------------------------- base64url
  function b64uEnc(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64uDec(str) {
    const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---------------------------------------------------------------- device key
  function codeErr(code) {
    const e = new Error(code);
    e.code = code;
    return e;
  }
  async function computeKid(jwk) {
    const d = await crypto.subtle.digest('SHA-256', enc.encode(`${jwk.x}.${jwk.y}`));
    return b64uEnc(d).slice(0, 16);
  }
  async function makeDevice(extractable) {
    const kp = await crypto.subtle.generateKey(ALG, extractable, ['deriveBits']);
    const j = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const publicJwk = { kty: 'EC', crv: 'P-256', x: j.x, y: j.y };
    const dev = { name: 'phone', kid: await computeKid(publicJwk), publicJwk, created: new Date().toISOString() };
    if (extractable) dev.privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    else dev.privateKey = kp.privateKey;
    return dev;
  }
  async function createDevice() {
    let dev = await makeDevice(false);
    try {
      await kvSet('device', dev);
    } catch {
      // Some browsers can't store CryptoKey objects; keep the private key as JWK instead.
      dev = await makeDevice(true);
      await kvSet('device', dev);
    }
    try {
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
    } catch { /* best effort */ }
    return dev;
  }
  async function privateKeyOf(dev) {
    if (dev.privateKey) return dev.privateKey;
    if (dev.privateJwk) return crypto.subtle.importKey('jwk', dev.privateJwk, ALG, false, ['deriveBits']);
    throw codeErr('no-key');
  }
  const keyText = (dev) => JSON.stringify({ name: dev.name, kid: dev.kid, jwk: dev.publicJwk, created: dev.created });

  // ---------------------------------------------------------------- decrypt
  async function decrypt(env, dev) {
    if (!env || env.v !== 1 || !Array.isArray(env.recipients)) throw codeErr('bad-format');
    const r = env.recipients.find((x) => x && x.kid === dev.kid);
    if (!r) throw codeErr('not-for-device');
    try {
      const priv = await privateKeyOf(dev);
      const epk = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: r.epk.x, y: r.epk.y, ext: true }, ALG, false, []);
      const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: epk }, priv, 256);
      const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
      const aes = await crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: b64uDec(r.salt), info: INFO },
        hk,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt'],
      );
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64uDec(r.iv), additionalData: enc.encode(dev.kid) }, aes, b64uDec(r.ct));
      return JSON.parse(dec.decode(pt));
    } catch (e) {
      if (e && e.code) throw e;
      throw codeErr('decrypt-failed');
    }
  }

  // ---------------------------------------------------------------- network
  async function fetchEnv(url) {
    const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw codeErr(`http-${res.status}`);
    return res.json();
  }

  // ---------------------------------------------------------------- formatting
  const isNum = (x) => x !== null && x !== '' && Number.isFinite(Number(x));
  const fmtOdds = (x) => (isNum(x) ? Number(x).toFixed(2) : '–');
  const fmtEuro = (x) => (isNum(x) ? `€${Number(x).toFixed(2)}` : '–');
  const fmtPct = (x) => {
    if (!isNum(x)) return '–';
    const v = Number(x);
    return `${v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)}%`;
  };
  const dateOf = (d) => new Date(`${d}T12:00:00`);
  const fmtDay = (d) => (d ? dateOf(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '');
  const fmtDayLong = (d) => (d ? dateOf(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : '');
  const fmtTime = (iso) => {
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? '' : t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };
  const fmtWhen = (iso) => {
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? '' : t.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const todayStr = () => new Date().toLocaleDateString('en-CA');
  const fmtKid = (k) => (String(k || '').match(/.{1,4}/g) || []).join(' ');
  const tier = (p) => (Number(p) >= 75 ? 'good' : Number(p) >= 60 ? 'ok' : 'warn');
  // Reports are identified by their date, or "<date>~<run>" for extra runs such as slips
  // built from the user's own screenshots.
  const ID_RE = /^\d{4}-\d{2}-\d{2}(~[a-z0-9-]{1,24})?$/;
  const idOf = (p) => (p && (p.id || p.date)) || '';
  const isCustom = (p) => !!(p && p.run && p.run !== 'daily');
  const idLabel = (id) => `${fmtDayLong(id.slice(0, 10))}${id.includes('~') ? ' · your matches' : ''}`;

  // ---------------------------------------------------------------- safe Markdown (escapes all HTML first)
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  function inline(s) {
    let t = esc(s);
    const codes = [];
    t = t.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, txt, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>`);
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\w)/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    t = t.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[Number(n)]}</code>`);
    return t;
  }
  const LIST_RE = /^\s*([-*+]|\d+[.)])\s+/;
  function md(src) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }
      if (/^\s*```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        const lvl = Math.min(6, h[1].length + 1);
        out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const body = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) body.push(cells(lines[i++]));
        out.push(
          `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table></div>`,
        );
        continue;
      }
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${md(buf.join('\n'))}</blockquote>`);
        continue;
      }
      if (LIST_RE.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (i < lines.length && LIST_RE.test(lines[i])) {
          let item = lines[i++].replace(LIST_RE, '');
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST_RE.test(lines[i])) item += ` ${lines[i++].trim()}`;
          items.push(item);
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
        continue;
      }
      const buf = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|\s*```|\s*\||\s*>)/.test(lines[i]) && !LIST_RE.test(lines[i])) buf.push(lines[i++]);
      out.push(`<p>${inline(buf.join(' '))}</p>`);
    }
    return out.join('\n');
  }

  // ---------------------------------------------------------------- UI bits
  let toastTimer = 0;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $toast.classList.remove('show'), 2600);
  }
  function setBusy(on) {
    $refresh.classList.toggle('busy', on);
    $refresh.disabled = on;
  }
  const banner = (msg, kind, action) => el('div', { class: `banner${kind ? ` ${kind}` : ''}` }, el('span', { text: msg }), action || null);
  const stat = (label, value) => el('div', { class: 'stat' }, el('div', { class: 'stat-label', text: label }), el('div', { class: 'stat-value', text: value }));
  const pill = (p) => el('span', { class: `pill ${tier(p)}`, text: fmtPct(p), 'aria-label': `${fmtPct(p)} estimated chance to win` });

  function errText(e) {
    const code = (e && e.code) || '';
    if (code === 'not-for-device') return 'The newest report wasn’t locked for this phone’s key yet. Send your key to Claude from the Key tab.';
    if (code === 'decrypt-failed') return 'The newest report couldn’t be unlocked on this phone.';
    if (code === 'bad-format') return 'The newest report is in a format this version of the app doesn’t know.';
    if (code.startsWith('http-')) return 'Couldn’t reach the server. Try again in a minute.';
    return 'Something went wrong while loading the slips.';
  }

  // ---------------------------------------------------------------- views
  const TABS = [
    ['slips', 'Slips'],
    ['send', 'Send'],
    ['report', 'Report'],
    ['history', 'History'],
    ['key', 'Key'],
  ];
  function buildChrome() {
    $refresh.replaceChildren(icon('refresh'));
    $tabbar.replaceChildren(...TABS.map(([id, label]) => el('button', { class: 'tab', type: 'button', 'data-tab': id, onclick: () => go(id) }, icon(id), el('span', { text: label }))));
  }
  function updateTabs() {
    for (const b of $tabbar.children) {
      if (b.dataset.tab === state.tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
  }
  function go(tab) {
    state.tab = tab;
    render(true);
  }

  function render(scrollTop) {
    if (!state.dev) {
      renderSetup();
      return;
    }
    $tabbar.hidden = false;
    $refresh.hidden = false;
    const p = state.viewing || state.latest;
    const kids = [];
    if (state.offline) kids.push(banner('You’re offline. Showing your saved copy.', 'warn'));
    if (state.tab === 'key') kids.push(viewKey());
    else if (state.tab === 'send') kids.push(viewSend());
    else if (!p) kids.push(viewEmpty());
    else {
      if (state.error && state.error.code !== 'no-data' && !state.viewing) kids.push(banner(errText(state.error), 'warn'));
      if (state.tab === 'report') kids.push(viewReport(p));
      else if (state.tab === 'history') kids.push(viewHistory());
      else kids.push(viewSlips(p));
    }
    mount(kids);
    $sub.textContent = p ? `${fmtDay(p.date)}${isCustom(p) ? ' · your matches' : ''}${state.viewing ? ' · earlier report' : ''}` : '';
    updateTabs();
    if (scrollTop) window.scrollTo(0, 0);
  }

  function viewEmpty() {
    const code = state.error && state.error.code;
    if (code === 'not-for-device') {
      return el(
        'section',
        { class: 'card empty' },
        el('h2', { text: 'Waiting for your key' }),
        el('p', { text: 'The latest slips were locked for a different key, so this phone can’t open them yet. Send this phone’s key to Claude, and the next report will include it.' }),
        el('button', { class: 'btn primary', type: 'button', onclick: () => go('key') }, 'Show my key'),
      );
    }
    if (code && code !== 'no-data') return el('section', { class: 'card empty' }, el('h2', { text: 'Couldn’t open the slips' }), el('p', { text: errText(state.error) }));
    if (state.offline) return el('section', { class: 'card empty' }, el('h2', { text: 'You’re offline' }), el('p', { text: 'Connect to the internet, then tap the refresh button.' }));
    if (!state.lastFetch) return el('section', { class: 'card empty' }, el('p', { class: 'muted', text: 'Checking for your slips…' }));
    return el(
      'section',
      { class: 'card empty' },
      el('h2', { text: 'No slips yet' }),
      el('p', { text: 'Your slips arrive after the morning run, usually between 8:45 and 9:15. Tap the refresh button at the top to check.' }),
    );
  }

  function legRow(l, i) {
    return el(
      'li',
      { class: 'leg' },
      el('span', { class: 'leg-n', text: String(i + 1) }),
      el(
        'div',
        { class: 'leg-main' },
        el('div', { class: 'leg-bet', text: l.bet || '' }),
        el('div', { class: 'leg-meta', text: [l.match, l.kickoff, l.bookmaker].filter(Boolean).join(' · ') }),
        l.note ? el('div', { class: 'leg-note', text: l.note }) : null,
      ),
      el('span', { class: 'leg-odds', text: fmtOdds(l.odds) }),
      pill(l.winPct),
    );
  }

  function slipCard(s) {
    const legs = Array.isArray(s.legs) ? s.legs : [];
    const head = el(
      'div',
      { class: 'slip-head' },
      el('div', { class: 'slip-id', text: s.id || '•' }),
      el('div', {}, el('div', { class: 'slip-name', text: s.name || `Slip ${s.id || ''}` }), s.subtitle ? el('div', { class: 'slip-sub', text: s.subtitle }) : null),
      legs.length ? el('div', { class: 'slip-return' }, el('div', { class: 'ret', text: fmtEuro(s.return) }), el('div', { class: 'stake', text: `back on ${fmtEuro(s.stake)}` })) : null,
    );
    const kind = s.kind ? ` kind-${String(s.kind).replace(/[^a-z-]/gi, '')}` : '';
    if (!legs.length) return el('section', { class: `card slip skipped${kind}` }, head, el('p', { text: s.reason || 'Not built today.' }));
    const kids = [
      head,
      el('div', { class: 'legs-head', 'aria-hidden': 'true' }, el('span', { text: '#' }), el('span', { text: 'Bet' }), el('span', { text: 'Odds' }), el('span', { text: 'Win %' })),
      el('ol', { class: 'legs' }, legs.map(legRow)),
      el('div', { class: 'stats' }, stat('Total odds', fmtOdds(s.totalOdds)), stat('Win chance', fmtPct(s.winChance)), stat('Bookies say', fmtPct(s.bookieChance))),
    ];
    if (s.system && typeof s.system === 'object' && isNum(s.system.returnAllWin)) {
      const x = s.system;
      const lo = Math.floor(Number(x.returnOneMissMin));
      const hi = Math.ceil(Number(x.returnOneMissMax));
      kids.push(
        el(
          'div',
          { class: 'system' },
          el('div', { class: 'system-title', text: `System version · ${x.label || ''}` }),
          el('div', { class: 'system-sub', text: `${x.lines} lines × ${fmtEuro(x.stakePerLine)}. If one pick loses, you still get money back.` }),
          el(
            'div',
            { class: 'stats two' },
            stat(`All ${x.lines} win`, fmtEuro(x.returnAllWin)),
            stat('One loses', lo === hi ? `€${lo}` : `€${lo}–€${hi}`),
          ),
          el('div', { class: 'system-chance' }, el('strong', { text: fmtPct(x.chanceAnyReturn) }), ` chance of getting money back (straight slip: ${fmtPct(s.winChance)})`),
          x.note ? el('div', { class: 'system-sub', text: x.note }) : null,
        ),
      );
    }
    if (Array.isArray(s.notes) && s.notes.length) kids.push(el('ul', { class: 'slip-notes' }, s.notes.map((n) => el('li', { text: n }))));
    return el('section', { class: `card slip${kind}`, 'aria-label': s.name || `Slip ${s.id}` }, kids);
  }

  function singleCard(x) {
    return el(
      'section',
      { class: 'card single' },
      el(
        'div',
        {},
        el('div', { class: 'single-label', text: x.label || 'Single' }),
        el('div', { class: 'leg-bet', text: x.bet || '' }),
        el('div', { class: 'leg-meta', text: [x.match, x.kickoff, x.bookmaker].filter(Boolean).join(' · ') }),
        x.note ? el('div', { class: 'leg-note', text: x.note }) : null,
      ),
      el('div', { class: 'single-side' }, el('div', { class: 'single-odds', text: fmtOdds(x.odds) }), pill(x.winPct), el('div', { class: 'single-return', text: `${fmtEuro(x.stake)} → ${fmtEuro(x.return)}` })),
    );
  }

  function viewSlips(p) {
    const out = [];
    if (state.viewing) {
      out.push(banner(`Earlier report: ${fmtDay(p.date)}${isCustom(p) ? ' · your matches' : ''}`, '', el('button', { class: 'link', type: 'button', onclick: () => { state.viewing = null; render(true); } }, 'Back to latest')));
    } else if (p.date && p.date < todayStr()) {
      out.push(banner(`This is the last report (${fmtDay(p.date)}). Today’s slips arrive after the morning run.`));
    }
    out.push(
      el(
        'section',
        { class: 'card hero' },
        el('div', { class: 'hero-date', text: fmtDayLong(p.date) }),
        p.title ? el('div', { class: 'hero-title', text: p.title }) : null,
        el('div', { class: 'hero-meta', text: [p.summary, p.generatedAt ? `updated ${fmtTime(p.generatedAt)}` : null].filter(Boolean).join(' · ') }),
        el('div', { class: 'lock' }, icon('lock'), 'Unlocked on this phone only'),
      ),
    );
    for (const s of p.slips || []) out.push(slipCard(s));
    if (Array.isArray(p.singles) && p.singles.length) out.push(el('h2', { class: 'section-title', text: 'Singles' }), p.singles.map(singleCard));
    if (Array.isArray(p.warnings) && p.warnings.length) {
      out.push(el('section', { class: 'card notes' }, el('h3', { text: 'Before you bet' }), el('ul', {}, p.warnings.map((w) => el('li', { text: w })))));
    }
    if (Array.isArray(p.avoid) && p.avoid.length) {
      out.push(
        el(
          'section',
          { class: 'card notes' },
          el('h3', { text: 'Matches to avoid' }),
          el('ul', {}, p.avoid.map((a) => el('li', {}, el('strong', { text: a.match || '' }), a.reason ? ` · ${a.reason}` : ''))),
        ),
      );
    }
    out.push(el('p', { class: 'fine', text: p.disclaimer || 'These are estimates, not guarantees. Only bet what you can afford to lose.' }));
    return out;
  }

  const viewReport = (p) => el('article', { class: 'card prose', html: md(p.reportMarkdown || '*No full report in this update.*') });

  function viewHistory() {
    const src = state.latest || state.viewing;
    const dates = src && Array.isArray(src.history) ? src.history.filter((d) => ID_RE.test(d)) : [];
    const record = src && typeof src.trackRecord === 'string' && src.trackRecord.trim() ? el('section', { class: 'card prose', html: md(src.trackRecord) }) : null;
    if (!dates.length) return [record, el('section', { class: 'card empty' }, el('p', { text: 'No earlier reports yet.' }))];
    return [record, el(
      'section',
      { class: 'card list' },
      el('h2', { class: 'list-title', text: 'Reports' }),
      dates.map((d) =>
        el(
          'button',
          { class: 'row', type: 'button', onclick: () => openDate(d) },
          el('span', { text: idLabel(d) }),
          d === idOf(state.latest) ? el('span', { class: 'tag', text: 'Latest' }) : icon('chevron', 'ico chev'),
        ),
      ),
    )];
  }

  async function openDate(d) {
    if (d === idOf(state.latest)) {
      state.viewing = null;
      state.tab = 'slips';
      render(true);
      return;
    }
    setBusy(true);
    try {
      let env = await kvGet(`env:${d}`);
      if (!env) {
        env = await fetchEnv(archiveUrl(d));
        if (env) await kvSet(`env:${d}`, env);
      }
      if (!env) throw codeErr('no-data');
      state.viewing = await decrypt(env, state.dev);
      state.tab = 'slips';
      render(true);
    } catch (e) {
      toast(e && e.code === 'no-data' ? 'That report isn’t available.' : errText(e));
    } finally {
      setBusy(false);
    }
  }

  function keyBox(txt) {
    return el('textarea', { class: 'keybox', readonly: true, rows: 6, spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'This phone’s public key', text: txt });
  }
  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch {
      const ta = el('textarea', { text: t });
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }
  function keyActions(txt) {
    const row = el('div', { class: 'btn-row' }, el('button', { class: 'btn primary', type: 'button', onclick: async () => toast((await copyText(txt)) ? 'Key copied' : 'Couldn’t copy. Select the text and copy it') }, 'Copy key'));
    if (navigator.share) {
      row.append(el('button', { class: 'btn', type: 'button', onclick: () => navigator.share({ title: 'Matchday key', text: txt }).catch(() => {}) }, 'Share'));
    }
    return row;
  }

  function viewKey() {
    const d = state.dev;
    const txt = keyText(d);
    return [
      el(
        'section',
        { class: 'card' },
        el('h2', { text: 'This phone’s key' }),
        el('p', { class: 'muted small', text: 'Claude locks each report with the public key below. Only this phone holds the matching private key, so only this phone can open the slips.' }),
        keyBox(txt),
        keyActions(txt),
        el('div', { class: 'kv' }, el('span', { text: 'Fingerprint' }), el('code', { text: fmtKid(d.kid) })),
        el('div', { class: 'kv' }, el('span', { text: 'Created' }), el('span', { text: fmtWhen(d.created) })),
      ),
      el(
        'section',
        { class: 'card' },
        el('h3', { text: 'How your privacy is protected' }),
        el(
          'ul',
          { class: 'plain' },
          el('li', { text: 'The private key was made on this phone and never leaves it. Not even Claude has it.' }),
          el('li', { text: 'Reports are encrypted before they are uploaded. Anyone who opens the site or the GitHub repository sees only scrambled data.' }),
          el('li', { text: 'The app has no tracking. Apart from this site, it only contacts GitHub, and only when you send screenshots to your private inbox.' }),
          el('li', { text: 'If you delete the app or clear its data, the key is gone. Set up again and send the new key to Claude.' }),
        ),
      ),
      el(
        'section',
        { class: 'card' },
        el('h3', { text: 'Reset' }),
        el('p', { class: 'muted small', text: 'Makes a new key for this phone. You’ll need to send the new key to Claude, earlier reports can’t be opened any more, and you’ll need to connect your inbox again.' }),
        el('button', { class: 'btn danger block', type: 'button', onclick: resetKey }, 'Reset this phone’s key'),
      ),
    ];
  }

  async function resetKey() {
    if (!window.confirm('Reset this phone’s key? You’ll need to send the new key to Claude, and earlier reports can’t be opened any more.')) return;
    try { (await db()).close(); } catch { /* ignore */ }
    dbp = null;
    await new Promise((res) => {
      const r = indexedDB.deleteDatabase(DB_NAME);
      r.onsuccess = r.onerror = r.onblocked = () => res();
    });
    for (const x of state.compose.files) URL.revokeObjectURL(x.url);
    Object.assign(state, { dev: null, latest: null, viewing: null, tab: 'slips', error: null, offline: false, inbox: null, requests: [], compose: { files: [], note: '' } });
    stopPolling();
    renderSetup();
  }

  // ---------------------------------------------------------------- Send: screenshots to the private inbox
  // Screenshots go straight from this phone to the user's PRIVATE GitHub repository
  // (requests/<id>/1.jpg, 2.jpg, ..., request.json), then an issue is opened there. That issue
  // starts the agent's task, which writes requests/<id>/status.json when it starts and finishes.
  function b64Std(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64StdDec(str) {
    const bin = atob(String(str).replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const defaultRepo = () => {
    const m = window.location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
    return m ? `${m[1]}/matchday-inbox` : '';
  };

  // The token is encrypted at rest with an AES key that can't be read out of this browser.
  async function wrapKey() {
    let k = await kvGet('inbox-wrap');
    if (!k) {
      k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await kvSet('inbox-wrap', k);
    }
    return k;
  }
  async function saveInbox(repo, token) {
    let rec;
    try {
      const key = await wrapKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(repo) }, key, enc.encode(token));
      rec = { repo, iv: b64uEnc(iv), ct: b64uEnc(ct) };
    } catch {
      rec = { repo, token }; // this browser can't keep keys in storage
    }
    await kvSet('inbox', { ...rec, saved: new Date().toISOString() });
  }
  async function loadInbox() {
    const rec = await kvGet('inbox');
    if (!rec || !rec.repo) return null;
    if (rec.token) return { repo: rec.repo, token: rec.token };
    const key = await kvGet('inbox-wrap');
    if (!key) return null;
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64uDec(rec.iv), additionalData: enc.encode(rec.repo) }, key, b64uDec(rec.ct));
    return { repo: rec.repo, token: dec.decode(pt) };
  }

  async function gh(inbox, method, path, body) {
    const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${inbox.token}` };
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${GH_API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const e = codeErr(`gh-${res.status}`);
      e.status = res.status;
      throw e;
    }
    return data;
  }
  function ghErrText(e) {
    const code = (e && e.code) || '';
    if (code === 'bad-repo') return 'Write the repository as owner/name, for example nasclaude/matchday-inbox.';
    if (code === 'bad-token') return 'That doesn’t look like a GitHub token. A fine-grained token starts with github_pat_.';
    if (code === 'public-repo') return 'That repository is public, so your screenshots would be visible to anyone. Make it private on GitHub first.';
    if (code === 'bad-image') return 'One of the screenshots couldn’t be read. Remove it and try again.';
    if (code === 'gh-401') return 'GitHub didn’t accept the token. It may have expired: make a new one and connect again.';
    if (code === 'gh-403') return 'The token isn’t allowed to do that. Check that it has Contents and Issues set to read and write.';
    if (code === 'gh-404') return 'GitHub couldn’t find that repository with this token. Check the name, and that the token includes it.';
    if (code.startsWith('gh-')) return 'GitHub had a problem. Try again in a minute.';
    return 'Couldn’t reach GitHub. Check your connection and try again.';
  }

  async function connectInbox(repoIn, tokenIn) {
    const repo = String(repoIn || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) throw codeErr('bad-repo');
    const token = String(tokenIn || '').trim();
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,255}$/.test(token)) throw codeErr('bad-token');
    const info = await gh({ repo, token }, 'GET', `/repos/${repo}`);
    if (!info || info.private !== true) throw codeErr('public-repo');
    await saveInbox(repo, token);
    return { repo, token };
  }

  // Re-encode as JPEG: keeps the text sharp, drops any photo metadata, keeps uploads small.
  async function toJpeg(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(codeErr('bad-image'));
        im.src = url;
      });
      const w0 = img.naturalWidth, h0 = img.naturalHeight;
      if (!w0 || !h0) throw codeErr('bad-image');
      const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.9));
      if (!blob) throw codeErr('bad-image');
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  function newRequestId() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const rnd = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => (b % 36).toString(36)).join('');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${rnd}`;
  }

  async function sendRequest(inbox, files, note, progress) {
    const info = await gh(inbox, 'GET', `/repos/${inbox.repo}`);
    if (!info || info.private !== true) throw codeErr('public-repo');
    const id = newRequestId();
    const base = `/repos/${inbox.repo}/contents/requests/${id}`;
    const put = async (name, bytes, message) => {
      const body = { message, content: b64Std(bytes) };
      for (let attempt = 0; ; attempt++) {
        try {
          return await gh(inbox, 'PUT', `${base}/${name}`, body);
        } catch (e) {
          // 409: the branch moved under us (e.g. the agent pushed a status); try again.
          if (attempt >= 2 || !(e.status === 409 || e.status >= 500)) throw e;
          await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        }
      }
    };
    const names = [];
    for (let i = 0; i < files.length; i++) {
      progress(`Preparing ${i + 1} of ${files.length}…`);
      const bytes = await toJpeg(files[i]);
      progress(`Uploading ${i + 1} of ${files.length}…`);
      await put(`${i + 1}.jpg`, bytes, `Add screenshot ${i + 1} of request ${id}`);
      names.push(`${i + 1}.jpg`);
    }
    progress('Starting…');
    const created = new Date().toISOString();
    let timeZone = '';
    try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* ignore */ }
    const req = { id, created, timeZone, note, screenshots: names, app: 'matchday', appVersion: APP_VERSION };
    await put('request.json', enc.encode(`${JSON.stringify(req, null, 2)}\n`), `Add request ${id}`);
    let issue;
    try {
      issue = await gh(inbox, 'POST', `/repos/${inbox.repo}/issues`, {
        title: `Check my matches (${id})`,
        body: `Request from the Matchday app: \`requests/${id}/\`, ${names.length} screenshot${names.length === 1 ? '' : 's'}.`,
      });
    } catch (e) {
      // Without the issue nothing starts the task: mark the request so a later run skips it.
      const cancelled = { status: 'cancelled', updatedAt: new Date().toISOString(), message: 'Not sent: the issue couldn’t be opened.' };
      await put('status.json', enc.encode(`${JSON.stringify(cancelled)}\n`), `Cancel request ${id}`).catch(() => {});
      throw e;
    }
    return { id, created, count: names.length, issue: issue && issue.number };
  }

  const saveRequests = () => kvSet('requests', state.requests.slice(0, 15)).catch(() => {});
  const hasPending = () => state.requests.some((r) => !FINAL.has(r.status));
  let statusBusy = false;
  async function updateStatuses() {
    if (!state.inbox || statusBusy || !hasPending()) return;
    statusBusy = true;
    let changed = false;
    let ready = false;
    try {
      for (const r of state.requests.filter((x) => !FINAL.has(x.status)).slice(0, 5)) {
        let s;
        try {
          const res = await gh(state.inbox, 'GET', `/repos/${state.inbox.repo}/contents/requests/${r.id}/status.json`);
          s = JSON.parse(dec.decode(b64StdDec((res && res.content) || '')));
        } catch (e) {
          if (e && e.status === 404) continue; // not started yet
          throw e;
        }
        if (!s || typeof s !== 'object') continue;
        const status = ['working', 'done', 'failed', 'cancelled'].includes(s.status) ? s.status : r.status;
        const message = typeof s.message === 'string' ? s.message.slice(0, 400) : '';
        if (status !== r.status || message !== (r.message || '')) changed = true;
        Object.assign(r, {
          status,
          message,
          reportId: typeof s.reportId === 'string' && ID_RE.test(s.reportId) ? s.reportId : r.reportId,
          startedAt: typeof s.startedAt === 'string' ? s.startedAt : r.startedAt,
        });
        if (status === 'done') ready = true;
        if (FINAL.has(status) && r.issue && !r.closed) {
          try {
            await gh(state.inbox, 'PATCH', `/repos/${state.inbox.repo}/issues/${r.issue}`, { state: 'closed' });
            r.closed = true;
            changed = true;
          } catch { /* best effort */ }
        }
      }
    } catch { /* offline or GitHub trouble: try again later */ }
    statusBusy = false;
    if (changed) {
      await saveRequests();
      rerenderRequests();
    }
    if (ready) {
      toast('Your slips are ready');
      refresh({ quiet: true });
    }
    if (!hasPending()) stopPolling();
  }
  let pollTimer = 0;
  function startPolling() {
    if (pollTimer || !hasPending()) return;
    pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') updateStatuses();
    }, 60000);
  }
  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = 0;
  }

  function addShots(list) {
    const c = state.compose;
    let skipped = 0;
    for (const f of Array.from(list || [])) {
      if (c.files.length >= MAX_SHOTS) { skipped++; continue; }
      if (f.type && !/^image\//.test(f.type)) continue;
      c.files.push({ file: f, url: URL.createObjectURL(f) });
    }
    if (skipped) toast(`Up to ${MAX_SHOTS} screenshots at a time`);
    render(false);
  }
  function removeShot(i) {
    const [x] = state.compose.files.splice(i, 1);
    if (x) URL.revokeObjectURL(x.url);
    render(false);
  }
  async function doSend() {
    const c = state.compose;
    if (!state.inbox || !c.files.length || state.sending) return;
    state.sending = true;
    state.sendMsg = 'Preparing…';
    render(false);
    const setMsg = (m) => {
      state.sendMsg = m;
      const b = $view.querySelector('.send-btn');
      if (b) b.textContent = m;
    };
    try {
      const r = await sendRequest(state.inbox, c.files.map((x) => x.file), c.note.trim().slice(0, NOTE_MAX), setMsg);
      state.requests = [{ ...r, status: 'queued' }, ...state.requests].slice(0, 15);
      await saveRequests();
      for (const x of c.files) URL.revokeObjectURL(x.url);
      state.compose = { files: [], note: '' };
      toast('Sent. Claude is on it');
      startPolling();
    } catch (e) {
      toast(ghErrText(e));
    } finally {
      state.sending = false;
      state.sendMsg = '';
      render(false);
    }
  }
  async function disconnectInbox() {
    if (!window.confirm('Disconnect the inbox? The token is removed from this phone. You can also revoke it on GitHub.')) return;
    try {
      await tx('readwrite', (s) => { s.delete('inbox'); s.delete('inbox-wrap'); });
    } catch { /* ignore */ }
    state.inbox = null;
    stopPolling();
    render(true);
  }
  async function openReport(id) {
    await refresh({ quiet: true });
    openDate(id);
  }

  const STATUS = {
    queued: { label: 'Waiting', cls: 'wait' },
    working: { label: 'Working', cls: 'busy' },
    done: { label: 'Done', cls: '' },
    failed: { label: 'Couldn’t finish', cls: 'fail' },
    cancelled: { label: 'Not sent', cls: 'fail' },
  };
  const fmtShort = (iso) => {
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? '' : t.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  function requestHint(r) {
    if (r.message) return r.message;
    if (r.status === 'working') return `Started ${fmtTime(r.startedAt) || 'a moment ago'}. It usually takes 15–25 minutes.`;
    if (r.status === 'queued') {
      return Date.now() - new Date(r.created).getTime() > 30 * 60000
        ? 'Not started yet. Check that the task’s GitHub trigger is set up.'
        : 'Starting in a minute or two.';
    }
    return '';
  }
  function requestsCard() {
    if (!state.requests.length) return el('div', { class: 'req-list' });
    return el(
      'section',
      { class: 'card list req-list' },
      el('h2', { class: 'list-title', text: 'Your requests' }),
      state.requests.slice(0, 8).map((r) => {
        const st = STATUS[r.status] || STATUS.queued;
        return el(
          'div',
          { class: 'req' },
          el(
            'div',
            { class: 'req-main' },
            el('div', { class: 'req-title', text: `${fmtShort(r.created)} · ${r.count} screenshot${r.count === 1 ? '' : 's'}` }),
            el('div', { class: 'req-msg', text: requestHint(r) }),
            r.status === 'done' && r.reportId ? el('button', { class: 'link', type: 'button', onclick: () => openReport(r.reportId) }, 'Open the slips') : null,
          ),
          el('span', { class: `tag ${st.cls}`.trim(), text: st.label }),
        );
      }),
    );
  }
  function rerenderRequests() {
    const old = $view.querySelector('.req-list');
    if (old && state.tab === 'send') old.replaceWith(requestsCard());
  }

  function viewSend() {
    if (!state.inbox) return viewConnect();
    const c = state.compose;
    const n = c.files.length;
    const input = el('input', {
      type: 'file', accept: 'image/*', multiple: true, id: 'shots', class: 'visually-hidden', disabled: state.sending,
      onchange: (ev) => { const files = Array.from(ev.target.files || []); ev.target.value = ''; addShots(files); },
    });
    const note = el('textarea', { rows: 3, maxlength: NOTE_MAX, placeholder: 'Optional. For example: only these 4 matches, I like Asian handicap', disabled: state.sending });
    note.value = c.note;
    note.addEventListener('input', () => { c.note = note.value; });
    return [
      el(
        'section',
        { class: 'card send' },
        el('h2', { text: 'Check your matches' }),
        el('p', { class: 'muted small', text: 'Send screenshots of the matches and odds from your bookmaker. Claude runs the same checks as for the daily slips, on your matches only, and sends the slips here, usually in 15–25 minutes.' }),
        n ? el('div', { class: 'thumbs' }, c.files.map((f, i) => el(
          'div',
          { class: 'thumb' },
          el('img', { src: f.url, alt: `Screenshot ${i + 1}` }),
          state.sending ? null : el('button', { class: 'thumb-x', type: 'button', 'aria-label': `Remove screenshot ${i + 1}`, html: ICONS.x, onclick: () => removeShot(i) }),
        ))) : null,
        input,
        n < MAX_SHOTS && !state.sending ? el('label', { class: `btn block${n ? '' : ' primary'}`, for: 'shots' }, n ? 'Add more screenshots' : 'Choose screenshots') : null,
        el('label', { class: 'field' }, el('span', { text: 'Note for Claude' }), note),
        el('button', { class: 'btn primary block send-btn', type: 'button', disabled: !n || state.sending, onclick: doSend }, state.sending ? state.sendMsg || 'Sending…' : n ? `Send ${n} screenshot${n === 1 ? '' : 's'}` : 'Send'),
        el('p', { class: 'muted small tip', text: 'Show every market you’d bet on (result, double chance, goal lines, goal goal / no goal, Asian handicap), both sides if you can. Each slip uses one pick per match, so more matches means more slips.' }),
      ),
      requestsCard(),
      el(
        'section',
        { class: 'card' },
        el('h3', { text: 'Inbox' }),
        el('div', { class: 'kv' }, el('span', { text: 'Private repository' }), el('code', { text: state.inbox.repo })),
        el('p', { class: 'muted small', text: 'Screenshots go straight from this phone to that repository. The token is stored only in this app.' }),
        el('button', { class: 'btn block', type: 'button', onclick: disconnectInbox }, 'Disconnect'),
      ),
    ];
  }

  function viewConnect() {
    const repoIn = el('input', { class: 'input', type: 'text', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: 'owner/matchday-inbox', 'aria-label': 'Repository' });
    repoIn.value = defaultRepo();
    const tokIn = el('input', { class: 'input', type: 'password', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: 'github_pat_…', 'aria-label': 'Token' });
    const err = el('p', { class: 'form-err', role: 'alert', hidden: true });
    const btn = el('button', { class: 'btn primary block', type: 'button' }, 'Connect');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Checking…';
      err.hidden = true;
      try {
        state.inbox = await connectInbox(repoIn.value, tokIn.value);
        toast('Inbox connected');
        render(true);
      } catch (e) {
        err.textContent = ghErrText(e);
        err.hidden = false;
        btn.disabled = false;
        btn.textContent = 'Connect';
      }
    });
    return el(
      'section',
      { class: 'card send' },
      el('h2', { text: 'Send screenshots from here' }),
      el('p', { class: 'muted small', text: 'Connect Matchday to your private GitHub inbox once. Your screenshots then go straight from this phone to that repository, and Claude picks them up from there.' }),
      el(
        'ol',
        { class: 'plain steps' },
        el('li', { text: 'On GitHub, create a private repository called matchday-inbox.' }),
        el('li', {}, 'Create a fine-grained token (', el('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener noreferrer' }, 'open GitHub'), '). Repository access: only matchday-inbox. Permissions: Contents and Issues, read and write.'),
        el('li', { text: 'Paste the token below and tap Connect.' }),
      ),
      el('label', { class: 'field' }, el('span', { text: 'Repository' }), repoIn),
      el('label', { class: 'field' }, el('span', { text: 'Token' }), tokIn),
      err,
      btn,
      el('p', { class: 'muted small tip', text: 'The token stays in this app on this phone and is only ever sent to GitHub. You can revoke it on GitHub at any time.' }),
    );
  }

  // ---------------------------------------------------------------- setup flow
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

  function renderSetup() {
    $tabbar.hidden = true;
    $refresh.hidden = true;
    $sub.textContent = 'Private football slips';
    const standalone = isStandalone();
    const iosBrowser = isIOS() && !standalone;
    const setupBtn = (label, primary) => el('button', { class: `btn block${primary ? ' primary' : ''}`, type: 'button', onclick: doSetup }, label);
    const kids = [
      el(
        'section',
        { class: 'card intro' },
        el('img', { src: 'icons/icon-192.png', alt: '', width: 72, height: 72 }),
        el('h2', { text: 'Your slips, only on your phone' }),
        el('p', { class: 'muted', text: 'Every morning Claude researches the matches and sends your slips here, locked so that only this phone can open them. Anyone else who opens this page sees nothing.' }),
      ),
    ];
    if (!standalone) {
      kids.push(
        el(
          'section',
          { class: 'card' },
          el('h3', {}, el('span', { class: 'step-n', text: '1' }), 'Add Matchday to your home screen'),
          el('p', { text: isIOS() ? 'In Safari, tap the Share button, then “Add to Home Screen”. Then open Matchday from your home screen and continue there.' : 'Open the browser menu (⋮) and tap “Install app” or “Add to Home screen”. Then open Matchday from your home screen.' }),
          isIOS() ? el('p', { class: 'muted small', text: 'On iPhone, the home-screen app keeps its own storage, so create the key there, not in Safari.' }) : null,
        ),
      );
    }
    kids.push(
      el(
        'section',
        { class: 'card' },
        el('h3', {}, standalone ? null : el('span', { class: 'step-n', text: '2' }), 'Set up this phone'),
        el('p', { text: 'This creates a private key that stays on this phone, and a public key that you send to Claude.' }),
        iosBrowser ? setupBtn('Set up here anyway', false) : setupBtn('Set up this phone', true),
      ),
    );
    mount(kids);
  }

  async function doSetup(ev) {
    const btn = ev && ev.currentTarget;
    if (btn) btn.disabled = true;
    try {
      state.dev = await createDevice();
      renderKeyCreated();
    } catch (e) {
      if (btn) btn.disabled = false;
      toast('Couldn’t create a key on this device.');
      console.error(e);
    }
  }

  function renderKeyCreated() {
    $tabbar.hidden = true;
    $refresh.hidden = true;
    $sub.textContent = 'Set up';
    const txt = keyText(state.dev);
    mount([
      el(
        'section',
        { class: 'card' },
        el('div', { class: 'success', html: ICONS.check }),
        el('h2', { text: 'This phone is ready' }),
        el('p', { text: 'Send the key below to Claude in your chat. It’s safe to share: it can only lock reports for this phone, not open them.' }),
        keyBox(txt),
        keyActions(txt),
        el('p', { class: 'muted small', text: `Fingerprint ${fmtKid(state.dev.kid)}` }),
      ),
      el('button', { class: 'btn primary block', type: 'button', onclick: () => { state.tab = 'slips'; render(true); refresh({ quiet: true }); } }, 'Continue'),
    ]);
  }

  // ---------------------------------------------------------------- refresh
  let refreshing = false;
  async function refresh({ quiet = false } = {}) {
    if (refreshing || !state.dev) return;
    refreshing = true;
    setBusy(true);
    const before = state.latest && state.latest.generatedAt;
    try {
      const env = await fetchEnv(LATEST_URL);
      state.lastFetch = Date.now();
      state.offline = false;
      if (!env) {
        state.latest = null;
        state.error = codeErr('no-data');
        if (!quiet) toast('No slips published yet');
      } else {
        try {
          state.latest = await decrypt(env, state.dev);
          state.error = null;
          await kvSet('env:latest', env);
          const changed = before && before !== state.latest.generatedAt;
          if (changed) toast('New slips loaded');
          else if (!quiet) toast('You’re up to date');
        } catch (e) {
          state.error = e;
          if (!quiet) toast(errText(e));
        }
      }
    } catch {
      state.offline = true;
      state.lastFetch = Date.now();
      if (!quiet) toast('You’re offline');
    } finally {
      refreshing = false;
      setBusy(false);
      render(false);
    }
  }

  // ---------------------------------------------------------------- service worker (offline + home screen)
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) {
        reloaded = true;
        window.location.reload();
      }
    });
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  function fatal(msg) {
    $tabbar.hidden = true;
    $refresh.hidden = true;
    mount(el('section', { class: 'card empty' }, el('h2', { text: 'Matchday can’t start' }), el('p', { text: msg })));
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    buildChrome();
    $refresh.addEventListener('click', () => {
      refresh();
      updateStatuses();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !state.dev) return;
      if (Date.now() - state.lastFetch > 120000) refresh({ quiet: true });
      updateStatuses();
    });
    if (!window.isSecureContext || !window.crypto || !window.crypto.subtle || !window.indexedDB) {
      fatal('This page needs a secure (https) connection and an up-to-date browser.');
      return;
    }
    registerSW();
    try {
      state.dev = (await kvGet('device')) || null;
    } catch {
      fatal('This browser blocked storage, so Matchday can’t keep its key. Open it from your home screen, not in a private tab.');
      return;
    }
    if (!state.dev) {
      renderSetup();
      return;
    }
    try {
      const cached = await kvGet('env:latest');
      if (cached) state.latest = await decrypt(cached, state.dev);
    } catch { /* fall through to network */ }
    try {
      state.inbox = await loadInbox();
      state.requests = (await kvGet('requests')) || [];
    } catch { /* Send tab will ask to connect again */ }
    render(false);
    refresh({ quiet: true });
    updateStatuses();
    startPolling();
  }

  boot();
})();
