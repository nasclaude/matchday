// Reads bookmaker odds from BetExplorer for every upcoming match on a league page.
// Usage: MAX_MATCHES=10 node odds.js <betexplorer league URL> [more league URLs...] > odds.json
// Output per match and bookmaker: 1X2, DNB, DC, BTTS, O/U 0.5-4.5 and Asian handicap lines
// (from the HOME team's point of view: column 1 = home at that line, column 2 = away at the opposite line).
const { chromium } = require('playwright');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX = +(process.env.MAX_MATCHES || 12);
async function block(p) {
  const t = (await p.innerText('body')).replace(/\s*\n\s*/g, ' | ');
  const i = t.indexOf('Odds Comparison'), j = t.indexOf('Add to My Selections', i);
  return i < 0 ? null : t.slice(i, j < 0 ? i + 900 : j).replace(/^Odds Comparison \| \([^)]*\) \| 1X2 \| O\/U \| AH \| DNB \| DC \| BTTS \| /, '');
}
async function tab(p, name) {
  await p.locator('text="Odds Comparison"').locator(`xpath=following::*[normalize-space(text())="${name}"][1]`).click({ timeout: 8000 });
  await p.waitForTimeout(2000);
}
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ userAgent: UA }); const out = [];
  for (const league of process.argv.slice(2)) {
    await p.goto(league, { waitUntil: 'networkidle', timeout: 60000 });
    const links = (await p.$$eval('a', as => [...new Set(as.map(a => a.href))])).filter(h => h.startsWith(league) && /^[a-z0-9]+(-[a-z0-9]+)+\/[A-Za-z0-9]{8}\/$/.test(h.slice(league.length))).slice(0, MAX);
    for (const m of links) {
      const r = { url: m, markets: {} };
      try {
        await p.goto(m, { waitUntil: 'networkidle', timeout: 60000 });
        const head = (await p.innerText('body')).match(/(\d\d\.\d\d\.\d{4} - \d\d:\d\d)/);
        r.date_time_site = head ? head[1] : null;
        r.markets['1X2'] = await block(p);
        for (const mk of ['DNB', 'DC', 'BTTS']) { try { await tab(p, mk); r.markets[mk] = await block(p); } catch (e) { r.markets[mk] = 'n/a'; } }
        for (const [mk, lines] of [['O/U', ['0.5','1.5','2.5','3.5','4.5']], ['AH', ['+1.5','+1','+0.5','-0.5','-0.75','-1','-1.25','-1.5','-2','-2.5']]]) {
          try { await tab(p, mk); } catch (e) { r.markets[mk] = 'n/a'; continue; }
          for (const l of lines) {
            const loc = p.locator('text="Odds Comparison"').locator(`xpath=following::*[normalize-space(text())="${l}"][1]`);
            if (await loc.count() === 0) continue;
            try { await loc.click({ timeout: 4000 }); await p.waitForTimeout(1200); const bl = await block(p); if (bl && bl.includes(l)) r.markets[`${mk} ${l}`] = bl.replace(/^ALL[^H]*?(HANDICAP|TOTAL)/, '$1'); } catch (e) {}
          }
        }
      } catch (e) { r.error = e.message.split('\n')[0]; }
      out.push(r); console.error('done', m);
    }
  }
  console.log(JSON.stringify(out, null, 1)); await b.close();
})();
