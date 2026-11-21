'use strict';
/*
 * Matchday: shows the daily slips that the research agent publishes.
 *
 * Privacy model
 *  - On first use the app creates an ECDH P-256 key pair with WebCrypto. The private key is
 *    stored on this device only (IndexedDB, non-extractable where the browser allows it).
 *  - The agent encrypts every report with the device's PUBLIC key (ECDH + HKDF-SHA256 +
 *    AES-256-GCM) and uploads only the encrypted file (data/latest.json).
 *  - This page downloads that file from its own origin and decrypts it locally. It never
 *    talks to any other server (see the Content-Security-Policy in index.html).
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

  const $view = document.getElementById('view');
  const $tabbar = document.getElementById('tabbar');
  const $sub = document.getElementById('subtitle');
  const $refresh = document.getElementById('refresh');
  const $toast = document.getElementById('toast');

  const state = { dev: null, latest: null, viewing: null, tab: 'slips', offline: false, error: null, lastFetch: 0 };

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
    else if (!p) kids.push(viewEmpty());
    else {
      if (state.error && state.error.code !== 'no-data' && !state.viewing) kids.push(banner(errText(state.error), 'warn'));
      if (state.tab === 'report') kids.push(viewReport(p));
      else if (state.tab === 'history') kids.push(viewHistory());
      else kids.push(viewSlips(p));
    }
    mount(kids);
    $sub.textContent = p ? `${fmtDay(p.date)}${state.viewing ? ' · earlier report' : ''}` : '';
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
      out.push(banner(`Earlier report: ${fmtDay(p.date)}`, '', el('button', { class: 'link', type: 'button', onclick: () => { state.viewing = null; render(true); } }, 'Back to latest')));
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
    const dates = src && Array.isArray(src.history) ? src.history.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
    if (!dates.length) return el('section', { class: 'card empty' }, el('p', { text: 'No earlier reports yet.' }));
    return el(
      'section',
      { class: 'card list' },
      el('h2', { class: 'list-title', text: 'Reports' }),
      dates.map((d) =>
        el(
          'button',
          { class: 'row', type: 'button', onclick: () => openDate(d) },
          el('span', { text: fmtDayLong(d) }),
          state.latest && d === state.latest.date ? el('span', { class: 'tag', text: 'Latest' }) : icon('chevron', 'ico chev'),
        ),
      ),
    );
  }

  async function openDate(d) {
    if (state.latest && d === state.latest.date) {
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
          el('li', { text: 'This app doesn’t contact any other website and has no tracking.' }),
          el('li', { text: 'If you delete the app or clear its data, the key is gone. Set up again and send the new key to Claude.' }),
        ),
      ),
      el(
        'section',
        { class: 'card' },
        el('h3', { text: 'Reset' }),
        el('p', { class: 'muted small', text: 'Makes a new key for this phone. You’ll need to send the new key to Claude, and earlier reports can’t be opened any more.' }),
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
    Object.assign(state, { dev: null, latest: null, viewing: null, tab: 'slips', error: null, offline: false });
    renderSetup();
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
    $refresh.addEventListener('click', () => refresh());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.dev && Date.now() - state.lastFetch > 120000) refresh({ quiet: true });
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
    render(false);
    refresh({ quiet: true });
  }

  boot();
})();
