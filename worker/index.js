// Cloudflare Worker for AMA Stock Screener: 1-minute quotes and headlines (optional; the site works without it).
// GET /q?k=KEY&s=AAPL,5347.KL,...   -> { at, q: { SYM: { p, c, h, l, d } } }   (max 45 symbols: free-plan subrequest limit)
// GET /news?k=KEY                    -> { at, news: [{ t, u, s, at }] }
// Secrets/vars: KEY (shared secret, also saved encrypted in the site's vault), ALLOW_ORIGIN (the site's origin).
const SYM = /^[A-Za-z0-9.^=-]{1,20}$/;
const MARKET_WORDS = '(stocks OR shares OR market OR markets OR economy OR inflation OR "interest rate" OR "central bank" OR earnings OR profit OR IPO OR bonds OR yields OR dollar OR ringgit OR oil OR "gold price" OR GDP OR tariff OR Fed OR Bursa OR SGX OR STI OR "Wall Street" OR investors)';
const SPORT = /\b(medal|games|cup|league|tournament|championship|olympic|match|goal|striker|badminton|football|cricket|F1)\b/i;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = { 'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || 'https://mikachufm2202.github.io', Vary: 'Origin', 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!env.KEY || url.searchParams.get('k') !== env.KEY) return new Response('{"error":"forbidden"}', { status: 403, headers: cors });
    const json = o => new Response(JSON.stringify(o), { headers: cors });
    if (url.pathname === '/q') {
      const syms = [...new Set((url.searchParams.get('s') || '').split(','))].filter(s => SYM.test(s)).slice(0, 45);
      const q = {};
      await Promise.all(syms.map(async s => {
        try {
          const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1d&interval=1d`,
            { headers: { 'User-Agent': 'Mozilla/5.0' }, cf: { cacheTtl: 30, cacheEverything: true } });
          const m = (await r.json())?.chart?.result?.[0]?.meta;
          if (!m?.regularMarketPrice) return;
          const prev = m.chartPreviousClose || m.previousClose;
          q[s] = { p: m.regularMarketPrice, c: prev ? m.regularMarketPrice / prev - 1 : null, h: m.regularMarketDayHigh, l: m.regularMarketDayLow,
            d: new Date((m.regularMarketTime + (m.gmtoffset || 0)) * 1000).toISOString().slice(0, 10) };
        } catch {}
      }));
      return json({ at: new Date().toISOString(), q });
    }
    if (url.pathname === '/news') {
      // d = the outlets the person chose (domains), each searched for market headlines
      const doms = (url.searchParams.get('d') || 'reuters.com,cnbc.com,channelnewsasia.com,bernama.com').split(',').filter(x => /^[a-z0-9.-]{3,40}$/.test(x)).slice(0, 20);
      const items = (await Promise.all(doms.map(async dom => {
        try {
          const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(`site:${dom} ${MARKET_WORDS}`)}+when:3h&hl=en-SG&gl=SG&ceid=SG:en`, { cf: { cacheTtl: 60, cacheEverything: true } });
          return [...(await r.text()).matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8).map(([, x]) => {
            const g = tag => (x.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
            const s = g('source') || '', t = g('title') || '';
            return { t: s && t.endsWith(` - ${s}`) ? t.slice(0, -s.length - 3) : t, u: g('link'), s, at: g('pubDate'), dom };
          });
        } catch { return []; }
      }))).flat();
      const seen = new Set();
      const news = items.filter(n => n.t && !SPORT.test(n.t) && [...n.t].filter(c => c.codePointAt(0) > 0x24F).length <= n.t.length * .3 && !seen.has(n.t) && seen.add(n.t)).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 120);
      return json({ at: new Date().toISOString(), news });
    }
    return new Response('{"error":"not found"}', { status: 404, headers: cors });
  },
};
