import { mkdir, writeFile } from 'node:fs/promises';

const USER_AGENT = 'OTC Filing Watch support@otcfilingwatch.com';
const SEC_UNIVERSE_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
const FINRA_URL = 'https://api.finra.org/data/group/otcMarket/name/OTCDAILYLIST';
const FORMS = ['8-K', '10-Q', '10-K', '20-F', '6-K', '1-A', '1-A/A', 'D', 'DEF 14A', 'PRE 14A', 'SC 13D', 'SC 13D/A', 'SC 13G', 'SC 13G/A', '4'];

function timeoutFetch(url, options = {}, timeout = 20000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
}

function text(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/&lt;\/?.*?&gt;/gi, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function eventKind(form, summary) {
  const upper = String(form || '').toUpperCase();
  if (/^(S-1|F-1|S-3|F-3|S-4|F-4|1-A|253G|424B|EFFECT|D)/.test(upper)) return 'Registration & financing';
  if (/^(10-K|10-Q|20-F)/.test(upper)) return 'Financial results';
  if (/^(8-K|6-K)/.test(upper)) return /Item 5\.02/i.test(summary) ? 'Management or board change' : 'Material disclosure';
  if (/^(SC 13|3|4|5|DEF 14A|PRE 14A)/.test(upper)) return 'Ownership & governance';
  return 'SEC disclosure';
}

async function issuerUniverse() {
  const response = await timeoutFetch(SEC_UNIVERSE_URL, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } }, 30000);
  if (!response.ok) throw new Error(`SEC issuer reference HTTP ${response.status}`);
  const data = await response.json();
  const fields = Array.isArray(data.fields) ? data.fields : [];
  const cik = fields.indexOf('cik');
  const name = fields.indexOf('name');
  const ticker = fields.indexOf('ticker');
  const exchange = fields.indexOf('exchange');
  const map = new Map();
  for (const row of data.data || []) {
    if (String(row?.[exchange] || '').toUpperCase() !== 'OTC') continue;
    const id = String(Number(row?.[cik] || 0));
    if (id === '0') continue;
    map.set(id, { cik: id, title: String(row?.[name] || '').trim(), ticker: String(row?.[ticker] || '').trim().toUpperCase() });
  }
  return map;
}

