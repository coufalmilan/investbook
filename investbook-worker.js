// InvestBook Proxy Worker – Gemini AI + Market Data (Stooq)
// Env var required: GEMINI_API_KEY

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function fetchStooq(sym) {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=json`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`Stooq HTTP ${r.status}`);
  let text = await r.text();
  // Stooq sometimes returns malformed JSON with empty volume – fix it
  text = text.replace(/"volume":}/g, '"volume":null}').replace(/"volume":,/g, '"volume":null,');
  const d = JSON.parse(text);
  const s = d?.symbols?.[0];
  if (s) { s._raw = text.slice(0, 200); } // debug: include raw snippet
  return s || null;
}

// Fallback: Yahoo Finance v8 API (no key needed)
async function fetchYahoo(sym) {
  // Map Stooq symbols to Yahoo symbols
  const YAHOO_MAP = {
    '^spx': '^GSPC', '^ndx': '^IXIC', '^dji': '^DJI', '^dax': '^GDAXI',
    'sxr8.de': 'SXR8.DE', 'btc.v': 'BTC-USD', 'xauusd': 'GC=F'
  };
  const ySym = YAHOO_MAP[sym.toLowerCase()] || sym;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?range=2d&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  const d = await r.json();
  const meta = d?.chart?.result?.[0]?.meta;
  const quotes = d?.chart?.result?.[0]?.indicators?.quote?.[0];
  if (!meta) throw new Error('Yahoo: no data');
  const closes = quotes?.close?.filter(v => v != null);
  const opens = quotes?.open?.filter(v => v != null);
  return {
    symbol: sym.toUpperCase().replace('^','').replace('.V',''),
    close: closes?.[closes.length - 1] ?? meta.regularMarketPrice ?? null,
    open: opens?.[0] ?? meta.previousClose ?? null,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return json({ error: 'Only POST allowed' }, 405);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

    // ── Market data: parallel Stooq fetches with Yahoo fallback ─────────────
    if (body.stooqSymbols) {
      const syms = body.stooqSymbols.split(',').map(s => s.trim()).filter(Boolean);
      const errors = [];
      // Try Stooq first
      const stooqResults = await Promise.allSettled(syms.map(fetchStooq));
      const symbols = [];
      const failedSyms = [];
      stooqResults.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value && r.value.close != null) {
          symbols.push(r.value);
        } else {
          failedSyms.push({ idx: i, sym: syms[i], err: r.reason?.message || 'null close' });
        }
      });
      // Fallback to Yahoo for failed symbols
      if (failedSyms.length > 0) {
        const yahooResults = await Promise.allSettled(failedSyms.map(f => fetchYahoo(f.sym)));
        yahooResults.forEach((r, i) => {
          const orig = failedSyms[i];
          if (r.status === 'fulfilled' && r.value) {
            r.value.symbol = syms[orig.idx].toUpperCase();
            r.value._source = 'yahoo';
            symbols.push(r.value);
          } else {
            errors.push({ sym: orig.sym, stooq: orig.err, yahoo: r.reason?.message || 'unknown' });
            symbols.push({ symbol: syms[orig.idx].toUpperCase(), close: null });
          }
        });
      }
      return json({ symbols, errors: errors.length ? errors : undefined });
    }

    // ── Gemini AI ──────────────────────────────────────────────────────────
    const { messages, systemPrompt, model } = body;
    if (!messages || !Array.isArray(messages)) return json({ error: 'messages[] required' }, 400);
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) return json({ error: 'GEMINI_API_KEY not configured' }, 500);

    const modelName = model || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const geminiBody = { contents: messages };
    if (systemPrompt) geminiBody.systemInstruction = { parts: [{ text: systemPrompt }] };

    let resp;
    try {
      resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) });
    } catch (e) { return json({ error: e.message }, 502); }

    const data = await resp.json();
    if (!resp.ok) return json({ error: data?.error?.message || `Gemini ${resp.status}` }, resp.status);
    return json({ text: data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '' });
  },
};
