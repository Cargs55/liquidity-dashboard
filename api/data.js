// Global Liquidity Dashboard — data pipeline. Runs server-side on Vercel.
// Every number on the dashboard is fetched live from a primary source at request time (edge-cached 6h).
// Nothing is hard-coded. A series that cannot be fetched is reported as unavailable, shown as such,
// and dropped from the composite with the remaining weights re-normalised.
//
// Verified sources (probe 8 Sep 2026): NY Fed Markets API (SOFR, EFFR, repo ops), US Treasury FiscalData (TGA),
// OFR Financial Stress Index, ECB Data Portal (ILM), BIS (policy rates, effective exchange rates),
// CBOE (VIX), RBA statistical tables (A1, F1, F2). FRED via api.stlouisfed.org when FRED_API_KEY is set.

const DAY = 86400000;
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', 'Accept': 'text/csv,application/json,text/plain,*/*;q=0.8' };
const FRED_KEY = process.env.FRED_API_KEY || '';

// ---------- fetch ----------
async function getText(url, timeoutMs = 18000, attempts = 2) {
  let err = null;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try { const r = await fetch(url, { signal: ctrl.signal, headers: UA, redirect: 'follow' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.text(); }
    catch (e) { err = e; if (String(e.message || e).startsWith('HTTP 4')) break; }
    finally { clearTimeout(to); }
  }
  throw err;
}
// ---------- dates ----------
const pad = n => String(n).padStart(2, '0');
function isoWeekToDate(y, w) { // ISO week -> Friday of that week (ECB weekly statement reference)
  const simple = new Date(Date.UTC(y, 0, 4)); const dow = simple.getUTCDay() || 7;
  const monday = new Date(simple.getTime() - (dow - 1) * DAY + (w - 1) * 7 * DAY);
  return new Date(monday.getTime() + 4 * DAY).toISOString().slice(0, 10);
}
const MON = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
function isoDate(s) {
  s = (s || '').trim(); let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/))) { const mm = MON[m[2].toLowerCase()]; if (mm) return `${m[3]}-${pad(mm)}-${pad(m[1])}`; }
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return null; // ambiguous dd/mm vs mm/dd — handled by caller
  if ((m = s.match(/^(\d{4})-W(\d{2})$/))) return isoWeekToDate(+m[1], +m[2]);
  if ((m = s.match(/^(\d{4})-(\d{2})$/))) return `${m[1]}-${m[2]}-01`;
  if ((m = s.match(/^(\d{4})-Q([1-4])$/))) return `${m[1]}-${pad((m[2] - 1) * 3 + 1)}-01`;
  return null;
}
const usDate = s => { const m = (s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${pad(m[1])}-${pad(m[2])}` : null; };
const auDate = s => { const m = (s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : null; };
const toT = d => Date.parse(d + 'T00:00:00Z');
const shiftIso = (d, days) => new Date(toT(d) + days * DAY).toISOString().slice(0, 10);
const daysOld = d => Math.round((Date.now() - toT(d)) / DAY);
const sortS = s => s.sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
function dedupe(s) { const out = []; for (const p of sortS(s)) { if (out.length && out[out.length - 1].d === p.d) out[out.length - 1] = p; else out.push(p); } return out; }

// ---------- parsers ----------
function splitCsv(l) { const o = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') { q = !q; continue; } if (ch === ',' && !q) { o.push(cur); cur = ''; } else cur += ch; } o.push(cur); return o; }
function parseSdmxCsv(txt) { // -> map key -> series ; key = REF_AREA (BIS) or BS_ITEM/KEY (ECB)
  const lines = txt.split(/\r?\n/).filter(l => l.trim()); if (!lines.length) return {};
  const hdr = splitCsv(lines[0]).map(h => h.trim().toUpperCase());
  const ti = hdr.indexOf('TIME_PERIOD'), vi = hdr.indexOf('OBS_VALUE');
  const ki = ['BS_ITEM', 'REF_AREA', 'KEY'].map(k => hdr.indexOf(k)).find(i => i >= 0);
  const out = {};
  for (const l of lines.slice(1)) { const c = splitCsv(l); const d = isoDate(c[ti]); const v = Number(c[vi]); if (!d || !Number.isFinite(v)) continue; const k = ki >= 0 ? c[ki] : '_'; (out[k] = out[k] || []).push({ d, v }); }
  for (const k of Object.keys(out)) out[k] = dedupe(out[k]);
  return out;
}
function parseRba(txt) {
  const lines = txt.split(/\r?\n/); let titles = null, ids = null; const rows = [];
  for (const l of lines) { const c = splitCsv(l); const k = (c[0] || '').trim().toLowerCase();
    if (k === 'title') titles = c; else if (k === 'series id') ids = c;
    else { const d = isoDate(c[0]) || auDate(c[0]); if (d) rows.push({ d, c }); } }
  return { titles, ids, rows };
}
function rbaSeries(tbl, re) {
  if (!tbl || !tbl.rows.length || !tbl.titles) return null;
  let idx = -1; for (let i = 1; i < tbl.titles.length; i++) if (re.test(tbl.titles[i] || '')) { idx = i; break; }
  if (idx < 0) return null;
  const s = []; for (const r of tbl.rows) { const raw = (r.c[idx] || '').trim(); if (raw === '') continue; const n = Number(raw); if (Number.isFinite(n)) s.push({ d: r.d, v: n }); }
  return { s: dedupe(s), name: tbl.titles[idx].trim(), id: tbl.ids ? (tbl.ids[idx] || '').trim() : '' };
}
function parseFredJson(txt) { const j = JSON.parse(txt); return dedupe((j.observations || []).map(o => ({ d: o.date, v: Number(o.value) })).filter(p => Number.isFinite(p.v))); }
function parseOfr(txt) { const lines = txt.split(/\r?\n/).filter(Boolean); const hdr = splitCsv(lines[0]).map(h => h.trim()); const out = {}; hdr.slice(1).forEach(h => out[h] = []);
  for (const l of lines.slice(1)) { const c = splitCsv(l); const d = isoDate(c[0]); if (!d) continue; hdr.slice(1).forEach((h, i) => { const v = Number(c[i + 1]); if (Number.isFinite(v)) out[h].push({ d, v }); }); }
  for (const k of Object.keys(out)) out[k] = dedupe(out[k]); return out; }
function parseCboe(txt) { const out = []; for (const l of txt.split(/\r?\n/).slice(1)) { const c = l.split(','); const d = usDate(c[0]); const v = Number(c[4]); if (d && Number.isFinite(v)) out.push({ d, v }); } return dedupe(out); }
function parseNyfedRates(txt, type) { const j = JSON.parse(txt); return dedupe((j.refRates || []).filter(r => !type || r.type === type).map(r => ({ d: r.effectiveDate, v: Number(r.percentRate), p99: Number(r.percentPercentile99), p1: Number(r.percentPercentile1), vol: Number(r.volumeInBillions) })).filter(p => Number.isFinite(p.v))); }
function parseNyfedRepo(txt) { const j = JSON.parse(txt); const ops = (j.repo && j.repo.operations) || []; const by = {};
  for (const o of ops) { if (!/repo/i.test(o.operationType || '') || /reverse/i.test(o.operationType || '')) continue; const d = o.operationDate; let amt = Number(o.totalAmtAccepted); if (!Number.isFinite(amt) && Array.isArray(o.details)) amt = o.details.reduce((a, x) => a + (Number(x.amtAccepted) || 0), 0); if (!Number.isFinite(amt)) continue; by[d] = (by[d] || 0) + amt / 1e9; }
  return dedupe(Object.entries(by).map(([d, v]) => ({ d, v }))); }
function parseTga(txt) { const j = JSON.parse(txt); return dedupe((j.data || []).filter(r => /Closing Balance/i.test(r.account_type || '')).map(r => { let v = Number(r.close_today_bal); if (!Number.isFinite(v)) v = Number(r.open_today_bal); return { d: r.record_date, v: v / 1000 }; }).filter(p => Number.isFinite(p.v))); }

// ---------- series math ----------
const last = s => s[s.length - 1];
function atOrBefore(s, d) { let lo = 0, hi = s.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m].d <= d) { ans = m; lo = m + 1; } else hi = m - 1; } return ans >= 0 ? s[ans] : null; }
function idxAtOrBefore(s, d) { let lo = 0, hi = s.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m].d <= d) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; }
function changeOver(s, days, pct = false, endIdx = null) { const end = endIdx == null ? last(s) : s[endIdx]; if (!end) return null; const st = atOrBefore(s, shiftIso(end.d, -days)); if (!st) return null; return pct ? (st.v === 0 ? null : (end.v / st.v - 1) * 100) : end.v - st.v; }
function rollChange(s, days, pct) { const out = []; for (let i = 0; i < s.length; i++) { const c = changeOver(s, days, pct, i); if (c != null) out.push({ d: s[i].d, v: c }); } return out; }
function zAt(s, windowDays, idx = null, minObs = 20) { if (!s || !s.length) return null; const end = idx == null ? s.length - 1 : idx; if (end < 0) return null; const startD = shiftIso(s[end].d, -windowDays); const win = []; for (let i = end; i >= 0 && s[i].d >= startD; i--) win.push(s[i].v); if (win.length < minObs) return null; const mean = win.reduce((a, b) => a + b, 0) / win.length; const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / (win.length - 1)); return sd ? (s[end].v - mean) / sd : 0; }
function alignDiff(a, b, k = 1) { const out = []; for (const p of a) { const q = atOrBefore(b, p.d); if (q) out.push({ d: p.d, v: (p.v - q.v) * k }); } return out; }
function alignSum(a, b) { const out = []; for (const p of a) { const q = atOrBefore(b, p.d); if (q) out.push({ d: p.d, v: p.v + q.v }); } return out; }
function alignRatio(a, b, k = 1) { const out = []; for (const p of a) { const q = atOrBefore(b, p.d); if (q && q.v) out.push({ d: p.d, v: p.v / q.v * k }); } return out; }
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r1 = x => x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10;
const r2 = x => x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;
const tail = (s, n) => { if (!s) return []; const t = s.slice(-n); const k = Math.ceil(t.length / 120); const o = k > 1 ? t.filter((_, i) => (t.length - 1 - i) % k === 0) : t; return o.map(p => ({ d: p.d, v: Math.round(p.v * 1000) / 1000 })); };

// ---------- registry ----------
const BIS_AREAS = ['AU', 'US', 'XM', 'GB', 'JP', 'CN', 'IN', 'KR', 'TW', 'NZ', 'CA', 'BR', 'MX', 'ZA', 'RU'];
const FRED = id => `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${FRED_KEY}&file_type=json&observation_start=2012-01-01`;
const SOURCES = {
  nyfed_sofr: { url: 'https://markets.newyorkfed.org/api/rates/secured/sofr/search.json?startDate=2019-01-01', parse: t => parseNyfedRates(t, 'SOFR'), name: 'NY Fed — SOFR' },
  nyfed_effr: { url: 'https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json?startDate=2019-01-01', parse: t => parseNyfedRates(t, 'EFFR'), name: 'NY Fed — EFFR' },
  nyfed_repo: { urls: ['https://markets.newyorkfed.org/api/rp/repo/all/results/search.json?startDate=2024-01-01&endDate=' + new Date().toISOString().slice(0, 10), 'https://markets.newyorkfed.org/api/rp/all/all/results/search.json?startDate=01/01/2024&endDate=' + (d => `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()}`)(new Date()), 'https://markets.newyorkfed.org/api/rp/repo/all/results/last/600.json', 'https://markets.newyorkfed.org/api/rp/all/all/results/lastTwoWeeks.json'], parse: parseNyfedRepo, name: 'NY Fed — repo operations (SRF)' },
  tga: { url: 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts/operating_cash_balance?filter=record_date:gte:2022-06-01&page[size]=5000&sort=-record_date', parse: parseTga, name: 'US Treasury — Daily Treasury Statement (TGA)' },
  ofr: { url: 'https://www.financialresearch.gov/financial-stress-index/data/fsi.csv', parse: parseOfr, name: 'OFR Financial Stress Index' },
  ecb_ilm: { urls: ['https://data-api.ecb.europa.eu/service/data/ILM/W.U2.C.L020100+L020200+L050100.U2.EUR?format=csvdata&startPeriod=2020-01-01&detail=dataonly', 'https://data-api.ecb.europa.eu/service/data/ILM/W.U2.C..U2.EUR?format=csvdata&startPeriod=2020-01-01&detail=dataonly'], parse: parseSdmxCsv, name: 'ECB — Eurosystem liquidity (ILM)', timeout: 22000 },
  bis_pol: { url: `https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBPOL/1.0/D.${BIS_AREAS.join('+')}?format=csv&detail=dataonly&startPeriod=2019-01-01`, parse: parseSdmxCsv, name: 'BIS — central bank policy rates', timeout: 25000 },
  bis_eer: { url: `https://stats.bis.org/api/v2/data/dataflow/BIS/WS_EER/1.0/D.N.B.${BIS_AREAS.join('+')}?format=csv&detail=dataonly&startPeriod=2022-01-01`, parse: parseSdmxCsv, name: 'BIS — nominal effective exchange rates (broad)', timeout: 25000 },
  cboe_vix: { url: 'https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv', parse: parseCboe, name: 'CBOE — VIX history' },
  rba_a1: { url: 'https://www.rba.gov.au/statistics/tables/csv/a1-data.csv', parse: parseRba, name: 'RBA — A1 balance sheet' },
  rba_f1: { url: 'https://www.rba.gov.au/statistics/tables/csv/f1-data.csv', parse: parseRba, name: 'RBA — F1 money market rates' },
  rba_f2: { url: 'https://www.rba.gov.au/statistics/tables/csv/f2-data.csv', parse: parseRba, name: 'RBA — F2 government bond yields' },
};
const FRED_SERIES = { WRESBAL: 'Reserve balances', GDP: 'US nominal GDP', IORB: 'Interest on reserve balances', HY: 'BAMLH0A0HYM2', CCC: 'BAMLH0A3HYC', BB: 'BAMLH0A1HYBB', IG: 'BAMLC0A0CM', JPNASSETS: 'BoJ total assets', M2SL: 'US M2', MYAGM2CNM189N: 'China M2', MYAGM2JPM189N: 'Japan M2', MYAGM2GBM189N: 'UK M2', MYAGM3EZM196N: 'Euro area M3', WALCL: 'Fed total assets', RRPONTSYD: 'ON RRP', DTWEXBGS: 'Broad dollar', DGS2: 'US 2y', DEXUSEU: 'EUR/USD', DEXJPUS: 'USD/JPY', DEXCHUS: 'USD/CNY', DEXUSUK: 'GBP/USD' };
const FRED_IDS = { WRESBAL: 'WRESBAL', GDP: 'GDP', IORB: 'IORB', HY: 'BAMLH0A0HYM2', CCC: 'BAMLH0A3HYC', BB: 'BAMLH0A1HYBB', IG: 'BAMLC0A0CM', JPNASSETS: 'JPNASSETS', M2SL: 'M2SL', M2CN: 'MYAGM2CNM189N', M2JP: 'MYAGM2JPM189N', M2GB: 'MYAGM2GBM189N', M3EZ: 'MYAGM3EZM196N', WALCL: 'WALCL', RRPONTSYD: 'RRPONTSYD', DGS2: 'DGS2', DEXUSEU: 'DEXUSEU', DEXJPUS: 'DEXJPUS', DEXCHUS: 'DEXCHUS', DEXUSUK: 'DEXUSUK' };

async function loadAll() {
  const D = {}, H = {};
  const tasks = Object.entries(SOURCES).map(async ([k, src]) => { const t0 = Date.now(); try { let txt = null, lastErr = null; for (const u of (src.urls || [src.url])) { try { txt = await getText(u, src.timeout || 18000); const probe = src.parse(txt); const n0 = Array.isArray(probe) ? probe.length : Object.values(probe).reduce((a, x) => a + (Array.isArray(x) ? x.length : (x.rows ? x.rows.length : 0)), 0); if (n0) { src._used = u; break; } txt = null; lastErr = new Error('parsed 0 observations'); } catch (e) { lastErr = e; txt = null; } } if (txt == null) throw lastErr || new Error('no url succeeded'); const v = src.parse(txt); const n = Array.isArray(v) ? v.length : Object.values(v).reduce((a, x) => a + (Array.isArray(x) ? x.length : (x.rows ? x.rows.length : 0)), 0); if (!n) throw new Error('parsed 0 observations'); D[k] = v; H[k] = { status: 'ok', name: src.name, obs: n, ms: Date.now() - t0, url: src._used || src.url }; } catch (e) { H[k] = { status: 'failed', name: src.name, error: String(e.message || e), ms: Date.now() - t0 }; } });
  if (FRED_KEY) tasks.push(...Object.entries(FRED_IDS).map(async ([k, id]) => { const t0 = Date.now(); try { const s = parseFredJson(await getText(FRED(id), 20000)); if (!s.length) throw new Error('0 obs'); D['fred_' + k] = s; H['fred_' + k] = { status: 'ok', name: `FRED — ${id}`, obs: s.length, lastDate: last(s).d, staleDays: daysOld(last(s).d), ms: Date.now() - t0 }; } catch (e) { H['fred_' + k] = { status: 'failed', name: `FRED — ${id}`, error: String(e.message || e), ms: Date.now() - t0 }; } }));
  else H.fred = { status: 'not_configured', name: 'FRED (api.stlouisfed.org)', error: 'FRED_API_KEY environment variable not set — reserves, credit spreads, Fed/BoJ balance sheets and M2 are unavailable until it is.' };
  await Promise.all(tasks);
  return { D, H };
}

// ---------- indicators ----------
const band = v => v == null ? 'No reading' : v > 1 ? 'Abundant' : v > 0.5 ? 'Easing' : v >= -0.5 ? 'Neutral' : v >= -1 ? 'Tightening' : 'Stressed';
function build(D, H) {
  const F = k => D['fred_' + k];
  const ind = []; const add = o => { ind.push(o); return o; };
  const unavailable = (id, block, weight, dir, name, unit, why) => add({ id, block, weight, dir, name, unit, status: 'unavailable', note: why });
  const zInput = (o, series, win, extra = {}) => { const z = zAt(series, win); return add(Object.assign(o, { value: r2(last(series).v), asOf: last(series).d, chg4w: r2(changeOver(series, 28)), z: r2(z), status: o.status || 'ok', series: tail(series, o.keep || 260) }, extra)); };
  const full = {}; // full transformed series for history recomputation

  // 1. SOFR − IORB (bp). IORB from FRED if available, else derived from BIS US policy rate (target-range upper bound − 10bp).
  const sofr = D.nyfed_sofr; const bisUS = D.bis_pol && D.bis_pol.US;
  let iorb = F('IORB'), iorbNote = null;
  if (!iorb && bisUS) { const mid = Math.round(last(bisUS).v * 1000) % 250 === 125; iorb = bisUS.map(p => ({ d: p.d, v: mid ? p.v + 0.025 : p.v - 0.10 })); iorbNote = `IORB derived from the BIS-reported fed funds target (${mid ? 'range midpoint + 2.5bp' : 'range upper bound − 10bp'}; the Fed has set IORB 10bp below the top of its 25bp range since 2021). Set FRED_API_KEY to use the published IORB series.`; }
  if (sofr && iorb) { const sp = alignDiff(sofr, iorb, 100); full.sofr_iorb = { s: sp, w: 730 }; zInput({ id: 'sofr_iorb', block: 'plumbing', weight: 15, dir: -1, name: 'SOFR minus IORB (overnight funding vs the Fed floor)', unit: 'bp', status: iorbNote ? 'substituted' : 'ok', note: iorbNote }, sp, 730, { sofr: r2(last(sofr).v), sofr99: r2(last(sofr).p99), iorb: r2(atOrBefore(iorb, last(sofr).d).v), policyRate: bisUS ? r2(last(bisUS).v) : null }); }
  else unavailable('sofr_iorb', 'plumbing', 15, -1, 'SOFR minus IORB', 'bp', 'NY Fed SOFR or a policy-rate source did not load.');

  // 2. Reserves / GDP — level-scored vs the Fed's own thresholds (10% sensitive, 12% comfortable)
  if (F('WRESBAL') && F('GDP')) { const ratio = alignRatio(F('WRESBAL').map(p => ({ d: p.d, v: p.v / 1000 })), F('GDP'), 100); const v = last(ratio).v; full.res_gdp = { level: ratio }; add({ id: 'res_gdp', block: 'plumbing', weight: 10, dir: 1, name: 'Bank reserves as a share of GDP', unit: '%', value: r2(v), asOf: last(ratio).d, chg4w: r2(changeOver(ratio, 28)), z: r2(clamp(v - 11, -2.5, 2.5)), scoreMethod: 'Level score: 10% = −1, 11% = 0, 12% = +1 (Fed research: repo rates become issuance-sensitive below ~10% of GDP, insensitive above 12%).', status: 'ok', series: tail(ratio, 160), levelBn: r1(last(F('WRESBAL')).v) }); }
  else unavailable('res_gdp', 'plumbing', 10, 1, 'Bank reserves as a share of GDP', '%', 'Needs FRED (WRESBAL, GDP).');

  // 3. TGA 4-week change ($bn) — Treasury FiscalData, daily
  const tga = D.tga || (F('WTREGEN') ? F('WTREGEN') : null);
  if (tga) { const ch = rollChange(tga, 28, false); full.tga = { s: ch, w: 1095 }; zInput({ id: 'tga', block: 'plumbing', weight: 5, dir: -1, name: 'US Treasury cash balance (TGA), 4-week change', unit: '$bn', keep: 260 }, ch, 1095, { level: r1(last(tga).v), levelSeries: tail(tga, 260) }); }
  else unavailable('tga', 'plumbing', 5, -1, 'Treasury cash balance, 4-week change', '$bn', 'Treasury FiscalData did not load.');

  // 4. Standing repo facility — NY Fed repo results; level-scored on the 10-business-day peak
  const srf = D.nyfed_repo;
  if (srf && srf.length) { // fill calendar: days with no operation = 0 take-up
    const filled = []; const start = srf[0].d; for (let d = start; d <= new Date().toISOString().slice(0, 10); d = shiftIso(d, 1)) { const dow = new Date(toT(d)).getUTCDay(); if (dow === 0 || dow === 6) continue; const q = srf.find(p => p.d === d); filled.push({ d, v: q ? q.v : 0 }); }
    const recent = filled.slice(-10); const mx = Math.max(...recent.map(p => p.v)); full.srf = { level: filled };
    add({ id: 'srf', block: 'plumbing', weight: 5, dir: -1, name: 'Fed standing repo facility use (10-day peak)', unit: '$bn', value: r1(mx), latest: r1(last(filled).v), asOf: last(filled).d, z: r2(-clamp(mx / 25, 0, 2.5)), scoreMethod: 'Level score: $0 = 0 (no stress); −1 at $25bn; −2.5 at ≥$62bn.', status: 'ok', series: tail(filled, 260) }); }
  else unavailable('srf', 'plumbing', 5, -1, 'Fed standing repo facility use', '$bn', 'NY Fed repo results did not load.');

  // 5–6. Credit: HY OAS and CCC−BB from FRED; else OFR credit sub-index as the substitute
  if (F('HY')) { full.hy_oas = { s: F('HY'), w: 730 }; zInput({ id: 'hy_oas', block: 'credit', weight: 15, dir: -1, name: 'US high-yield credit spread (ICE BofA OAS)', unit: '%' }, F('HY'), 730); }
  else if (D.ofr && D.ofr.Credit) { full.hy_oas = { s: D.ofr.Credit, w: 730 }; zInput({ id: 'hy_oas', block: 'credit', weight: 15, dir: -1, name: 'OFR credit-stress sub-index (substitute for HY spread)', unit: 'index', status: 'substituted', note: 'ICE BofA high-yield OAS needs FRED_API_KEY; the OFR Financial Stress Index credit component (built from credit spreads) is used meanwhile.' }, D.ofr.Credit, 730); }
  else unavailable('hy_oas', 'credit', 15, -1, 'US high-yield credit spread', '%', 'Needs FRED or OFR.');
  if (F('CCC') && F('BB')) { const sp = alignDiff(F('CCC'), F('BB')); full.ccc_bb = { s: sp, w: 730 }; zInput({ id: 'ccc_bb', block: 'credit', weight: 10, dir: -1, name: 'CCC minus BB spread (weakest borrowers vs strongest junk)', unit: '%' }, sp, 730); }
  else unavailable('ccc_bb', 'credit', 10, -1, 'CCC minus BB spread', '%', 'Needs FRED (BAMLH0A3HYC, BAMLH0A1HYBB).');

  // 7. Fed reserves, 13-week % change
  if (F('WRESBAL')) { const ch = rollChange(F('WRESBAL'), 91, true); full.fed_res_chg = { s: ch, w: 1095 }; zInput({ id: 'fed_res_chg', block: 'balance', weight: 8, dir: 1, name: 'Fed reserve balances, 13-week change', unit: '%', keep: 160 }, ch, 1095, { level: r1(last(F('WRESBAL')).v), levelUnit: '$bn', levelSeries: tail(F('WRESBAL'), 160) }); }
  else unavailable('fed_res_chg', 'balance', 8, 1, 'Fed reserve balances, 13-week change', '%', 'Needs FRED (WRESBAL).');

  // 8. Eurosystem liquidity — current accounts + deposit facility (ECB ILM), 13-week % change
  const ilm = D.ecb_ilm; let ecbLiq = null;
  if (ilm && ilm.L020100 && ilm.L020200) { ecbLiq = alignSum(ilm.L020200, ilm.L020100).map(p => ({ d: p.d, v: p.v / 1000 })); const ch = rollChange(ecbLiq, 91, true); full.ecb_liq = { s: ch, w: 1095 }; zInput({ id: 'ecb_liq', block: 'balance', weight: 6, dir: 1, name: 'Eurosystem bank liquidity (deposit facility + current accounts), 13-week change', unit: '%', keep: 160 }, ch, 1095, { level: r1(last(ecbLiq).v), levelUnit: '€bn', levelSeries: tail(ecbLiq, 160) }); }
  else unavailable('ecb_liq', 'balance', 6, 1, 'Eurosystem bank liquidity, 13-week change', '%', 'ECB ILM did not load.');

  // 9. RBA Exchange Settlement balances, 13-week % change
  const rbaES = rbaSeries(D.rba_a1, /^exchange settlement balances/i);
  if (rbaES && rbaES.s.length > 60) { const es = rbaES.s.map(p => ({ d: p.d, v: p.v / 1000 })); const ch = rollChange(es, 91, true); full.rba_es = { s: ch, w: 1095 }; zInput({ id: 'rba_es', block: 'balance', weight: 3, dir: 1, name: 'RBA Exchange Settlement balances, 13-week change', unit: '%', keep: 160 }, ch, 1095, { level: r1(last(es).v), levelUnit: 'A$bn', levelSeries: tail(es, 160), srcId: rbaES.id }); }
  else unavailable('rba_es', 'balance', 3, 1, 'RBA Exchange Settlement balances, 13-week change', '%', 'RBA table A1 did not load.');

  // 10. BoJ total assets, 3-month % change
  if (F('JPNASSETS')) { const ch = rollChange(F('JPNASSETS'), 91, true); full.boj_assets = { s: ch, w: 1825 }; zInput({ id: 'boj_assets', block: 'balance', weight: 3, dir: 1, name: 'Bank of Japan total assets, 3-month change', unit: '%', keep: 60 }, ch, 1825, { level: r1(last(F('JPNASSETS')).v / 10000), levelUnit: '¥tn', levelSeries: tail(F('JPNASSETS'), 60) }); }
  else unavailable('boj_assets', 'balance', 3, 1, 'Bank of Japan total assets, 3-month change', '%', 'Needs FRED (JPNASSETS).');

  // 11. Money — global M2 at constant FX when ≥3 components load, else US M2
  {
    const comps = [['M2SL', null, 1], ['M3EZ', 'DEXUSEU', 1], ['M2JP', 'DEXJPUS', -1], ['M2CN', 'DEXCHUS', -1], ['M2GB', 'DEXUSUK', 1]].filter(([m]) => F(m));
    const annualise = g => g.map(p => { const q = atOrBefore(g, shiftIso(p.d, -91)); return q && q.v > 0 ? { d: p.d, v: ((p.v / q.v) ** 4 - 1) * 100 } : null; }).filter(Boolean);
    if (comps.length >= 3 && comps.every(([, fx]) => !fx || F(fx))) {
      const base = comps.map(([m]) => F(m)[0].d).sort().pop();
      const conv = comps.map(([m, fx, sign]) => { let k = 1; if (fx) { const q = atOrBefore(F(fx), base) || F(fx)[0]; k = sign > 0 ? q.v : 1 / q.v; } return { s: F(m), k }; });
      const g = conv[0].s.filter(p => p.d >= base).map(p => { let tot = 0; for (const c of conv) { const q = atOrBefore(c.s, p.d); if (!q) return null; tot += q.v * c.k; } return { d: p.d, v: tot }; }).filter(Boolean);
      const ann = annualise(g); full.m2 = { s: ann, w: 1825 };
      zInput({ id: 'm2', block: 'money', weight: 5, dir: 1, name: `Global M2 (${comps.length} economies, constant FX), 3-month annualised`, unit: '%', keep: 60 }, ann, 1825, { yoy: r1(changeOver(g, 365, true)), components: comps.map(([m]) => FRED_IDS[m]) });
    } else if (F('M2SL')) { const ann = annualise(F('M2SL')); full.m2 = { s: ann, w: 1825 }; zInput({ id: 'm2', block: 'money', weight: 5, dir: 1, name: 'US M2, 3-month annualised', unit: '%', keep: 60, status: 'substituted', note: 'Fewer than three non-US M2 series available from FRED; US M2 shown.' }, ann, 1825, { yoy: r1(changeOver(F('M2SL'), 365, true)) }); }
    else unavailable('m2', 'money', 5, 1, 'Global M2, 3-month annualised', '%', 'Needs FRED (M2SL and partners).');
  }
  // 12. China money — M2 year-on-year as the proxy for the credit impulse
  if (F('M2CN')) { const yoy = rollChange(F('M2CN'), 365, true); full.cn_money = { s: yoy, w: 1825 }; zInput({ id: 'cn_money', block: 'money', weight: 5, dir: 1, name: 'China M2, year-on-year (proxy for credit impulse)', unit: '%', keep: 60, status: 'substituted', note: 'Total Social Financing has no free machine-readable feed; China M2 growth is the proxy.' }, yoy, 1825); }
  else unavailable('cn_money', 'money', 5, 1, 'China credit impulse', '%', 'Needs FRED (MYAGM2CNM189N).');

  // 13. VIX (CBOE)
  if (D.cboe_vix) { full.vix = { s: D.cboe_vix, w: 730 }; zInput({ id: 'vix', block: 'volfx', weight: 5, dir: -1, name: 'VIX (equity volatility)', unit: 'index', status: 'substituted', note: 'MOVE (bond volatility) is the preferred input but has no free machine-readable feed; VIX is used.' }, D.cboe_vix, 730); }
  else unavailable('vix', 'volfx', 5, -1, 'VIX', 'index', 'CBOE feed did not load.');

  // 14. Broad US dollar (BIS nominal effective exchange rate), 13-week % change
  const eerUS = D.bis_eer && D.bis_eer.US;
  if (eerUS) { const ch = rollChange(eerUS, 91, true); full.usd = { s: ch, w: 730 }; zInput({ id: 'usd', block: 'volfx', weight: 5, dir: -1, name: 'Broad US dollar (BIS effective rate), 13-week change', unit: '%' }, ch, 730, { level: r2(last(eerUS).v), levelSeries: tail(eerUS, 260) }); }
  else unavailable('usd', 'volfx', 5, -1, 'Broad US dollar, 13-week change', '%', 'BIS EER did not load.');

  // ---- composite ----
  const BLOCKS = { plumbing: 'Funding plumbing', credit: 'Credit', balance: 'Central bank balance sheets', money: 'Money supply', volfx: 'Volatility & the dollar' };
  const BW = { plumbing: 35, credit: 25, balance: 20, money: 10, volfx: 10 };
  const blocks = {}; for (const b of Object.keys(BLOCKS)) blocks[b] = { id: b, name: BLOCKS[b], weight: BW[b], liveWeight: 0, contribution: 0, inputs: [] };
  let ws = 0, cs = 0;
  for (const x of ind) { blocks[x.block].inputs.push(x.id); if (x.status === 'unavailable' || x.z == null) { x.signed = null; x.contribution = null; continue; } x.signed = r2(clamp(x.z * x.dir, -3, 3)); x.contribution = r2(x.signed * x.weight / 100); ws += x.weight; cs += x.signed * x.weight; blocks[x.block].liveWeight += x.weight; blocks[x.block].contribution += x.signed * x.weight / 100; }
  const composite = ws ? cs / ws : null;
  for (const b of Object.values(blocks)) { b.contribution = r2(b.contribution); b.score = b.liveWeight ? r2(b.contribution * 100 / b.liveWeight) : null; b.band = band(b.score); }

  // ---- composite history: weekly for 52 weeks, recomputed with the same rules at each past date ----
  const today = new Date().toISOString().slice(0, 10); const hist = [];
  for (let w = 52; w >= 0; w--) { const d = shiftIso(today, -7 * w); let ws2 = 0, cs2 = 0;
    for (const x of ind) { if (x.status === 'unavailable') continue; const f = full[x.id]; if (!f) continue; let sc = null;
      if (f.s) { const i = idxAtOrBefore(f.s, d); if (i < 0) continue; const z = zAt(f.s, f.w, i); if (z == null) continue; sc = clamp(z * x.dir, -3, 3); }
      else if (x.id === 'res_gdp') { const q = atOrBefore(f.level, d); if (!q) continue; sc = clamp(q.v - 11, -2.5, 2.5); }
      else if (x.id === 'srf') { const i = idxAtOrBefore(f.level, d); if (i < 9) continue; sc = -clamp(Math.max(...f.level.slice(i - 9, i + 1).map(p => p.v)) / 25, 0, 2.5); }
      else continue; ws2 += x.weight; cs2 += sc * x.weight; }
    if (ws2) hist.push({ d, v: r2(cs2 / ws2) }); }
  const compAt = k => { const p = hist[hist.length - 1 - k]; return p ? p.v : null; };
  return { indicators: ind, blocks: Object.values(blocks), composite: { value: r2(composite), band: band(composite), liveWeight: ws, chg4w: composite != null && compAt(4) != null ? r2(composite - compAt(4)) : null, chg13w: composite != null && compAt(13) != null ? r2(composite - compAt(13)) : null, history: hist }, aux: { sofr, ecbLiq, rbaES } };
}

// ---------- regions ----------
const REGION_DEFS = [
  { id: 'us', name: 'United States', area: 'US', ofr: 'United States', group: 'Americas' },
  { id: 'au', name: 'Australia', area: 'AU', ofr: 'Other advanced economies', group: 'Asia-Pacific' },
  { id: 'eu', name: 'Europe (euro area)', area: 'XM', ofr: 'Other advanced economies', group: 'Europe' },
  { id: 'gb', name: 'United Kingdom', area: 'GB', ofr: 'Other advanced economies', group: 'Europe' },
  { id: 'jp', name: 'Japan', area: 'JP', ofr: 'Other advanced economies', group: 'Asia ex-China' },
  { id: 'cn', name: 'China', area: 'CN', ofr: 'Emerging markets', group: 'China' },
  { id: 'in', name: 'India', area: 'IN', ofr: 'Emerging markets', group: 'Asia ex-China' },
  { id: 'kr', name: 'South Korea', area: 'KR', ofr: 'Emerging markets', group: 'Asia ex-China' },
  { id: 'tw', name: 'Taiwan', area: 'TW', ofr: 'Emerging markets', group: 'Asia ex-China' },
  { id: 'nz', name: 'New Zealand', area: 'NZ', ofr: 'Other advanced economies', group: 'Asia-Pacific' },
  { id: 'ca', name: 'Canada', area: 'CA', ofr: 'Other advanced economies', group: 'Americas' },
  { id: 'br', name: 'Brazil (South America)', area: 'BR', ofr: 'Emerging markets', group: 'Americas' },
  { id: 'mx', name: 'Mexico (Latin America)', area: 'MX', ofr: 'Emerging markets', group: 'Americas' },
  { id: 'za', name: 'South Africa (Africa)', area: 'ZA', ofr: 'Emerging markets', group: 'Africa' },
  { id: 'ru', name: 'Russia', area: 'RU', ofr: 'Emerging markets', group: 'Europe' },
];
function regions(D, core) {
  const F = k => D['fred_' + k]; const ci = id => core.indicators.find(i => i.id === id); const sig = id => { const x = ci(id); return x && x.signed != null ? x.signed : null; };
  const pol = a => D.bis_pol && D.bis_pol[a] && D.bis_pol[a].length ? D.bis_pol[a] : null;
  const eer = a => D.bis_eer && D.bis_eer[a] && D.bis_eer[a].length ? D.bis_eer[a] : null;
  const ofr = k => D.ofr && D.ofr[k] && D.ofr[k].length ? D.ofr[k] : null;
  const polScore = c => c == null ? null : r2(clamp(-c / 0.5, -2, 2));   // 100bp of hikes in 6 months ≈ −2
  const fxScore = c => c == null ? null : r2(clamp(c / 3, -2, 2));       // ±6% effective-rate move in 13 weeks ≈ ±2
  const stressScore = z => z == null ? null : r2(clamp(-z, -2.5, 2.5));
  const scoreOf = parts => { const live = parts.filter(p => p.score != null && p.w > 0); if (!live.length) return null; return r2(live.reduce((a, p) => a + p.score * p.w, 0) / live.reduce((a, p) => a + p.w, 0)); };
  const out = [];
  for (const R of REGION_DEFS) {
    const parts = []; const ps = pol(R.area), es = eer(R.area), os = ofr(R.ofr);
    if (ps) { const c6 = changeOver(ps, 182); parts.push({ id: 'policy', k: 'Central bank policy rate', v: r2(last(ps).v), unit: '%', asOf: last(ps).d, chg6m: r2(c6), chg12m: r2(changeOver(ps, 365)), score: polScore(c6), w: 40, series: tail(ps, 520), src: 'BIS' }); }
    if (es) { const c13 = changeOver(es, 91, true); const isUS = R.id === 'us'; parts.push({ id: 'fx', k: isUS ? 'US dollar, trade-weighted (BIS effective rate), 13-week change — weaker dollar = easier' : 'Currency, trade-weighted (BIS effective rate), 13-week change', v: r1(c13), unit: '%', level: r2(last(es).v), asOf: last(es).d, score: isUS ? r2(-fxScore(c13)) : fxScore(c13), w: 30, series: tail(es, 260), src: 'BIS' }); }
    if (os) { const z = zAt(os, 730); parts.push({ id: 'stress', k: `OFR financial-stress sub-index: ${R.ofr}`, v: r2(last(os).v), unit: 'index', asOf: last(os).d, chg4w: r2(changeOver(os, 28)), score: stressScore(z), w: 30, series: tail(os, 260), src: 'OFR' }); }
    // market-specific extras
    if (R.id === 'us') { for (const id of ['sofr_iorb', 'res_gdp', 'tga', 'srf', 'hy_oas', 'ccc_bb', 'fed_res_chg', 'm2']) { const x = ci(id); if (x && x.status !== 'unavailable') parts.push({ id, k: x.name, v: x.value, unit: x.unit, asOf: x.asOf, chg4w: x.chg4w, score: sig(id), w: x.weight, series: x.series, src: 'core' }); } }
    if (R.id === 'au') { const x = ci('rba_es'); if (x && x.status !== 'unavailable') parts.push({ id: 'rba_es', k: 'RBA Exchange Settlement balances', v: x.level, unit: 'A$bn', chg13w: x.value, asOf: x.asOf, score: sig('rba_es'), w: 35, series: x.levelSeries, src: 'RBA A1' });
      const cash = rbaSeries(D.rba_f1, /^cash rate target$/i), bab = rbaSeries(D.rba_f1, /3-month BABs\/NCDs|Bank Accepted Bills\/NCDs.*3/i) || rbaSeries(D.rba_f1, /EOD 3-month/i), au10 = rbaSeries(D.rba_f2, /Australian Government 10 year bond/i), au2 = rbaSeries(D.rba_f2, /Australian Government 2 year bond/i);
      if (cash && bab) { const q = atOrBefore(cash.s, last(bab.s).d); if (q) { const sp = (last(bab.s).v - q.v) * 100; parts.push({ id: 'bbsw', k: `${bab.name} minus cash rate target`, v: r1(sp), unit: 'bp', asOf: last(bab.s).d, score: r2(clamp(-(sp - 10) / 15, -2, 2)), w: 20, src: 'RBA F1' }); } }
      if (cash) parts.push({ id: 'cash', k: 'RBA cash rate target', v: r2(last(cash.s).v), unit: '%', asOf: last(cash.s).d, chg6m: r2(changeOver(cash.s, 182)), score: null, w: 0, src: 'RBA F1' });
      if (au10) parts.push({ id: 'au10', k: 'Australian Government 10-year bond yield', v: r2(last(au10.s).v), unit: '%', asOf: last(au10.s).d, chg4w: r2(changeOver(au10.s, 28)), score: null, w: 0, series: tail(au10.s, 260), src: 'RBA F2' });
      if (au2 && au10) { const q = atOrBefore(au2.s, last(au10.s).d); if (q) parts.push({ id: 'au_curve', k: 'AU 10-year minus 2-year (curve slope)', v: r2(last(au10.s).v - q.v), unit: '%', asOf: last(au10.s).d, score: null, w: 0, src: 'RBA F2' }); }
      const omo = rbaSeries(D.rba_a1, /repurchase agreements|repos/i); if (omo) parts.push({ id: 'omo', k: `RBA ${omo.name} (open market repo outstanding)`, v: r1(last(omo.s).v / 1000), unit: 'A$bn', asOf: last(omo.s).d, score: null, w: 0, src: 'RBA A1' }); }
    if (R.id === 'eu') { const x = ci('ecb_liq'); if (x && x.status !== 'unavailable') parts.push({ id: 'ecb_liq', k: 'Eurosystem bank liquidity (deposit facility + current accounts)', v: x.level, unit: '€bn', chg13w: x.value, asOf: x.asOf, score: sig('ecb_liq'), w: 35, series: x.levelSeries, src: 'ECB ILM' });
      if (D.ecb_ilm && D.ecb_ilm.L050100) { const g = D.ecb_ilm.L050100; parts.push({ id: 'eu_gov', k: 'Central government deposits at the Eurosystem', v: r1(last(g).v / 1000), unit: '€bn', asOf: last(g).d, chg4w: r1(changeOver(g, 28) / 1000), score: null, w: 0, src: 'ECB ILM' }); } }
    if (R.id === 'jp') { const x = ci('boj_assets'); if (x && x.status !== 'unavailable') parts.push({ id: 'boj_assets', k: 'Bank of Japan total assets', v: x.level, unit: '¥tn', chg13w: x.value, asOf: x.asOf, score: sig('boj_assets'), w: 35, series: x.levelSeries, src: 'FRED' }); }
    if (R.id === 'cn') { const x = ci('cn_money'); if (x && x.status !== 'unavailable') parts.push({ id: 'cn_money', k: 'China M2, year-on-year', v: x.value, unit: '%', asOf: x.asOf, score: sig('cn_money'), w: 35, series: x.series, src: 'FRED' }); }
    const score = scoreOf(parts); const scored = parts.filter(p => p.score != null && p.w > 0).length;
    const coverage = R.id === 'us' ? 'Full' : scored >= 4 ? 'Full' : scored >= 2 ? 'Partial' : scored === 1 ? 'Limited' : 'None';
    out.push({ id: R.id, name: R.name, group: R.group, score, band: band(score), coverage, inputs: parts });
  }
  const agg = (id, name, group, ids) => { const m = out.filter(r => ids.includes(r.id) && r.score != null); const sc = m.length ? r2(m.reduce((a, r) => a + r.score, 0) / m.length) : null; out.push({ id, name, group, score: sc, band: band(sc), coverage: 'Aggregate', inputs: m.map(r => ({ id: r.id, k: r.name, v: r.score, unit: 'score', score: r.score, w: 1 })) }); };
  agg('asiax', 'Asia ex-China (Japan, Korea, Taiwan, India)', 'Asia ex-China', ['jp', 'kr', 'tw', 'in']);
  agg('latam', 'South America / Latin America (Brazil, Mexico)', 'Americas', ['br', 'mx']);
  return out;
}

// ---------- rule-based commentary ----------
function commentary(core, regs, D) {
  const c = core.composite, ind = core.indicators, ci = id => ind.find(i => i.id === id);
  const live = ind.filter(i => i.contribution != null);
  const pos = live.filter(i => i.contribution > 0).sort((a, b) => b.contribution - a.contribution);
  const neg = live.filter(i => i.contribution < 0).sort((a, b) => a.contribution - b.contribution);
  const u = i => (i.unit === '%' || i.unit === 'bp') ? i.unit : ' ' + i.unit;
  const fmt = i => ({ id: i.id, name: i.name, value: i.value, unit: i.unit, signed: i.signed, contribution: i.contribution, text: `${i.name}: ${i.value}${u(i)} (score ${i.signed > 0 ? '+' : ''}${i.signed}, contributes ${i.contribution > 0 ? '+' : ''}${i.contribution})` });
  const trend = c.chg4w == null ? 'with no four-week comparison yet' : Math.abs(c.chg4w) < 0.1 ? 'little changed over the past month' : c.chg4w > 0 ? `up ${c.chg4w.toFixed(2)} over four weeks — loosening` : `down ${Math.abs(c.chg4w).toFixed(2)} over four weeks — tightening`;
  const plain = {
    Abundant: 'Money is cheap and easy to get. Banks have plenty of spare cash, lenders are relaxed, and there is little strain anywhere in the system. This is the backdrop in which risky assets usually do best — and the one in which excess tends to build.',
    Easing: 'Conditions are getting looser. Funding is comfortable and the direction of travel is towards more money in the system, not less.',
    Neutral: 'Nothing in the system is under strain, but nothing is flooding it either. Liquidity is not the thing driving markets right now — look to earnings, valuation and positioning instead.',
    Tightening: 'Money is getting harder to come by. Some parts of the system are showing strain. Historically this is when leverage gets cut and the weakest borrowers start to struggle, before the headlines notice.',
    Stressed: 'Funding markets are the story. Cash is scarce or expensive, lenders are pulling back, and assets that normally move independently start falling together.',
    'No reading': 'Not enough data could be fetched to form a reading.'
  };
  const headline = c.value == null ? 'No composite reading available.' : `Global liquidity is ${c.band.toUpperCase()} — composite ${c.value > 0 ? '+' : ''}${c.value.toFixed(2)}, ${trend}.`;
  const tensions = [];
  const rg = ci('res_gdp'), fr = ci('fed_res_chg'), si = ci('sofr_iorb'), hy = ci('hy_oas'), cb = ci('ccc_bb'), vx = ci('vix'), usd = ci('usd'), m2 = ci('m2'), tga = ci('tga'), srf = ci('srf'), ecb = ci('ecb_liq'), rba = ci('rba_es');
  const ok = x => x && x.status !== 'unavailable' && x.value != null;
  if (ok(fr) && fr.value > 0 && ok(rg) && rg.value < 11.5) tensions.push({ title: 'The Fed is buying, but this is not stimulus', body: `Reserves are up ${fr.value}% over 13 weeks, which looks like easing. But reserves are only ${rg.value}% of GDP — inside the zone where the Fed's own research says repo rates start reacting to Treasury issuance. These purchases exist to stop liquidity falling, not to add it. Reading a growing Fed balance sheet as "QE" here is the most common mistake of this cycle.` });
  if (ok(rg) && rg.value < 10.5) tensions.push({ title: 'Reserves are at the sensitivity threshold', body: `At ${rg.value}% of GDP, bank reserves are at or below the ~10% level where repo rates become sensitive to Treasury issuance (roughly 10bp per $50bn of coupons, per Fed research). Expect quarter-end and tax-date squeezes to be sharper than the headline numbers suggest.` });
  if (ok(si) && si.value >= 4 && hy && hy.signed != null && hy.signed > 0) tensions.push({ title: 'Plumbing is strained while credit is relaxed', body: `Overnight funding is pricing above the Fed's floor (SOFR ${si.value}bp over IORB) — banks are competing for cash — while credit markets say lenders are unworried. When these two disagree, the plumbing has historically been right first. Treat the credit calm as borrowed.` });
  if (ok(si) && si.value <= 0 && hy && hy.signed != null && hy.signed < -0.75) tensions.push({ title: 'Credit is worried before the plumbing is', body: `Credit stress is elevated versus the past two years while overnight funding is calm (SOFR at or below IORB). That combination usually means the worry is about borrowers' earnings, not about the availability of money — a growth problem rather than a liquidity problem.` });
  if (vx && vx.signed != null && vx.signed > 0.5 && cb && cb.signed != null && cb.signed < -0.5) tensions.push({ title: 'Calm on the surface, stress underneath', body: `Equity volatility is low (VIX ${vx.value}) while the gap between the weakest and strongest junk borrowers is widening (CCC−BB ${cb.value}%). The marginal borrower is struggling before the index notices; that gap has led the broader spread in past cycles.` });
  if (ok(usd) && usd.value < -2 && ok(m2) && m2.value < 3) tensions.push({ title: 'A weak dollar is flattering global liquidity', body: `The broad dollar is down ${Math.abs(usd.value)}% in 13 weeks. In dollar terms that makes foreign money supply look bigger, but constant-currency money growth is only ${m2.value}% annualised — little real money creation. Dollar-driven liquidity reverses on a single hawkish surprise; money-creation-driven liquidity does not.` });
  if (ok(usd) && usd.value > 3) tensions.push({ title: 'A stronger dollar is a global tightening', body: `The broad dollar is up ${usd.value}% in 13 weeks. For every borrower outside the US with dollar debt that is an automatic rise in the repayment burden, and it drains dollar liquidity from emerging markets even when US conditions look fine. Watch the Asia ex-China and Latin America panels.` });
  if (ok(tga) && tga.value > 100) tensions.push({ title: 'The Treasury is hoarding cash', body: `The Treasury's account at the Fed rose $${tga.value}bn in four weeks. Every dollar that moves into it leaves the banking system, so this is a reserve drain that has nothing to do with Fed policy — a fiscal-calendar effect that reverses when the Treasury spends.` });
  if (ok(tga) && tga.value < -100) tensions.push({ title: 'Treasury spending is injecting reserves', body: `The Treasury's cash balance fell $${Math.abs(tga.value)}bn in four weeks. That cash lands in the banking system as reserves — a liquidity boost that has nothing to do with the Fed and reverses at the next tax date or bill-issuance ramp.` });
  if (ok(srf) && srf.value > 5) tensions.push({ title: "Banks have used the Fed's emergency repo window", body: `Standing repo facility use peaked at $${srf.value}bn in the last ten business days. Any sustained use means cash is scarce enough that borrowing from the Fed beat borrowing in the market. Quarter-end spikes are normal; persistent use is not.` });
  if (ok(si) && si.sofr99 != null && si.sofr != null && (si.sofr99 - si.sofr) * 100 >= 12) tensions.push({ title: 'Repo is tight at the margin', body: `The 99th-percentile SOFR trade printed ${((si.sofr99 - si.sofr) * 100).toFixed(0)}bp above the median. The average borrower is fine; the marginal one is paying up. That dispersion tends to widen before the median moves.` });
  if (ok(ecb) && ok(fr) && Math.sign(ecb.value) !== Math.sign(fr.value) && Math.abs(ecb.value) > 2 && Math.abs(fr.value) > 2) tensions.push({ title: 'The Fed and the ECB are pulling in opposite directions', body: `Fed reserves ${fr.value > 0 ? 'rose' : 'fell'} ${Math.abs(fr.value)}% while Eurosystem liquidity ${ecb.value > 0 ? 'rose' : 'fell'} ${Math.abs(ecb.value)}% over 13 weeks. Global liquidity is the sum, but the dollar side dominates for risk assets — weight the Fed reading more heavily.` });
  if (ok(rba)) { const lvl = rba.level; if (lvl != null && lvl < 120) tensions.push({ title: 'Australian reserves are approaching the RBA\'s "ample" estimate', body: `Exchange Settlement balances are A$${lvl}bn against the RBA's A$70–100bn estimate of what banks need. The cash rate drifting up inside the RBA's 20bp corridor would be the first hard evidence that Australian reserves are no longer abundant.` }); }
  const dg2 = D.fred_DGS2; if (dg2 && ok(hy) && hy.unit === '%' && hy.chg4w != null) { const y4 = changeOver(dg2, 28); if (y4 != null && y4 < -0.25 && hy.chg4w > 0.3) tensions.push({ title: 'Yields are falling for the wrong reason', body: `The US 2-year yield dropped ${Math.abs(y4).toFixed(2)} points in four weeks while junk spreads widened ${hy.chg4w.toFixed(2)} points. Falling yields only mean easier money when credit is calm; with spreads widening this is a growth scare — the 2007, 2008 and March-2020 pattern, when "yields down" was not good news.` }); }
  { const bl = core.blocks.filter(b => b.score != null && b.liveWeight > 0).sort((x, y) => y.score - x.score); if (bl.length >= 2) { const hi = bl[0], lo = bl[bl.length - 1]; if (hi.score - lo.score >= 1.2 && hi.score > 0.3 && lo.score < -0.1) { const order = ['plumbing', 'credit', 'balance', 'money', 'volfx']; const upstream = order.indexOf(hi.id) < order.indexOf(lo.id) ? hi : lo; tensions.push({ title: `The layers disagree: ${hi.name.toLowerCase()} is ${hi.band.toLowerCase()}, ${lo.name.toLowerCase()} is ${lo.band.toLowerCase()}`, body: `${hi.name} scores ${hi.score > 0 ? '+' : ''}${hi.score} while ${lo.name} scores ${lo.score}. When the layers split, the one closer to where money is created — the plumbing, then central banks, then credit — has historically led; here that is ${upstream.name.toLowerCase()}. ${[hi, lo].filter(b => b.liveWeight < b.weight / 2).map(b => `${b.name} is reading on only ${b.liveWeight} of its ${b.weight} points of weight, so treat it as indicative.`).join(' ')}`.trim() }); } } }
  if (!tensions.length) tensions.push({ title: 'No conflicting signals', body: 'Plumbing, credit, balance-sheet and money readings are pointing the same way. That is unusual and worth noting — regimes are clearest when every layer agrees.' });
  const regionNotes = regs.filter(r => r.score != null).map(r => { const pr = r.inputs.filter(p => p.score != null && p.w > 0).sort((a, b) => b.score - a.score); const top = pr[0], bot = pr[pr.length - 1]; const f = p => `${p.k.replace(/, 13-week change|\(BIS effective rate\)/g, '').trim()}${p.v != null ? ` (${p.v}${p.unit === '%' || p.unit === 'bp' ? p.unit : p.unit === 'score' ? '' : ' ' + p.unit})` : ''}`; return { id: r.id, text: `${r.name}: ${r.band.toLowerCase()} (${r.score > 0 ? '+' : ''}${r.score}).${top ? ` Loosest factor — ${f(top)}.` : ''}${bot && bot !== top ? ` Tightest factor — ${f(bot)}.` : ''}` }; });
  return { headline, plain: plain[c.band], trend, drivers: { loosening: pos.slice(0, 4).map(fmt), tightening: neg.slice(0, 4).map(fmt) }, tensions, regionNotes };
}

// ---------- handler ----------
module.exports = async (req, res) => {
  const t0 = Date.now();
  try {
    const { D, H } = await loadAll();
    const core = build(D, H);
    const regs = regions(D, core);
    const comm = commentary(core, regs, D);
    delete core.aux;
    const okN = Object.values(H).filter(h => h.status === 'ok').length, total = Object.values(H).filter(h => h.status !== 'not_configured').length;
    const out = {
      generatedAt: new Date().toISOString(), buildMs: Date.now() - t0, fredConfigured: !!FRED_KEY,
      composite: core.composite, blocks: core.blocks, indicators: core.indicators, regions: regs, commentary: comm,
      dataHealth: { sourcesOk: okN, sourcesTotal: total, compositeCoverage: core.composite.liveWeight, series: H },
      method: { weights: { plumbing: 35, credit: 25, balance: 20, money: 10, volfx: 10 }, bands: { Abundant: '> +1.0', Easing: '+0.5 to +1.0', Neutral: '−0.5 to +0.5', Tightening: '−1.0 to −0.5', Stressed: '< −1.0' }, zWindows: 'daily series 2 years · weekly 3 years · monthly 5 years', clamp: '±3', note: 'Composite = weighted mean of signed, clamped z-scores. Unavailable inputs are dropped and weights re-normalised. Reserves/GDP and standing-repo use are level-scored (see scoreMethod on each). Regional scores: policy-rate 6-month change (40%), BIS effective exchange rate 13-week change (30%), OFR regional stress z-score (30%), plus market-specific inputs where available.' },
      sources: [
        { name: 'NY Fed Markets Data API', url: 'https://markets.newyorkfed.org', what: 'SOFR (with percentiles), EFFR, standing repo facility operations', cadence: 'Daily' },
        { name: 'US Treasury FiscalData', url: 'https://fiscaldata.treasury.gov', what: 'Daily Treasury Statement — TGA closing balance', cadence: 'Daily' },
        { name: 'Office of Financial Research', url: 'https://www.financialresearch.gov/financial-stress-index/', what: 'Financial Stress Index and sub-indices (credit, funding, volatility; US / other advanced / EM)', cadence: 'Daily' },
        { name: 'ECB Data Portal', url: 'https://data.ecb.europa.eu', what: 'Eurosystem liquidity (ILM): current accounts, deposit facility, government deposits; €STR', cadence: 'Weekly (Tuesdays) / daily' },
        { name: 'Bank for International Settlements', url: 'https://data.bis.org', what: 'Central bank policy rates and nominal effective exchange rates for all 15 markets', cadence: 'Daily' },
        { name: 'CBOE', url: 'https://www.cboe.com/tradable_products/vix/', what: 'VIX daily history', cadence: 'Daily' },
        { name: 'Reserve Bank of Australia', url: 'https://www.rba.gov.au/statistics/tables/', what: 'A1 balance sheet (Exchange Settlement balances, repos), F1 money-market rates, F2 bond yields', cadence: 'Weekly (Thursdays) / daily' },
        { name: 'FRED (Federal Reserve Bank of St Louis)', url: 'https://fred.stlouisfed.org', what: 'Reserve balances, GDP, IORB, ICE BofA credit spreads, BoJ assets, M2 aggregates', cadence: 'H.4.1 Thursdays; daily; monthly', requires: 'FRED_API_KEY' },
      ]
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const hardFails = Object.values(H).filter(h => h.status === 'failed').length;
    res.setHeader('Cache-Control', req.query && req.query.fresh ? 'no-store' : hardFails ? 'public, s-maxage=900, stale-while-revalidate=3600' : 'public, s-maxage=21600, stale-while-revalidate=86400');
    out.cachePolicy = hardFails ? 'short (15 min) — a feed failed this load, will retry' : 'standard (6 h)';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send(JSON.stringify(out));
  } catch (e) { res.setHeader('Cache-Control', 'no-store'); res.status(500).json({ error: String(e && e.stack || e) }); }
};