async function secEvents(universe) {
  const results = await Promise.all(FORMS.map(async (form) => {
    const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(form)}&output=atom&count=100`;
    try {
      const response = await timeoutFetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/atom+xml,application/xml,text/xml' } });
      if (!response.ok) return [];
      const xml = await response.text();
      return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => {
        const block = match[1];
        const rawTitle = text((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
        const link = (block.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
        const summary = text((block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [])[1]);
        const formType = text((block.match(/<category[^>]*term="([^"]+)"/i) || [])[1]) || form;
        const filed = (summary.match(/Filed:\s*([0-9-]{10})/i) || [])[1] || '';
        const accession = (summary.match(/AccNo:\s*([0-9-]+)/i) || [])[1] || '';
        const cik = String(Number((link.match(/\/data\/(\d+)\//) || rawTitle.match(/\((\d{1,10})\)/) || [])[1] || 0));
        const issuer = universe.get(cik);
        if (!issuer || !filed || !accession) return null;
        return {
          id: `sec-${accession.replace(/-/g, '')}`,
          cik,
          ticker: issuer.ticker,
          title: issuer.title || rawTitle,
          published: `${filed}T00:00:00Z`,
          link: link || 'https://www.sec.gov/edgar/search/',
          source: 'SEC EDGAR',
          form: formType,
          category: eventKind(formType, summary),
          industry: 'Official SEC filing',
          companyIntro: summary ? summary.slice(0, 420) : 'Official SEC filing matched to the current SEC OTC reference set.',
          eventCue: summary.match(/Item\s+(?:1\.01|2\.01|2\.02|2\.03|3\.02|4\.01|5\.02|5\.07)/i)?.[0] || '',
          chinaConnection: /\b(china|prc|hong kong)\b/i.test(`${issuer.title} ${summary}`) ? 'China nexus disclosed' : ''
        };
      }).filter(Boolean);
    } catch {
      return [];
    }
  }));
  const seen = new Set();
  return results.flat().filter((item) => item && !seen.has(item.id) && seen.add(item.id));
}

async function finraEvents() {
  const fields = ['OTCDailyListID', 'calendarDay', 'oldSymbolCode', 'newSymbolCode', 'oldSecurityDescription', 'newSecurityDescription', 'dailyListReasonDescription', 'reverseSplitRate', 'forwardSplitRate', 'changeSymbolFlag', 'securityDeleteFlag', 'securityAddFlag', 'bankruptcyFlag', 'newMarketCategoryCode', 'oldMarketCategoryCode', 'dailyListDatetime', 'commentText'];
  const days = Array.from({ length: 8 }, (_, index) => new Date(Date.now() - index * 86400000).toISOString().slice(0, 10));
  const batches = await Promise.all(days.map(async (day) => {
    try {
      const response = await timeoutFetch(FINRA_URL, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ limit: 500, fields, compareFilters: [{ fieldName: 'calendarDay', fieldValue: day, compareType: 'EQUAL' }] })
      });
      return response.ok ? await response.json() : [];
    } catch {
      return [];
    }
  }));
  const seen = new Set();
  return batches.flat().filter((row) => row && (row.reverseSplitRate || row.forwardSplitRate || row.changeSymbolFlag === 'Y' || row.securityDeleteFlag === 'Y' || row.securityAddFlag === 'Y' || /name|market|suspension|halt|caveat|bankrupt|conversion|reclassification|split/i.test(String(row.dailyListReasonDescription || '')))).map((row) => {
    const oldSymbol = String(row.oldSymbolCode || '').trim().toUpperCase();
    const newSymbol = String(row.newSymbolCode || '').trim().toUpperCase();
    const title = String(row.newSecurityDescription || row.oldSecurityDescription || '').trim() || [oldSymbol, newSymbol].filter(Boolean).join(' → ') || 'OTC security';
    const action = String(row.dailyListReasonDescription || 'FINRA OTC corporate action').trim();
    const id = `finra-${row.OTCDailyListID || `${row.calendarDay}-${oldSymbol}-${newSymbol}-${action}`}`;
    return { id, cik: '', ticker: newSymbol || oldSymbol, title, published: String(row.dailyListDatetime || row.calendarDay || new Date().toISOString()).replace(' ', 'T') + (String(row.dailyListDatetime || '').includes('Z') ? '' : 'Z'), link: 'https://otce.finra.org/otce/dailyList', source: 'FINRA OTC Daily List', form: 'FINRA Daily List', category: 'Market action', industry: 'OTC market action', companyIntro: [action, oldSymbol || newSymbol ? `Ticker ${oldSymbol || '—'} → ${newSymbol || '—'}` : '', row.reverseSplitRate ? `Reverse split ${row.reverseSplitRate}` : '', row.forwardSplitRate ? `Forward split ${row.forwardSplitRate}` : ''].filter(Boolean).join(' · '), detail: action, marketAction: { action, oldSymbol, newSymbol, reverseSplitRate: String(row.reverseSplitRate || ''), forwardSplitRate: String(row.forwardSplitRate || '') } };
  }).filter((item) => !seen.has(item.id) && seen.add(item.id));
}

const generatedAt = new Date().toISOString();
const universe = await issuerUniverse();
const [sec, finra] = await Promise.all([secEvents(universe), finraEvents()]);
const seen = new Set();
const items = [...sec, ...finra].filter((item) => !seen.has(item.id) && seen.add(item.id)).sort((a, b) => String(b.published).localeCompare(String(a.published))).slice(0, 300);
const snapshot = { fetchedAt: generatedAt, items, coverage: { total: items.length, registration: items.filter((item) => /Registration|financing/i.test(item.category)).length, financial: items.filter((item) => item.category === 'Financial results').length, material: items.filter((item) => /disclosure|change/i.test(item.category)).length }, sourceStatus: [{ source: 'SEC EDGAR current filings matched to the SEC OTC reference set', state: sec.length ? 'live' : 'delayed' }, { source: 'FINRA OTC Daily List', state: finra.length ? 'live' : 'delayed' }], coverageRule: 'SEC events require a current OTC label in the SEC company ticker-and-exchange reference file; FINRA events are from the official OTC Daily List.' };
await mkdir('public/data', { recursive: true });
await writeFile('public/data/official-otc-events.json', `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Wrote ${items.length} official OTC events (${sec.length} SEC, ${finra.length} FINRA).`);
