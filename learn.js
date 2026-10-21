// learn.js: the Learn tab, the candlestick pattern library, the glossary and curated resources.
// Static content only. Facts about rules and hours were checked as of Oct 2026; regulators change them.

// ---------------------------------------------------------------- candlestick drawing
// c = pattern candles as [open, high, low, close]; ctx = 'up' | 'down' | '' prior trend, drawn in grey.
export function candleSvg(c, ctx) {
  const first = c[0], all = [];
  if (ctx === 'down') { let o = Math.max(first[0], first[3]) + 14; for (let i = 0; i < 3; i++, o -= 5) all.push([o, o + 1.5, o - 5.5, o - 4.5, 1]); }
  if (ctx === 'up') { let o = Math.min(first[0], first[3]) - 14; for (let i = 0; i < 3; i++, o += 5) all.push([o, o + 5.5, o - 1.5, o + 4.5, 1]); }
  all.push(...c);
  const W = 240, Hh = 110, pad = 8, hi = Math.max(...all.map(x => x[1])), lo = Math.min(...all.map(x => x[2]));
  const y = v => pad + (hi - v) / (hi - lo || 1) * (Hh - 2 * pad);
  const step = Math.min(30, (W - 20) / all.length), bw = step * .55, x0 = (W - step * all.length) / 2 + step / 2;
  return `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="candlestick pattern">${all.map(([o, h, l, cl, grey], i) => {
    const x = x0 + i * step, col = grey ? '#555' : cl >= o ? '#2bd96b' : '#ff4d4d';
    const top = y(Math.max(o, cl)), bot = y(Math.min(o, cl));
    return `<line x1="${x}" x2="${x}" y1="${y(h)}" y2="${y(l)}" stroke="${col}" stroke-width="1.5"/><rect x="${x - bw / 2}" y="${top}" width="${bw}" height="${Math.max(bot - top, 1.5)}" fill="${col}"/>`;
  }).join('')}</svg>`;
}

export const PATTERNS = [
  { n: 'Hammer', k: 'bull', r: '1 candle', ctx: 'down', c: [[48, 52, 34, 51]], d: 'Small body near the top, lower shadow at least twice the body, little or no upper shadow. Sellers pushed price down hard, buyers took it all back by the close.', t: 'Only meaningful after a decline, ideally at support. Confirm with a higher close the next day. Stop below the hammer low.' },
  { n: 'Inverted hammer', k: 'bull', r: '1 candle', ctx: 'down', c: [[40, 56, 39, 43]], d: 'Small body at the bottom, long upper shadow. Buyers tested higher prices; the attempt failed but shows demand is waking up.', t: 'Weaker than a hammer. Needs a strong bullish confirmation candle.' },
  { n: 'Hanging man', k: 'bear', r: '1 candle', ctx: 'up', c: [[72, 73, 58, 70.5]], d: 'Same shape as a hammer, but after a rally. Shows heavy selling inside the day even though the close recovered.', t: 'Warning, not a signal. Act only if the next candle closes below the hanging man body.' },
  { n: 'Shooting star', k: 'bear', r: '1 candle', ctx: 'up', c: [[70, 85, 67, 68]], d: 'Small body near the low, long upper shadow after an uptrend. Buyers spiked price up, then sellers slammed it back down.', t: 'Strong at resistance or after a stretched run. Confirm with a lower close.' },
  { n: 'Doji', k: 'neu', r: '1 candle', ctx: '', c: [[50, 58, 42, 50.3]], d: 'Open and close almost equal. Indecision: neither side won the session.', t: 'After a long trend it can mark exhaustion. In a sideways market it means little.' },
  { n: 'Dragonfly doji', k: 'bull', r: '1 candle', ctx: 'down', c: [[50, 50.5, 36, 50.2]], d: 'Open, high and close at the top, long lower shadow. Sellers were fully rejected.', t: 'Bullish at the bottom of a decline or at support.' },
  { n: 'Gravestone doji', k: 'bear', r: '1 candle', ctx: 'up', c: [[70, 84, 69.5, 70.2]], d: 'Open, low and close at the bottom, long upper shadow. Buyers were fully rejected.', t: 'Bearish at the top of a rally or at resistance.' },
  { n: 'Spinning top', k: 'neu', r: '1 candle', ctx: '', c: [[50, 58, 44, 52]], d: 'Small body with shadows on both sides. Indecision with some volatility.', t: 'A pause. Watch the next candle for direction.' },
  { n: 'Bullish marubozu', k: 'bull', r: '1 candle', ctx: '', c: [[40, 60, 40, 60]], d: 'A big green body with no shadows: opened at the low, closed at the high. Buyers controlled the whole session.', t: 'Shows strong momentum; often a continuation or breakout candle.' },
  { n: 'Bearish marubozu', k: 'bear', r: '1 candle', ctx: '', c: [[60, 60, 40, 40]], d: 'A big red body with no shadows. Sellers controlled the whole session.', t: 'Strong selling pressure; respect it, don\'t catch it.' },
  { n: 'Bullish engulfing', k: 'bull', r: '2 candles', ctx: 'down', c: [[48, 49, 44, 45], [44, 51.5, 43, 51]], d: 'A green body completely covers the previous red body. Control flipped from sellers to buyers.', t: 'One of the more reliable reversal patterns, especially at support with rising volume.' },
  { n: 'Bearish engulfing', k: 'bear', r: '2 candles', ctx: 'up', c: [[70, 74, 69, 73], [74, 75, 67, 68]], d: 'A red body completely covers the previous green body after a rally.', t: 'Stronger at resistance and on high volume.' },
  { n: 'Piercing line', k: 'bull', r: '2 candles', ctx: 'down', c: [[53, 54, 42, 43], [40, 49.5, 39, 49]], d: 'After a red candle, price opens lower but closes above the midpoint of that red body.', t: 'Softer than engulfing. Wants confirmation.' },
  { n: 'Dark cloud cover', k: 'bear', r: '2 candles', ctx: 'up', c: [[68, 78, 67, 77], [79, 80, 71, 72]], d: 'After a green candle, price opens higher but closes below the midpoint of that green body.', t: 'Bearish mirror of the piercing line.' },
  { n: 'Bullish harami', k: 'bull', r: '2 candles', ctx: 'down', c: [[55, 56, 40, 41], [44, 47.5, 43, 47]], d: 'A small green body sits inside the previous big red body ("harami" = pregnant). Selling momentum is stalling.', t: 'Early warning only. Wait for a break above the first candle\'s high.' },
  { n: 'Bearish harami', k: 'bear', r: '2 candles', ctx: 'up', c: [[65, 80, 64, 79], [76, 77, 72, 73]], d: 'A small red body inside the previous big green body. Buying momentum is stalling.', t: 'Wait for a break below the first candle\'s low.' },
  { n: 'Tweezer bottom', k: 'bull', r: '2 candles', ctx: 'down', c: [[48, 49, 40, 41], [41.5, 47, 40, 46]], d: 'Two candles with matching lows. The same price rejected sellers twice.', t: 'Gives a clear stop level just under the twin lows.' },
  { n: 'Tweezer top', k: 'bear', r: '2 candles', ctx: 'up', c: [[70, 80, 69, 79], [78.5, 80, 72, 73]], d: 'Two candles with matching highs. The same price rejected buyers twice.', t: 'Gives a clear stop level just above the twin highs.' },
  { n: 'Morning star', k: 'bull', r: '3 candles', ctx: 'down', c: [[57, 58, 44, 45], [42, 43.5, 39, 41.5], [44, 55, 43, 54]], d: 'Big red candle, a small "star" that gaps lower, then a big green candle closing well into the first body.', t: 'A classic bottom reversal. The third candle\'s volume matters.' },
  { n: 'Evening star', k: 'bear', r: '3 candles', ctx: 'up', c: [[64, 76, 63, 75], [78, 80, 77, 79], [76, 77, 65, 66]], d: 'Big green candle, a small star that gaps higher, then a big red candle closing well into the first body.', t: 'A classic top reversal.' },
  { n: 'Three white soldiers', k: 'bull', r: '3 candles', ctx: 'down', c: [[40, 46, 39, 45], [44, 52, 43, 51], [50, 58, 49, 57]], d: 'Three strong green candles in a row, each opening inside the previous body and closing near its high.', t: 'Strong reversal or trend start. After a long run, it can also mean short-term exhaustion.' },
  { n: 'Three black crows', k: 'bear', r: '3 candles', ctx: 'up', c: [[70, 71, 63, 64], [65, 66, 57, 58], [59, 60, 51, 52]], d: 'Three strong red candles in a row, each closing near its low.', t: 'Strong bearish reversal.' },
  { n: 'Rising three methods', k: 'bull', r: '5 candles', ctx: 'up', c: [[50, 61, 49, 60], [59, 60, 56, 57], [57, 58, 54, 55], [55, 57, 53, 56], [56, 66, 55, 65]], d: 'A big green candle, three small pullback candles that stay inside its range, then another big green candle to a new high.', t: 'Continuation: the trend rested and resumed.' },
  { n: 'Falling three methods', k: 'bear', r: '5 candles', ctx: 'down', c: [[65, 66, 54, 55], [56, 59, 55, 58], [58, 61, 57, 60], [60, 61, 57, 58], [59, 60, 44, 45]], d: 'A big red candle, three small bounce candles inside its range, then another big red candle to a new low.', t: 'Continuation of a downtrend.' },
  { n: 'Bullish kicker', k: 'bull', r: '2 candles', ctx: 'down', c: [[60, 61, 52, 53], [62, 70, 61, 69]], d: 'A red candle followed by a green candle that gaps up above the red candle\'s open. Sentiment changed overnight, often on news.', t: 'Among the strongest signals, but check what the news was.' },
];

// ---------------------------------------------------------------- lessons
const box = (title, body) => `<blockquote><b>${title}</b><br>${body}</blockquote>`;
export const LEARN = [
  { id: 'start', t: 'Start here: using AMA Stock Screener', lvl: 'Everyone', html: `
<p>AMA Stock Screener tracks about 1,650 stocks across Malaysia, Singapore, the US and global markets, plus indices, commodities, currencies and rates. It screens every stock for Shariah compliance and ranks ideas. Each family member has their own <b>profile</b> (tap the round avatar, top right) with their own watchlist, notes, paper-trading account, watch-later list and notifications. Everything is encrypted with the family password before it is published.</p>
<p><b>Freshness:</b> quotes and breaking news refresh about every 10 minutes (every minute with the optional Cloudflare Worker). The full analysis runs after each market close. Tap <b>⟳</b> to fetch fresh prices now.</p>
<h2>Tabs</h2>
<ul>
<li><b>MKT</b>: market sessions in Singapore time, the outlook for the next week, month and 3 months, indices, Shariah ETFs, commodities, FX and rates, sector heat and top movers.</li>
<li><b>BRF</b>: the daily brief (Mon–Sat about 06:30 SGT) and the full weekly report (Sunday 17:00 SGT), written by an AI from the data. A number check warns you if the AI wrote a figure that isn't in the data.</li>
<li><b>IDEA</b>: ranked Shariah-compliant ideas per market: invest/swing and day-trade watch.</li>
<li><b>SCRN</b>: the whole universe, filterable by market, Shariah status and sector, and sortable on any column.</li>
<li><b>WL</b>: your watchlist with notes and price alerts (push notifications).</li>
<li><b>PAPR</b>: paper trading: practise with virtual money at real prices, with a family leaderboard.</li>
<li><b>NOTE</b>: your stock notes and trading journal.</li>
<li><b>NEWS</b>: headlines by theme, the week's economic calendar in SGT, upcoming earnings.</li>
<li><b>TV</b>: latest videos and podcast episodes from market channels, and a study plan.</li>
<li><b>EDU</b> and <b>GLOS</b>: this course and the terminology list.</li>
</ul>
<h2>The command bar</h2>
<p>Type a ticker or company name and press GO: <code>AAPL</code>, <code>5347</code> (Tenaga), <code>D05</code> (DBS), <code>Press Metal</code>. Typing a tab code (<code>WL</code>, <code>NEWS</code>) jumps there.</p>
<h2>Shariah status letters</h2>
<ul><li><span class="badge st-C">C</span> <b>Certified</b>: on the SC Malaysia Shariah list, or a member of an S&amp;P Shariah index (screened by a Shariah supervisory board).</li>
<li><span class="badge st-P">P</span> <b>Passes our screen</b>: business is permissible and debt and cash are each under 30% of market cap (AAOIFI-style), but no Shariah board has certified it. The data feed can't see the share of non-halal income, so verify before buying.</li>
<li><span class="badge st-R">R</span> <b>Review</b>: ratios pass, but the industry needs a revenue check (REITs, hotels, food, media, defence), or data is missing.</li>
<li><span class="badge st-F">F</span> <b>Fails</b>: prohibited business, ratios too high, or (Malaysia) not on the SC list.</li></ul>
<h2>What "P(up) 58%" means</h2>
<p>Every day each instrument gets a trend score from −100 to +100 (built from its 20/50/200-day averages, MACD, RSI and 1-month momentum). The model looks up every past day, over the last 2 years and in the same market, that had a similar score, and counts how often the price was higher 1 week, 1 month and 3 months later. That's the probability. The range is where 68% of those outcomes landed, scaled to this instrument's own volatility. It's an honest base rate, not a crystal ball: anything near 50% means "no edge". The market page shows the model's live track record once calls mature.</p>
${box('Golden rule', 'No forecast replaces a plan: know your entry, your stop and your position size before you buy. See "Risk and position sizing".')}` },

  { id: 'basics', t: '1 · Stock market basics', lvl: 'Basic', html: `
<h2>What a share is</h2>
<p>A share is a slice of ownership in a company. You profit through <b>capital gains</b> (selling higher than you bought) and <b>dividends</b> (a share of profits paid out). In Islamic terms, owning a share is a partnership (<i>musharakah</i>) in a real business, which is why the business itself must be halal.</p>
<h2>Exchanges you can reach from Singapore</h2>
<table><tr><th>Market</th><th>Exchange</th><th>Hours (SGT)</th><th>Board lot</th><th>Settlement</th><th>Your broker</th></tr>
<tr><td>Malaysia</td><td>Bursa Malaysia</td><td>09:00–12:30, 14:30–17:00</td><td>100 shares</td><td>T+2</td><td>Malacca Securities (M+), UOB Kay Hian</td></tr>
<tr><td>Singapore</td><td>SGX</td><td>09:00–17:00 (pre-open from 08:30)</td><td>100 shares</td><td>T+2</td><td>UOB Kay Hian</td></tr>
<tr><td>US</td><td>NYSE, Nasdaq</td><td>21:30–04:00 (US summer time), 22:30–05:00 (US winter time, from 1 Nov 2026)</td><td>1 share (fractions on moomoo)</td><td>T+1</td><td>moomoo</td></tr>
<tr><td>Hong Kong</td><td>HKEX</td><td>09:30–12:00, 13:00–16:00</td><td>varies by stock</td><td>T+2</td><td>moomoo</td></tr>
<tr><td>Japan</td><td>TSE</td><td>08:00–10:30, 11:30–14:30</td><td>100 shares</td><td>T+2</td><td>moomoo</td></tr></table>
<p class="note">Malaysia and Singapore share the same clock (UTC+8). Exchanges close on public holidays; the session panel doesn't know holidays.</p>
<h2>Indices</h2>
<p>An index tracks a basket of stocks: the <b>FBM KLCI</b> (30 largest on Bursa), <b>FBM Emas Shariah</b> (Shariah-compliant Bursa stocks), the <b>STI</b> (30 largest on SGX), the <b>S&amp;P 500</b> (500 large US companies), the <b>Nasdaq</b> (tech-heavy) and the <b>Dow Jones Islamic Market</b> indices. When people say "the market is up", they mean an index.</p>
<h2>Orders</h2>
<ul><li><b>Market order</b>: buy or sell now at the best available price. Fast, but you may get a worse price (slippage) in thin stocks.</li>
<li><b>Limit order</b>: only at your price or better. Use this by default, especially on Bursa small caps.</li>
<li><b>Stop order / stop-loss</b>: becomes a market (or limit) order when price hits your stop. Your seatbelt.</li>
<li><b>Bid / ask / spread</b>: the bid is the best price buyers offer, the ask is the best price sellers want; the gap is the spread, a hidden cost.</li></ul>
<h2>Tick sizes (minimum price steps)</h2>
<p>Bursa: 0.5 sen below RM1, 1 sen from RM1 to RM9.99, 2 sen from RM10 to RM99.98, 10 sen from RM100. SGX: S$0.001 below S$0.20, S$0.005 from S$0.20 to S$0.995, S$0.01 from S$1. On a 30-sen penny stock one tick is 1.7%, so spreads eat day traders alive in penny stocks.</p>
<h2>Accounts: CDS, CDP, custodian</h2>
<p>Bursa shares sit in your <b>CDS</b> account (opened through your Malaysian broker). SGX shares can sit in your own <b>CDP</b> account (direct ownership, linked to UOB Kay Hian) or in the broker's custodian account. moomoo holds US shares in a custodian (nominee) account.</p>
<h2>Corporate actions</h2>
<p><b>Dividends</b> (cash per share; you need to hold before the ex-date), <b>bonus issues</b> and <b>splits</b> (more shares, same total value), <b>rights issues</b> (the company sells new shares to existing holders, usually at a discount), <b>warrants</b> (rights to buy shares at a set price later; check their Shariah status separately), <b>privatisation offers</b>.</p>` },

  { id: 'candles', t: '2 · Reading candlesticks', lvl: 'Basic → Intermediate', html: `
<h2>Anatomy</h2>
<p>Each candle is one period (one day on the daily chart, 5 minutes on a 5-minute chart). The <b>body</b> spans open to close; green (or hollow) means close &gt; open, red means close &lt; open. The <b>wicks</b> (shadows) show the high and low. Long wicks show rejection: price went there and was pushed back.</p>
<svg viewBox="0 0 320 150" style="width:100%;max-width:420px;background:#000;border:1px solid #222" role="img" aria-label="candle anatomy">
<line x1="80" x2="80" y1="15" y2="135" stroke="#2bd96b" stroke-width="2"/><rect x="62" y="45" width="36" height="60" fill="#2bd96b"/>
<line x1="230" x2="230" y1="15" y2="135" stroke="#ff4d4d" stroke-width="2"/><rect x="212" y="45" width="36" height="60" fill="#ff4d4d"/>
<g fill="#ccc" font-size="11" font-family="monospace"><text x="104" y="19">high</text><text x="104" y="49">close</text><text x="104" y="108">open</text><text x="104" y="138">low</text>
<text x="254" y="19">high</text><text x="254" y="49">open</text><text x="254" y="108">close</text><text x="254" y="138">low</text>
<text x="40" y="149">bullish</text><text x="194" y="149">bearish</text></g></svg>
<h2>How to read them in context</h2>
<ol><li><b>Trend first.</b> A hammer means nothing in the middle of a range; after a 10-day fall into support it means a lot.</li>
<li><b>Location.</b> Patterns at support, resistance, a moving average (50/200-day) or a round number carry more weight.</li>
<li><b>Volume.</b> A reversal candle on 2× normal volume is far more convincing than one on thin volume.</li>
<li><b>Confirmation.</b> Wait for the next candle to close in the expected direction. You give up a little price for a lot of reliability.</li>
<li><b>Timeframe.</b> Daily and weekly candles are more reliable than 1-minute candles, which are mostly noise.</li></ol>
<h2>Body and wick language</h2>
<ul><li>Long body = conviction. Short body = indecision.</li><li>Long lower wick = buyers defended lower prices. Long upper wick = sellers defended higher prices.</li>
<li>Gaps (today's range doesn't overlap yesterday's) show urgency, often from news or earnings.</li><li>Inside bar (whole range inside yesterday's) = compression; the breakout often runs.</li></ul>` },

  { id: 'charts', t: '3 · Chart patterns & price action', lvl: 'Intermediate', html: `
<h2>Support and resistance</h2>
<p><b>Support</b> is a price area where buying has repeatedly stopped declines; <b>resistance</b> is where selling has capped rallies. Once broken, they often swap roles (old resistance becomes new support: "role reversal"). Mark them where several highs or lows line up, at round numbers, and at the 52-week high and low.</p>
<h2>Trends</h2>
<p>Uptrend = higher highs and higher lows. Downtrend = lower highs and lower lows. Draw trendlines under rising lows or over falling highs; the more touches, the more important. "The trend is your friend": most retail losses come from fighting it.</p>
<h2>Classic patterns</h2>
<ul><li><b>Head and shoulders</b> (top reversal): three peaks with the middle highest; a break of the "neckline" targets roughly the head's height below it. Inverse H&amp;S is the bullish bottom version.</li>
<li><b>Double top / double bottom</b>: two failed attempts at the same level, an "M" or a "W".</li>
<li><b>Triangles</b>: ascending (flat top, rising lows, usually bullish), descending (flat bottom, falling highs, usually bearish), symmetrical (direction from the breakout).</li>
<li><b>Flags and pennants</b>: short pauses after a sharp move ("flagpole"); breakouts tend to continue the move.</li>
<li><b>Cup and handle</b>: a rounded base, then a small pullback (the handle), then a breakout. Popular with growth investors.</li>
<li><b>Breakout and retest</b>: price breaks resistance, comes back to test it as support, then continues. The retest is often the lower-risk entry.</li></ul>
<h2>Volume confirms price</h2>
<p>Breakouts on volume 1.5–2× the 20-day average are more trustworthy. Rising prices on falling volume are suspect. The <b>Rel vol</b> column on this site is today's volume divided by the 20-day average.</p>
<h2>False breakouts</h2>
<p>Many breakouts fail, especially in thin stocks and in the first 15 minutes of the session. Wait for a close beyond the level, or a retest.</p>` },

  { id: 'indicators', t: '4 · Technical indicators', lvl: 'Intermediate', html: `
<h2>Moving averages</h2>
<p>The <b>SMA</b> (simple moving average) is the average close of the last N days; the <b>EMA</b> weights recent days more. Common uses: the 20-day for short-term trend, the 50-day for medium, the 200-day for long-term. Price above a rising 200-day = long-term uptrend. A <b>golden cross</b> is the 50-day crossing above the 200-day; a <b>death cross</b> is the reverse. Both lag, so they confirm, they don't predict.</p>
<h2>RSI (Relative Strength Index)</h2>
<p>Measures recent gains against losses on a 0–100 scale (14 periods by default). Above 70 = overbought, below 30 = oversold. In strong trends RSI can stay overbought for weeks, so use it with the trend: in an uptrend, buy dips when RSI returns to 40–50. <b>Divergence</b> (price makes a new high, RSI doesn't) warns that momentum is fading.</p>
<h2>MACD</h2>
<p>The 12-day EMA minus the 26-day EMA, with a 9-day signal line. The <b>histogram</b> is MACD minus signal: above zero and rising means momentum is building.</p>
<h2>Bollinger Bands</h2><p>A 20-day SMA ± 2 standard deviations. A band "squeeze" (narrow bands) often comes before a big move. Tags of the bands are not automatic sell or buy signals.</p>
<h2>ATR (Average True Range)</h2><p>The average daily range, including gaps. This site shows ATR as a % of price. Use it to size stops (for example 1.5× ATR below entry) and to pick day-trade candidates (2–7% is the sweet spot: enough movement, not chaos).</p>
<h2>VWAP</h2><p>The volume-weighted average price of the day. Intraday traders treat price above VWAP as buyers in control; institutions benchmark their fills against it. moomoo and TradingView both plot it.</p>
<h2>Fibonacci retracements</h2><p>Pullbacks often pause near 38.2%, 50% or 61.8% of the prior move. They're self-fulfilling at best; combine them with support and volume.</p>
<h2>Don't overload</h2><p>Pick 2–3 tools that answer different questions (trend: moving averages; momentum: RSI/MACD; risk: ATR) and learn them deeply.</p>` },

  { id: 'fundamentals', t: '5 · Fundamental analysis', lvl: 'Intermediate → Advanced', html: `
<h2>The three statements</h2>
<ul><li><b>Income statement</b>: revenue → gross profit → operating profit (EBIT) → net profit. Ask: is revenue growing, and are margins stable or rising?</li>
<li><b>Balance sheet</b>: assets = liabilities + equity. Ask: how much debt (interest-bearing debt matters for Shariah too), how much cash, and how big are receivables?</li>
<li><b>Cash flow statement</b>: operating cash flow minus capex = <b>free cash flow</b>. Profits can be engineered; cash is harder to fake.</li></ul>
<h2>Key ratios</h2>
<table><tr><th>Ratio</th><th>Formula</th><th>Rough read</th></tr>
<tr><td>P/E</td><td>Price ÷ earnings per share</td><td>Years of current profit you pay for. Compare within the sector and to growth.</td></tr>
<tr><td>Forward P/E</td><td>Price ÷ next year's expected EPS</td><td>Lower than trailing P/E = earnings expected to grow.</td></tr>
<tr><td>PEG</td><td>P/E ÷ growth %</td><td>Around 1 is "fair" for growth stocks.</td></tr>
<tr><td>P/B</td><td>Price ÷ book value per share</td><td>Useful for asset-heavy firms (property, plantations).</td></tr>
<tr><td>ROE</td><td>Net profit ÷ equity</td><td>15%+ sustained, without heavy debt, signals a quality business.</td></tr>
<tr><td>Net margin</td><td>Net profit ÷ revenue</td><td>Pricing power and efficiency.</td></tr>
<tr><td>Dividend yield</td><td>Dividend per share ÷ price</td><td>Check the payout ratio and free cash flow cover it.</td></tr>
<tr><td>Debt / equity</td><td>Total debt ÷ equity</td><td>Lower is safer and helps the Shariah ratio screen.</td></tr></table>
<h2>Valuation approaches</h2>
<p><b>Relative</b>: compare multiples with peers. <b>Intrinsic</b>: a discounted cash flow (DCF) model: forecast free cash flow, discount it back at your required return. Aswath Damodaran's channel (in the TV tab) teaches this properly. <b>Margin of safety</b>: buy below your estimate of value to allow for being wrong.</p>
<h2>Quality checklist</h2>
<ol><li>Can I explain how the company makes money in two sentences?</li><li>Does it have a moat (brand, network, cost advantage, switching costs, licences)?</li>
<li>Is management honest and aligned (insider ownership, sensible capital allocation, no related-party games)?</li><li>Five-year trend in revenue, margins, ROE and free cash flow?</li>
<li>Balance sheet: could it survive a bad year?</li><li>What has to go right for the price to double, and what could halve it?</li></ol>
<h2>Where results come out</h2>
<p>Bursa: quarterly reports within 2 months of quarter end (Bursa announcements). SGX: half-yearly for most companies (some quarterly). US: 10-Q quarterly and 10-K annually on SEC EDGAR, plus earnings calls. The <b>Research links</b> on each stock page take you there.</p>` },

  { id: 'shariah', t: '6 · Shariah investing', lvl: 'Essential', html: `
<h2>The two tests</h2>
<p><b>1. Business activity.</b> The core business must be permissible. Excluded: conventional banking, lending and insurance; gambling; alcohol; pork; tobacco; non-halal food and drink; adult and non-compliant entertainment; and, for many boards, weapons. <b>2. Financial ratios.</b> Riba (interest) must be limited: interest-bearing debt, interest-earning cash and interest income must stay under set limits.</p>
<h2>The main standards</h2>
<table><tr><th>Standard</th><th>Business activity</th><th>Financial ratios</th></tr>
<tr><td>SC Malaysia (SAC)</td><td>Non-compliant income &lt; 5% (banking, gambling, liquor, pork, tobacco, interest income…) and &lt; 20% (share trading, stockbroking, cinema, rental from non-compliant tenants)</td><td>Cash in conventional accounts / total assets &lt; 33%; interest-bearing debt / total assets &lt; 33%. Islamic deposits and sukuk don't count.</td></tr>
<tr><td>AAOIFI (Shariah Standard 21)</td><td>Impermissible income &lt; 5%</td><td>Interest-bearing debt &lt; 30% of market cap; interest-bearing deposits &lt; 30% of market cap</td></tr>
<tr><td>S&amp;P Shariah indices</td><td>Sector exclusions plus income tests</td><td>Debt, and cash plus interest-bearing securities, each &lt; 33% of 36-month average market cap; receivables plus cash &lt; 49%</td></tr>
<tr><td>MSCI Islamic</td><td>Impermissible income &lt; 5%</td><td>Debt, cash plus interest-bearing securities, and receivables plus cash, each &lt; 33.33% of total assets</td></tr></table>
<p class="note">For Bursa stocks, the SC list is the reference. Bursa marks compliant stocks with [S] in most trading apps. The list is updated on the last Friday of May and November.</p>
<h2>How this site decides</h2>
<p>Malaysia: SC list only (C if listed, F if not). US and global: membership of the S&amp;P 500 Shariah and S&amp;P Shariah world indices, read from SP Funds' daily ETF holdings (SPUS, SPWO, SPTE, SPRE). Others: our AAOIFI-style screen using the conservative market-cap version with all cash treated as interest-bearing. What the data feed can't see: the exact share of non-halal income. So a <b>P</b> is "not ruled out", never "certified".</p>
<h2>What's not allowed (most scholars)</h2>
<ul><li><b>Short selling</b>: selling what you don't own.</li><li><b>Conventional margin</b>: borrowing at interest to buy shares. Islamic margin (for example tawarruq-based) exists at some Malaysian brokers.</li>
<li><b>Conventional options, futures, CFDs and spread bets</b>: excessive uncertainty (gharar), no real ownership, and usually interest embedded.</li>
<li><b>Leveraged and inverse ETFs</b>: built from derivatives and borrowing.</li><li><b>Conventional bonds and fixed-dividend preference shares</b>: interest.</li>
<li><b>Interest on idle cash</b> in your broker account. If you receive any, give it to charity.</li></ul>
<h2>Day trading</h2>
<p>Many contemporary scholars accept buying and selling compliant shares within the same day in a cash account, because ownership passes at execution. Others discourage it as closer to speculation (maysir) than to partnership. Practical rules: compliant names only, cash account (no interest-bearing leverage), no short selling, no derivatives, and ask a scholar you trust. The ideas page keeps to these rules.</p>
<h2>Purifying dividends (tathir)</h2>
<p>Even compliant companies may earn a little non-halal income (for example bank interest). Donate that share of your dividend:</p>
<p><code>amount to purify = dividend received × (non-compliant income ÷ total income)</code></p>
<p>Example: RM500 of dividends, and the company's non-compliant income is 2% of total income: give RM10 to charity. Some scholars also ask you to purify capital gains; most standards require dividends only. Zoya and Musaffa estimate the ratio for US stocks.</p>
<h2>When a stock loses compliant status (SC guidance)</h2>
<p>If a stock you hold is reclassified as non-compliant: if the price on the effective date is at or above your cost, sell; dividends and gains up to that date are yours to keep, but anything after must be given to charity. If the price is below your cost, you may hold until it gets back to cost, then sell. If you knowingly bought a non-compliant stock, sell within a month and keep only your cost; give any gain to charity.</p>
<h2>Zakat on shares</h2>
<p>Common practice: for shares held to trade, pay 2.5% of their market value on your zakat date (haul). For long-term holdings, some scholars ask for zakat only on your share of the company's zakatable assets (cash, receivables, inventory), which is often lower. In Singapore, MUIS (Zakat Singapura) has a zakat calculator.</p>
<h2>Commodities, the Shariah way</h2>
<p>Gold and silver are ribawi items: exchanges must be spot, hand-to-hand. Gold futures, CFDs and leveraged gold are out. Look for physical gold, or gold accounts and ETFs with a published Shariah certificate (AAOIFI Shariah Standard 57 on gold). For oil, gas, palm oil and metals, the clean route is owning compliant producers (many Bursa plantation and energy names are on the SC list) rather than futures. The commodity prices on the market page are for information, to read the macro picture.</p>` },

  { id: 'daytrade', t: '7 · Day trading & swing playbook', lvl: 'Intermediate → Advanced', html: `
<h2>Choose your style honestly</h2>
<table><tr><th>Style</th><th>Holding</th><th>Time needed</th><th>Fits a full-time job?</th></tr>
<tr><td>Day trading</td><td>Minutes to hours</td><td>Full attention during the session</td><td>Hard (Bursa/SGX run during work hours; US runs past midnight SGT)</td></tr>
<tr><td>Swing trading</td><td>Days to weeks</td><td>30–60 min a day</td><td>Yes</td></tr>
<tr><td>Position investing</td><td>Months to years</td><td>A few hours a week</td><td>Yes</td></tr></table>
<p>Studies of retail day traders repeatedly find most lose money after costs. Start with swing trades and paper trading (moomoo has a paper-trading mode), and move to intraday only with a proven, written edge.</p>
<h2>A Singapore-time routine</h2>
<ul><li><b>06:30</b> read the daily brief (US close, overnight news, today's calendar).</li><li><b>08:30–09:00</b> pre-open: check gaps on your watchlist, set limit orders and alerts.</li>
<li><b>09:00–09:30</b> the opening is the most volatile period. Let the first 15 minutes set the range unless the plan is a gap play.</li><li><b>12:30–14:30</b> Bursa lunch break; SGX keeps trading.</li>
<li><b>17:00</b> Asia close. Journal the day.</li><li><b>21:30/22:30</b> US open. Set alerts and stop orders rather than staying up every night.</li></ul>
<h2>Picking day-trade candidates (the IDEA tab does this)</h2>
<ol><li>Liquid: tight spread, big daily value traded.</li><li>Moving: ATR 2–7%.</li><li>In play: relative volume above 1.5×, news or earnings.</li><li>Trend aligned: trade long setups in names above their 20/50-day averages.</li><li>Compliant: C first; P only after you've checked it.</li></ol>
<h2>Three simple long setups</h2>
<ul><li><b>Opening range breakout</b>: mark the high and low of the first 15–30 minutes; buy a break above the high on volume, with the stop under the range low.</li>
<li><b>Pullback to the moving average</b>: in a strong uptrend, buy the bounce off the rising 20-day (swing) or VWAP (intraday) with a bullish candle.</li>
<li><b>Breakout and retest</b>: wait for a breakout above resistance, then buy the first retest that holds.</li></ul>
<h2>Rules that keep you alive</h2>
<ul><li>Risk at most 0.5–1% of your account per trade.</li><li>Put the stop in when you enter, not later.</li><li>Look for at least 2:1 reward to risk.</li><li>Set a daily loss limit (for example 3R) and stop trading for the day when you hit it.</li>
<li>No averaging down on losing day trades.</li><li>Keep a journal (setup, entry, exit, reason, emotion); review it every Sunday with the weekly report.</li></ul>
<h2>Settlement and cash accounts</h2>
<p>Bursa and SGX settle T+2 and the US settles T+1. In a cash account, don't buy with funds you don't have, and don't sell before paying (contra/free-riding). Brokers penalise it and it raises Shariah questions. US "pattern day trader" rules apply to US margin accounts, not cash accounts; check moomoo's current rules for your account type.</p>` },

  { id: 'risk', t: '8 · Risk & position sizing', lvl: 'Essential', html: `
<h2>The formula</h2>
<p><code>shares = (account × risk %) ÷ (entry − stop)</code></p>
<p>Example: S$20,000 account, 1% risk = S$200. Entry S$2.50, stop S$2.35 (S$0.15 risk per share): 200 ÷ 0.15 = 1,333 shares, so buy 1,300 (13 board lots). Position value ≈ S$3,250. If the stop hits, you lose about S$195, not your peace of mind.</p>
<h2>Where to put stops</h2>
<ul><li>Below the swing low or support that defines the setup.</li><li>Or 1.5–2× ATR below entry.</li><li>Never at a round number where everyone else's stop sits; give it a tick or two.</li></ul>
<h2>Portfolio rules</h2>
<ul><li>No single stock above 10–15% of the portfolio.</li><li>Limit any one sector to about 30%.</li><li>Keep an emergency fund outside the market (6 months of expenses).</li><li>Currency is a risk too: MYR, SGD and USD move against each other.</li></ul>
<h2>Psychology</h2>
<p>Fear of missing out, revenge trading after a loss, and refusing to take a small loss are the classic account killers. Pre-commit with written plans and alerts; this site's alert fields are built for that.</p>` },

  { id: 'macro', t: '9 · Macro: what moves markets', lvl: 'Intermediate', html: `
<h2>Interest rates</h2>
<p>Central banks (the US Fed, Bank Negara Malaysia's OPR, the Monetary Authority of Singapore) set the price of money. Higher rates usually pressure growth stocks and property, and lift the currency. MAS manages the Singapore dollar's exchange rate band rather than an interest rate.</p>
<h2>Key releases (see the NEWS calendar)</h2>
<ul><li><b>US CPI</b> (inflation) and <b>PCE</b>: drive Fed expectations.</li><li><b>Non-farm payrolls</b>: US jobs, first Friday of the month, about 20:30/21:30 SGT.</li>
<li><b>FOMC</b> decisions: 8 times a year, around 02:00/03:00 SGT.</li><li><b>China PMI and GDP</b>: matter a lot for Asia, commodities and Malaysian exporters.</li>
<li><b>BNM MPC (OPR)</b> and <b>MAS policy statements</b>: local rates and currencies.</li></ul>
<h2>Cross-asset clues</h2>
<ul><li><b>US 10-year yield</b> rising fast is a headwind for valuations.</li><li><b>US dollar index (DXY)</b> strength usually weighs on Asian currencies and emerging markets.</li>
<li><b>Oil</b> up helps Malaysian oil and gas names and the ringgit, and hurts airlines and transport.</li><li><b>Gold</b> up often signals fear or falling real yields.</li>
<li><b>VIX</b> above 25 = stressed market: wider stops, smaller positions.</li><li><b>Copper</b> tracks global industrial demand ("Dr Copper").</li></ul>
<h2>Seasonality and flows</h2>
<p>Earnings seasons (US: mid-January, April, July and October), index rebalances, and window dressing at quarter end move prices independently of news. In Malaysia, foreign fund flows (reported weekly by MIDF Research) matter a lot for KLCI heavyweights.</p>` },

  { id: 'sg', t: '10 · Planning as a Singapore-based investor', lvl: 'Essential', html: `
<h2>Which broker for what</h2>
<ul><li><b>Bursa Malaysia</b>: Malacca Securities (M+ Online, low fees, CDS account) or UOB Kay Hian. Most Malaysian apps show the [S] Shariah flag.</li>
<li><b>SGX</b>: UOB Kay Hian (CDP-linked: shares in your name).</li><li><b>US and global</b>: moomoo (low fees, fractional shares, OpenAPI). US shares are held through a custodian.</li></ul>
<h2>Taxes (general, not tax advice)</h2>
<ul><li><b>Singapore</b>: no capital gains tax for individual investors (unless trading counts as a business); SGX dividends are tax-exempt (one-tier).</li>
<li><b>US dividends</b>: 30% withholding for Singapore and Malaysian residents (no tax treaty). File a <b>W-8BEN</b> with moomoo. Growth stocks with low dividends are more tax-efficient.</li>
<li><b>US estate tax</b>: non-US persons can owe US estate tax on US shares above US$60,000 at death. Many Singapore investors use Ireland-domiciled (UCITS) ETFs for big long-term US exposure. The Shariah ones (for example the iShares MSCI World/USA Islamic ETFs on the LSE) are on the market page.</li>
<li><b>Malaysia</b>: listed share gains are not taxed for individuals; dividends are single-tier. Malaysian tax residents pay 2% on dividends above RM100,000 a year (from 2025). Your residency decides what applies.</li></ul>
<h2>Currency</h2>
<p>You earn SGD and buy in MYR and USD. Convert in larger, less frequent amounts (fees and spreads add up), and know that currency moves can be bigger than the stock's.</p>
<h2>Time</h2>
<p>Asia trades during your working day; the US trades during your night. Prefer swing trades and alerts over late-night day trading for health and decision quality. The US open shifts one hour later on 1 Nov 2026 (US winter time).</p>
<h2>Islamic cash management</h2>
<p>Keep idle cash in Islamic accounts or Shariah money-market funds rather than interest-bearing broker cash. Check whether your broker pays interest on cash, and opt out or donate it.</p>` },

  { id: 'advanced', t: '11 · Advanced concepts', lvl: 'Advanced', html: `
<h2>Market structure</h2>
<p><b>Order book / Level 2</b>: queued bids and asks beyond the best price (moomoo shows it). <b>Liquidity</b> is how much you can trade without moving the price. <b>Market makers</b> provide quotes and earn the spread. <b>Dark pools</b> (US) match big orders off-exchange.</p>
<h2>Factor investing</h2>
<p>Long-run return drivers studied academically: <b>value</b> (cheap on fundamentals), <b>momentum</b> (recent winners keep winning for 3–12 months), <b>quality</b> (high ROE, stable earnings, low debt; it overlaps nicely with Shariah screens), <b>size</b> and <b>low volatility</b>. The IDEA tab's invest score blends trend, momentum, quality and value.</p>
<h2>Statistics you should know</h2>
<ul><li><b>Volatility</b>: standard deviation of returns, annualised by ×√252. A 2% daily volatility is about 32% a year.</li><li><b>Beta</b>: sensitivity to the market; beta 1.5 moves about 1.5× the index.</li>
<li><b>Drawdown</b>: peak-to-trough fall. A 50% loss needs a 100% gain to recover.</li><li><b>Sharpe ratio</b>: excess return per unit of volatility.</li>
<li><b>Base rates and overfitting</b>: a backtest that looks perfect usually is. That's why this site shows the forecast track record.</li><li><b>Expectancy</b>: win rate × average win − loss rate × average loss. Positive expectancy with small risk per trade is the whole game.</li></ul>
<h2>Earnings mechanics</h2>
<p>Price reacts to results versus <b>expectations</b> (consensus) and to <b>guidance</b>, not to the raw number. "Beat and raise" is the bullish combo. After a big earnings gap, stocks often drift in the gap's direction for weeks (post-earnings drift).</p>
<h2>Sukuk and Islamic structures</h2>
<p>Sukuk are asset-backed certificates (ijarah = lease, murabahah = cost-plus sale, musharakah = partnership) that pay profit rather than interest; the SPSK ETF on the market page holds them. Islamic REITs (Malaysia has several, such as Axis REIT, KLCC Stapled and Al-'Aqar) screen their tenants.</p>
<h2>Using AI well</h2>
<p>The reports here come from a large language model given only the day's data. It summarises well but can still invent numbers: the number check and the data appendix exist for that reason. Treat AI text as a smart summary to check, never as a signal on its own.</p>` },

  { id: 'small', t: '13a · Trading a small account (S$1,500)', lvl: 'Practical', html: `
<h2>The honest starting point</h2>
<p>With S$1,500, the goal for the first year is to <b>learn a repeatable process without losing the account</b>, not to get rich. Large studies of short-term traders are sobering: in Taiwan, fewer than 1% of day traders were predictably profitable year after year (Barber, Lee, Liu &amp; Odean), and in Brazil, 97% of people who day-traded futures for more than 300 days lost money (Chague, De-Losso &amp; Giovannetti, 2019). The traders who survive keep risk tiny, trade few setups, and keep costs low.</p>
<h2>Rule 1: fees decide where you can trade</h2>
<table><tr><th>Venue</th><th>Cost on a S$750 position, buy + sell</th><th>Verdict for quick trades</th></tr>
<tr><td>US stocks / Shariah ETFs via moomoo (US$0.99 per order, fractional shares)</td><td>≈ 0.35%</td><td><b>Best</b>: small, frequent trades are viable</td></tr>
<tr><td>Bursa via M+ Online (0.08%, min RM8, plus clearing and stamp duty)</td><td>≈ 0.9–1.0%</td><td>Only for swings aiming at 4%+ moves; avoid many small trades</td></tr>
<tr><td>SGX via moomoo SG (check the current rate card)</td><td>≈ 0.3–1.3%</td><td>Possible; confirm the minimum first</td></tr>
<tr><td>SGX via UOB Kay Hian cash account (min S$25 per side)</td><td>≈ 6.7%</td><td><b>Never</b> for short-term trades at this size; fine for long-term holdings</td></tr></table>
<p>The Small-account tab recalculates this live from your capital and broker, and shows which backtested setups still make money <i>after</i> those fees.</p>
<h2>Rule 2: size every trade from the stop</h2>
<ul><li>Risk 1–2% of capital per trade: S$15–30. Shares = risk ÷ (entry − stop).</li><li>At most 2 positions at a time (about S$750 each), so one bad day can't hurt much.</li>
<li>Set a daily or weekly stop: after 3 losses in a row, pause and review the journal.</li>
<li>Bursa and SGX trade in lots of 100 shares, so expensive stocks may not fit; US stocks allow fractions on moomoo.</li></ul>
<h2>The three setups (all long-only, cash account, Shariah C/P stocks)</h2>
<ol><li><b>RSI(2) dip in an uptrend</b>: from Larry Connors &amp; Cesar Alvarez, <i>Short Term Trading Strategies That Work</i> (2008). In stocks above their 200-day average, sharp 2-day pullbacks have tended to snap back within days. It has a high win rate but small average gains, which makes it very sensitive to fees. Best on US stocks and the US Shariah ETFs (SPUS, HLAL).</li>
<li><b>20-day breakout on volume</b>: momentum research (Jegadeesh &amp; Titman, 1993) and the 52-week-high effect (George &amp; Hwang, 2004). Fewer winners, but bigger ones. Wait for the close above the range on 1.5× volume.</li>
<li><b>Pullback to the rising 20-day EMA</b>: buy a dip in an established uptrend when the day closes green above the EMA. Stop under the 3-day low, target 2× the risk.</li></ol>
<p>Not offered: <b>opening-range breakout</b> day trading. A 2023 study (Zarattini, Barbon &amp; Aziz) found an edge on QQQ, but its headline results used leveraged ETFs (not Shariah-compliant), and it needs minute-by-minute data and screen time at 21:30–23:30 SGT. Study it on paper only.</p>
<h2>Rule 3: fit the clock</h2>
<p>US stocks trade 21:30–04:00 SGT (22:30–05:00 from 1 Nov 2026). Swing setups (1–10 days) suit a working life: read the 06:30 brief, place the entry, stop and target as orders, and check once in the evening. Don't stay up every night.</p>
<h2>Rule 4: cash, settlement and currency</h2>
<ul><li>Use a cash account (no margin interest; Shariah-friendly). US trades settle T+1, Bursa and SGX T+2: don't re-buy with money that hasn't settled yet, or the broker may restrict the account. Check moomoo SG's exact rule.</li>
<li>Convert SGD to USD once and keep a USD balance. Converting on every trade adds a hidden 0.2–0.5%.</li></ul>
<h2>Avoid</h2>
<ul><li>Penny stocks under RM0.20 / S$0.20: one tick can be 2–5% of the price, and they're easy to manipulate.</li><li>"Hot tips" from Telegram, WhatsApp or TikTok groups (classic pump-and-dump).</li>
<li>Averaging down on a losing quick trade, and revenge trading after a loss.</li><li>Leveraged or inverse ETFs, CFDs, options and margin: not Shariah-compliant, and they wipe out small accounts.</li></ul>
<h2>A 90-day path</h2>
<ol><li>Weeks 1–4: paper-trade only the setups marked "edge after fees", at least 20 trades, all journaled.</li>
<li>Weeks 5–8: if paper results are positive, trade real money at half size (0.75% risk).</li>
<li>Weeks 9–12: full size, still at most 2 positions. Add savings monthly rather than raising risk. 1–3% a month is an excellent result.</li></ol>` },

  { id: 'paper', t: '13 · Paper trading', lvl: 'Practice', html: `
<p>Paper trading means trading with virtual money at real market prices: the safest way to test a strategy or learn a new market. Each profile has its own account (default S$1,500 to match a small real account, base currency and fee adjustable in Settings).</p>
<h2>How orders work here</h2>
<ul><li><b>Market</b>: fills straight away at the latest price (a live quote when available, else the last close).</li>
<li><b>Limit buy / limit sell</b>: waits until a quote reaches your price or better.</li>
<li><b>Stop buy / stop sell</b>: waits until price breaks through your level, then fills there. A sell stop is your stop-loss.</li>
<li>Resting orders are checked whenever new prices arrive (about every 10 minutes, or every minute with the Worker). The server sends a push when one triggers, and it fills the next time you open the app.</li>
<li>Bursa and SGX orders must be in board lots of 100. There's no short selling or margin: you can only sell what you hold. With Shariah-only mode on, buying status-F stocks is blocked.</li>
<li>Prices from different markets are converted to your base currency at the latest FX rate, and a fee (default 0.1%) is charged per trade.</li></ul>
<h2>Using it well</h2>
<ol><li>Write the plan first (journal): setup, entry, stop, target.</li><li>Size with the position-size box on each stock page (1% risk).</li>
<li>Trade it for at least 20–30 trades before judging. A handful of trades tells you nothing.</li><li>Review the equity curve and history on Sundays with the weekly report.</li></ol>
<p class="note">Limits: no slippage model beyond the fill rules above, no partial fills, no dividends credited, and Bursa/SGX quotes lag about 15 minutes. Real fills will be worse; treat paper results as an upper bound.</p>` },

  { id: 'zoya', t: '14 · Zoya & other Shariah checkers', lvl: 'Shariah', html: `
<p><b>Zoya</b> (zoya.finance) is a halal-investing app that screens stocks with the <b>AAOIFI</b> methodology. For each stock it shows: (1) the business screen (what share of revenue comes from impermissible activities), (2) the financial screens (interest-bearing debt, cash and interest-bearing securities, and interest income against limits), (3) a <b>purification</b> amount per share for dividends, and (4) alerts when a stock's status changes. It covers the US in depth and a growing set of international listings. Some features need a subscription.</p>
<h2>How to use it with this site</h2>
<ol><li>Find candidates here (IDEA tab or screener).</li><li>On the stock page, tap <b>CHECK ON ZOYA</b> (it opens the stock directly for US tickers, or a search for others).</li>
<li>If our status is <span class="badge st-P">P</span> (passes our ratio screen but not certified), Zoya's revenue breakdown is the missing piece: our data feed can't see non-halal income.</li>
<li>Use Zoya's purification figure to calculate what to donate from each dividend.</li></ol>
<h2>Which source wins?</h2>
<table><tr><th>Market</th><th>Primary authority</th><th>Second opinion</th></tr>
<tr><td>Malaysia (Bursa)</td><td>SC Malaysia Shariah Advisory Council list (May/Nov)</td><td>Zoya, Musaffa, HalalScreener</td></tr>
<tr><td>US</td><td>S&amp;P 500 Shariah / Dow Jones Islamic indices (via SPUS/HLAL holdings)</td><td>Zoya, Musaffa</td></tr>
<tr><td>Singapore</td><td>No official list. MSCI/FTSE Shariah index membership where available</td><td>Zoya, Musaffa, and our screen</td></tr></table>
<p>Methodologies differ (30% vs 33% limits, market cap vs total assets), so a stock can pass one and fail another. Pick one standard and stay consistent; if unsure, ask a scholar you trust.</p>
<p class="note">Note: you wrote "ZORA"; we've assumed you meant Zoya, the Shariah stock-screening app. If you meant a different service, tell us and the links will be switched.</p>` },

  { id: 'hosting', t: '15 · Hosting, encryption & privacy', lvl: 'Setup', html: `
<h2>How your data is protected</h2>
<ul><li>The family password is turned into a 256-bit key with PBKDF2-SHA256 (310,000 rounds). Every file (market data, reports, profiles, watchlists, notes, paper trades, the sync token) is encrypted with AES-256-GCM before it leaves the GitHub server or your device. GitHub only ever stores ciphertext.</li>
<li>The repository is public (free GitHub Pages needs that), so <b>anyone can download the encrypted files and try passwords offline</b>. The password is the only real protection. If it is short or guessable (for example your username), switch to a long passphrase (4+ random words) with <code>local/rotate_password.py</code> (see the README).</li>
<li>Profile PINs are a lock on the door, not a safe: anyone with the family password could read every profile. That's fine for a family; it isn't for strangers.</li>
<li>The GitHub token is fine-grained to this one repository and stored encrypted. Revoke it on GitHub any time; the site keeps working read-only.</li>
<li>"Remember on this device" stores the derived key in the browser. Use "Lock this device" in Settings on shared computers.</li></ul>
<h2>GitHub Pages vs Cloudflare: is Cloudflare better?</h2>
<table><tr><th></th><th>Now: GitHub Pages + Actions</th><th>Cloudflare Pages + Worker + KV + Access</th></tr>
<tr><td>Cost</td><td>Free</td><td>Free tier (Workers 100k requests/day, Cron Triggers, KV)</td></tr>
<tr><td>Privacy</td><td>Public repo; encrypted files downloadable; password is the only lock</td><td><b>Better</b>: Cloudflare Access puts a real login (one-time email codes to family emails) in front of the site and data; nothing is public</td></tr>
<tr><td>Live prices</td><td>~10 min (GitHub's scheduler can add a few minutes)</td><td><b>Better</b>: 1-minute quotes and headlines via a Worker</td></tr>
<tr><td>Heavy analysis (1,650 stocks, pandas, AI reports)</td><td><b>Better</b>: Actions runs full Python for free</td><td>Workers can't run pandas; you'd keep GitHub Actions for this anyway</td></tr>
<tr><td>Saving family data</td><td>Needs a GitHub token (set once)</td><td>Worker + KV/D1 directly; no token</td></tr>
<tr><td>Setup effort</td><td>Done</td><td>A Cloudflare account (on your approved email), deploy the Worker, optionally move Pages and add Access</td></tr></table>
<p><b>Recommendation:</b> a hybrid. Keep GitHub for the analysis pipeline, and add the free Cloudflare Worker in <code>worker/</code> for 1-minute live prices and headlines (paste its URL and key in Settings → Family). If you want the site itself to be private rather than password-encrypted, also move the static site to Cloudflare Pages behind Cloudflare Access. That's the strongest privacy option, and worth doing before sharing beyond the family.</p>` },
  { id: 'moomoo', t: '16 · moomoo OpenAPI (live data from your account)', lvl: 'Setup', html: `
<p>moomoo's <b>OpenAPI</b> lets programs read quotes, your watchlists and (optionally) positions through <b>OpenD</b>, a small gateway app that runs on your own computer and logs in with your moomoo ID (your account is under aisymikhailaznan@gmail.com). A website can't talk to OpenD directly (it's on your machine, and your login must never be on a public server), so this project ships a <b>bridge script</b> that reads from OpenD and publishes an encrypted snapshot the site shows on the WL tab.</p>
<h2>Set up (about 10 minutes, once)</h2>
<ol><li>Download <b>OpenD</b> from moomoo's OpenAPI page (openapi.moomoo.com → Download) and log in with your moomoo ID. Turn on two-factor authentication on the account if you haven't already.</li>
<li>In a terminal: <code>cd ~/Project_Pipeline/011_ama-stock-screener</code>, then run <code>local/moomoo_bridge.py --once</code> using the project's Python (see the README).</li>
<li>Your moomoo watchlist groups and live snapshot quotes appear on the WL tab, with an "Add all to watchlist" button.</li>
<li>Optional: <code>--positions</code> also publishes your holdings (read-only; the script never unlocks trading). <code>--every 60</code> keeps it refreshing while the Mac is awake.</li></ol>
<h2>What you get and the limits</h2>
<ul><li>Quote rights depend on your account and region. US Level 1 quotes are typically included for moomoo users; Singapore and other markets may need a quote card. The bridge skips anything you don't have rights to.</li>
<li>The OpenAPI also allows trading. This project deliberately doesn't trade: no trade unlock code is ever requested.</li>
<li>UOB Kay Hian and Malacca Securities don't offer a retail API, so for Bursa and SGX this site uses delayed Yahoo data; use their apps for live order books.</li></ul>` },
];

// ---------------------------------------------------------------- glossary
// l: B basic, I intermediate, A advanced, S Shariah/Islamic finance
export const GLOSSARY = [
  ['Ask (offer)', 'B', 'The lowest price a seller is currently willing to accept.'],
  ['Bid', 'B', 'The highest price a buyer is currently willing to pay.'],
  ['Spread', 'B', 'Ask minus bid. A hidden cost every time you trade; wide in illiquid stocks.'],
  ['Board lot', 'B', 'Minimum trading unit. 100 shares on Bursa and SGX, 1 share in the US.'],
  ['Bull market', 'B', 'A sustained rise, often defined as +20% from a low.'],
  ['Bear market', 'B', 'A sustained fall, often defined as −20% from a high.'],
  ['Correction', 'B', 'A fall of 10–20% from a recent high.'],
  ['Market capitalisation', 'B', 'Share price × shares outstanding: what the market values the whole company at.'],
  ['Large / mid / small cap', 'B', 'Size buckets by market cap. Smaller = usually more volatile and less liquid.'],
  ['Penny stock', 'B', 'A very low-priced share (below RM1 or S$0.20). Big tick sizes and easy to manipulate.'],
  ['Blue chip', 'B', 'A large, established, financially sound company, such as a KLCI or STI constituent.'],
  ['Dividend', 'B', 'Cash paid to shareholders from profits.'],
  ['Ex-dividend date', 'B', 'Buy before this date to receive the next dividend; the price usually drops by the dividend on the day.'],
  ['Dividend yield', 'B', 'Annual dividend ÷ share price.'],
  ['Earnings per share (EPS)', 'B', 'Net profit ÷ shares outstanding.'],
  ['P/E ratio', 'B', 'Price ÷ EPS. How many years of current profit the market is paying for.'],
  ['Index', 'B', 'A basket of stocks tracked as one number (KLCI, STI, S&P 500).'],
  ['ETF', 'B', 'Exchange-traded fund: a basket of assets that trades like one share. Shariah ETFs include SPUS, HLAL and UMMA.'],
  ['REIT', 'B', 'Real estate investment trust: owns income-producing property and pays most income as distributions.'],
  ['IPO', 'B', 'Initial public offering: a company\'s first sale of shares to the public.'],
  ['Limit order', 'B', 'Buy or sell only at your price or better.'],
  ['Market order', 'B', 'Buy or sell immediately at the best available price.'],
  ['Stop-loss', 'B', 'An order that exits a position once price hits a set level, to cap losses.'],
  ['Take-profit', 'B', 'An order that exits a position once price reaches your target.'],
  ['Volume', 'B', 'Number of shares traded in a period.'],
  ['Liquidity', 'B', 'How easily you can buy or sell without moving the price.'],
  ['Volatility', 'B', 'How much a price swings. Measured by standard deviation or ATR.'],
  ['Portfolio', 'B', 'Everything you hold.'],
  ['Diversification', 'B', 'Spreading money across stocks, sectors and markets to reduce single-name risk.'],
  ['Broker', 'B', 'The firm that executes your trades (moomoo, UOB Kay Hian, Malacca Securities).'],
  ['CDS account', 'B', 'Central Depository System account: where your Bursa shares are recorded.'],
  ['CDP account', 'B', 'Central Depository (Singapore) account: holds SGX shares in your own name.'],
  ['Custodian / nominee', 'B', 'An institution holding shares on your behalf (how moomoo holds US shares).'],
  ['Settlement (T+1, T+2)', 'B', 'Days after the trade when cash and shares actually change hands. US T+1, Bursa and SGX T+2.'],
  ['Pre-market / after-hours', 'B', 'US trading outside 9:30–16:00 ET. Thinner liquidity, wider spreads.'],
  ['Gap up / gap down', 'B', 'Opening above the previous high or below the previous low, often on news.'],
  ['Candlestick', 'B', 'A chart bar showing open, high, low and close for a period.'],
  ['OHLC', 'B', 'Open, high, low, close.'],
  ['Wick (shadow)', 'B', 'The thin line of a candle showing the high and low beyond the body.'],
  ['Support', 'B', 'A price area where buying has repeatedly stopped declines.'],
  ['Resistance', 'B', 'A price area where selling has repeatedly capped rallies.'],
  ['Trend', 'B', 'The general direction: higher highs and lows (up) or lower highs and lows (down).'],
  ['Watchlist', 'B', 'Stocks you are studying but don\'t necessarily own.'],
  ['Annual report', 'B', 'The company\'s yearly report: business review, financial statements and risks. Read it before investing.'],
  ['Moving average (SMA / EMA)', 'I', 'Average price over N periods; EMA weights recent prices more. Smooths noise to show the trend.'],
  ['Golden cross', 'I', 'The 50-day MA crosses above the 200-day MA: long-term bullish regime.'],
  ['Death cross', 'I', 'The 50-day MA crosses below the 200-day MA: long-term bearish regime.'],
  ['RSI', 'I', 'Relative Strength Index (0–100). Above 70 overbought, below 30 oversold.'],
  ['MACD', 'I', '12-EMA minus 26-EMA, with a 9-EMA signal line. Momentum and trend-change tool.'],
  ['Bollinger Bands', 'I', '20-period MA ± 2 standard deviations. Squeezes come before big moves.'],
  ['ATR (Average True Range)', 'I', 'Average daily range including gaps. Used to size stops and positions.'],
  ['VWAP', 'I', 'Volume-weighted average price of the day; an intraday fair-value line.'],
  ['Relative volume (RVOL)', 'I', 'Today\'s volume ÷ average volume. Above 1.5× means the stock is "in play".'],
  ['Breakout', 'I', 'Price moving through resistance (or below support), ideally on strong volume.'],
  ['False breakout (fakeout)', 'I', 'A breakout that quickly reverses back into the range.'],
  ['Pullback', 'I', 'A temporary move against the main trend; a common entry in trends.'],
  ['Consolidation', 'I', 'Sideways price action as buyers and sellers balance.'],
  ['Divergence', 'I', 'Price and an indicator (such as RSI) moving in opposite directions: momentum warning.'],
  ['Overbought / oversold', 'I', 'Price has moved far and fast; can persist in strong trends.'],
  ['Fibonacci retracement', 'I', 'Pullback levels at 38.2%, 50% and 61.8% of a prior move.'],
  ['Head and shoulders', 'I', 'A three-peak reversal pattern; the neckline break confirms it.'],
  ['Double top / bottom', 'I', 'Two failed tests of the same high (M) or low (W).'],
  ['Cup and handle', 'I', 'A rounded base plus a small pullback before a breakout.'],
  ['Flag / pennant', 'I', 'A brief pause after a sharp move, usually continuing it.'],
  ['Engulfing pattern', 'I', 'A candle body completely covering the previous one: reversal signal.'],
  ['Doji', 'I', 'A candle with almost equal open and close: indecision.'],
  ['Hammer', 'I', 'A small body with a long lower wick after a fall: possible bottom.'],
  ['Shooting star', 'I', 'A small body with a long upper wick after a rise: possible top.'],
  ['Risk-reward ratio', 'I', 'Potential gain ÷ potential loss of a trade. Aim for 2:1 or better.'],
  ['Position sizing', 'I', 'Deciding how many shares to buy so a stop-out costs a fixed % of the account.'],
  ['R-multiple', 'I', 'Profit or loss measured in units of initial risk (1R = what you risked).'],
  ['Drawdown', 'I', 'Peak-to-trough fall in an account or price.'],
  ['Slippage', 'I', 'The difference between expected and actual fill price.'],
  ['Day trading', 'I', 'Opening and closing positions within the same session.'],
  ['Swing trading', 'I', 'Holding positions for days to weeks to catch one "swing".'],
  ['Scalping', 'I', 'Very short trades for tiny gains; needs tight spreads and low fees.'],
  ['Revenue', 'I', 'Total sales before any costs (the "top line").'],
  ['Net profit', 'I', 'What\'s left after all costs, interest and tax (the "bottom line").'],
  ['Gross margin', 'I', '(Revenue − cost of goods sold) ÷ revenue.'],
  ['Operating margin', 'I', 'Operating profit ÷ revenue: efficiency of the core business.'],
  ['Free cash flow (FCF)', 'I', 'Operating cash flow − capital expenditure: cash the business really generates.'],
  ['ROE', 'I', 'Return on equity: net profit ÷ shareholders\' equity.'],
  ['ROA', 'I', 'Return on assets: net profit ÷ total assets.'],
  ['P/B ratio', 'I', 'Price ÷ book value per share.'],
  ['PEG ratio', 'I', 'P/E ÷ earnings growth rate.'],
  ['Forward P/E', 'I', 'Price ÷ expected next-year EPS.'],
  ['EV / EBITDA', 'I', 'Enterprise value ÷ earnings before interest, tax, depreciation and amortisation. Valuation that includes debt.'],
  ['Book value', 'I', 'Assets minus liabilities: accounting net worth.'],
  ['Payout ratio', 'I', 'Dividends ÷ earnings. Above 100% for long isn\'t sustainable.'],
  ['Guidance', 'I', 'Management\'s forecast of future results; often moves price more than the actual results.'],
  ['Consensus estimate', 'I', 'The average analyst forecast for a company\'s results.'],
  ['Earnings beat / miss', 'I', 'Results above or below consensus.'],
  ['Rights issue', 'I', 'New shares offered to existing holders, usually at a discount; dilutive.'],
  ['Bonus issue / split', 'I', 'More shares at a proportionally lower price; total value is unchanged.'],
  ['Warrant', 'I', 'A right to buy new shares at a fixed price before expiry. Check its Shariah status separately.'],
  ['Free float', 'I', 'Shares available for public trading (excludes locked-up insider holdings).'],
  ['Sector rotation', 'I', 'Money shifting between sectors as the economic cycle changes.'],
  ['Defensive stock', 'I', 'A business with stable demand in downturns (utilities, staples, healthcare).'],
  ['Cyclical stock', 'I', 'A business that rises and falls with the economy (autos, materials, energy).'],
  ['Beta', 'I', 'Sensitivity to the overall market. Beta 1 moves with it, above 1 more, below 1 less.'],
  ['Fed (FOMC)', 'I', 'The US Federal Reserve committee that sets US interest rates; its decisions move global markets.'],
  ['OPR', 'I', 'Overnight Policy Rate: Bank Negara Malaysia\'s policy interest rate.'],
  ['MAS policy', 'I', 'The Monetary Authority of Singapore manages the SGD exchange-rate band (S$NEER) instead of an interest rate.'],
  ['CPI', 'I', 'Consumer Price Index: the main inflation measure.'],
  ['Non-farm payrolls (NFP)', 'I', 'Monthly US jobs report; a big market mover.'],
  ['PMI', 'I', 'Purchasing Managers\' Index. Above 50 = expansion, below 50 = contraction.'],
  ['Bond yield', 'I', 'The return on a bond; the US 10-year yield is the world\'s benchmark rate.'],
  ['DXY', 'I', 'US dollar index against major currencies.'],
  ['VIX', 'I', 'Expected S&P 500 volatility, the "fear gauge". Above 25–30 = stress.'],
  ['Risk-on / risk-off', 'I', 'Markets favouring growth and risk assets vs. safe havens.'],
  ['Foreign fund flow', 'I', 'Net buying or selling by foreign investors; a key driver of the KLCI.'],
  ['Window dressing', 'I', 'Fund managers buying winners near quarter or year end to polish reports.'],
  ['Short squeeze', 'A', 'Short sellers forced to buy back, driving price up violently. (Short selling itself is not Shariah-compliant.)'],
  ['Order book / Level 2', 'A', 'The list of queued bids and asks at each price.'],
  ['Market maker', 'A', 'A firm that continuously quotes bid and ask prices, earning the spread.'],
  ['Dark pool', 'A', 'A private venue for matching large orders without displaying them.'],
  ['Opening range breakout (ORB)', 'A', 'A trade on a break of the first 15–30 minutes\' high or low.'],
  ['Mean reversion', 'A', 'The tendency of stretched prices to move back toward an average.'],
  ['Momentum factor', 'A', 'Recent 3–12 month winners tend to keep outperforming for a while.'],
  ['Value factor', 'A', 'Cheap stocks on fundamentals have historically outperformed over long periods.'],
  ['Quality factor', 'A', 'High-ROE, low-debt, stable-earnings companies; overlaps with Shariah screens.'],
  ['Sharpe ratio', 'A', '(Return − risk-free rate) ÷ volatility. Return per unit of risk.'],
  ['Sortino ratio', 'A', 'Like Sharpe but only penalises downside volatility.'],
  ['Expectancy', 'A', 'Average profit per trade: win% × average win − loss% × average loss.'],
  ['Kelly criterion', 'A', 'A formula for the bet size that maximises growth; most traders use a fraction of it.'],
  ['Overfitting', 'A', 'A model tuned to past noise that fails on new data.'],
  ['Backtest', 'A', 'Testing a strategy on historical data.'],
  ['Survivorship bias', 'A', 'Studying only the companies that survived, which flatters results.'],
  ['Base rate', 'A', 'How often something happened historically in similar situations: the basis of this site\'s probabilities.'],
  ['Standard deviation (σ)', 'A', 'The typical size of moves around the average. About 68% of outcomes fall within ±1σ.'],
  ['Annualised volatility', 'A', 'Daily σ × √252.'],
  ['Correlation', 'A', 'How closely two assets move together (−1 to +1).'],
  ['DCF (discounted cash flow)', 'A', 'Valuing a business as the present value of its future free cash flows.'],
  ['WACC', 'A', 'Weighted average cost of capital: the discount rate in a DCF.'],
  ['Terminal value', 'A', 'The value of all cash flows beyond the forecast period in a DCF; often most of the total.'],
  ['Moat', 'A', 'A durable competitive advantage (brand, network effects, cost, switching costs).'],
  ['Post-earnings drift', 'A', 'The tendency to keep moving in the direction of an earnings surprise for weeks.'],
  ['Index rebalancing', 'A', 'Forced buying or selling when stocks join or leave an index (including Shariah indices).'],
  ['Contra trading', 'A', 'Buying and selling within the settlement period without paying (common on Bursa). Brokers restrict it and it raises Shariah concerns.'],
  ['Pattern day trader (PDT)', 'A', 'A US rule for margin accounts making 4+ day trades in 5 days; requires US$25k. Doesn\'t apply to cash accounts.'],
  ['W-8BEN', 'A', 'US tax form for non-US persons; sets the dividend withholding rate (30% for SG and MY residents).'],
  ['US estate tax (non-residents)', 'A', 'Can apply to US-situs assets above US$60,000 for non-US persons. A reason to consider Ireland-domiciled ETFs.'],
  ['UCITS ETF', 'A', 'An EU-regulated fund format (often Ireland-domiciled) with better dividend and estate-tax treatment for Asian investors.'],
  ['Shariah-compliant', 'S', 'Meets Islamic rules on business activity and finance (limited interest and debt).'],
  ['Riba', 'S', 'Interest or usury; prohibited. The core reason for the financial ratio screens.'],
  ['Gharar', 'S', 'Excessive uncertainty or ambiguity in a contract; a reason most derivatives are excluded.'],
  ['Maysir', 'S', 'Gambling or speculation for chance gain; prohibited.'],
  ['Halal / haram', 'S', 'Permissible / forbidden.'],
  ['Shariah Advisory Council (SAC)', 'S', 'The Securities Commission Malaysia\'s Shariah board; publishes the official list of compliant Bursa securities twice a year.'],
  ['AAOIFI', 'S', 'Accounting and Auditing Organization for Islamic Financial Institutions; sets widely used Shariah standards (No. 21 for shares, No. 57 for gold).'],
  ['Business activity benchmark', 'S', 'The maximum share of income from non-compliant activities (5% or 20% under the SC; 5% under AAOIFI and MSCI).'],
  ['Financial ratio benchmark', 'S', 'Limits on interest-bearing debt and cash relative to total assets or market cap (33% SC, 30% AAOIFI).'],
  ['Purification (tathir)', 'S', 'Donating the non-halal share of dividends (or gains) to charity.'],
  ['Zakat', 'S', 'Obligatory alms: 2.5% on qualifying wealth held for a lunar year (haul), including shares.'],
  ['Haul', 'S', 'One lunar year of holding, after which zakat is due.'],
  ['Baitulmal', 'S', 'Islamic treasury; where non-halal gains can be channelled.'],
  ['Musharakah', 'S', 'A profit-and-loss-sharing partnership. Shareholding is a form of it.'],
  ['Mudarabah', 'S', 'A partnership where one side provides capital and the other expertise.'],
  ['Murabahah', 'S', 'A cost-plus-profit sale; common in Islamic financing.'],
  ['Ijarah', 'S', 'A lease contract; a common sukuk structure.'],
  ['Tawarruq', 'S', 'A commodity-based financing structure used by some Islamic margin and deposit products. Some scholars disapprove.'],
  ['Sukuk', 'S', 'Islamic certificates backed by assets, paying profit instead of interest.'],
  ['Islamic REIT', 'S', 'A REIT whose tenants and financing pass Shariah screens (for example Axis REIT, Al-\'Aqar, KLCC Stapled).'],
  ['Shariah index', 'S', 'An index of compliant stocks (FBM Emas Shariah, S&P 500 Shariah, Dow Jones Islamic Market, MSCI Islamic).'],
  ['Qabd (possession)', 'S', 'Taking possession before reselling; actual or constructive. Relevant to day trading and gold.'],
  ['Spot (hand-to-hand)', 'S', 'Immediate exchange; required when trading gold, silver and currencies.'],
  ['Fatwa', 'S', 'A formal ruling by a qualified scholar. A screen result is not a fatwa.'],
].map(([t, l, d]) => ({ t, l, d }));

// ---------------------------------------------------------------- resources
export const RESOURCES = {
  news: [
    ['The Edge Malaysia', 'https://theedgemalaysia.com/categories/corporate', 'Malaysian corporate and market news'],
    ['The Star Business', 'https://www.thestar.com.my/business', 'Malaysia business'],
    ['Bursa company announcements', 'https://www.bursamalaysia.com/market_information/announcements/company_announcement', 'Results, filings, corporate actions'],
    ['The Business Times', 'https://www.businesstimes.com.sg/companies-markets', 'Singapore companies and markets'],
    ['CNA Business', 'https://www.channelnewsasia.com/business', 'Asia business news'],
    ['SGX announcements', 'https://www.sgx.com/securities/company-announcements', 'Singapore filings'],
    ['Reuters Markets', 'https://www.reuters.com/markets/', 'Global markets'],
    ['CNBC Markets', 'https://www.cnbc.com/markets/', 'US markets'],
    ['Yahoo Finance', 'https://finance.yahoo.com/', 'Quotes and news'],
    ['Investing.com economic calendar', 'https://www.investing.com/economic-calendar/', 'All countries, including MY and SG'],
    ['Bank Negara Malaysia', 'https://www.bnm.gov.my/monetary-stability', 'OPR decisions'],
    ['Monetary Authority of Singapore', 'https://www.mas.gov.sg/monetary-policy', 'Policy statements'],
    ['US Federal Reserve FOMC calendar', 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', 'Meeting dates'],
    ['SC Malaysia Shariah list', 'https://www.sc.com.my/development/icm/icm-publications/list-of-shariah-compliant-securities', 'Official compliant Bursa securities'],
    ['Musaffa', 'https://musaffa.com/', 'Shariah screening, US and global'],
    ['Zoya', 'https://zoya.finance/', 'Shariah screening and purification, US'],
    ['UOB Kay Hian research', 'https://www.utrade.com.sg/', 'Research reports for clients'],
    ['Malacca Securities M+ Online', 'https://www.mplusonline.com/', 'Bursa broker, research and Shariah flag'],
    ['moomoo news', 'https://www.moomoo.com/news/', 'News feed and community'],
    ['TradingView', 'https://www.tradingview.com/', 'Charts and ideas'],
  ],
  study: [
    ['Candlestick basics (Rayner Teo)', 'Rayner Teo candlestick patterns trading guide', 'A Singapore-based trader with clear price-action lessons. Start here for the EDU candles chapter.'],
    ['Support and resistance properly', 'Rayner Teo support and resistance', 'The single most useful chart skill.'],
    ['Position sizing and risk', 'position sizing explained trading risk management 1 percent rule', 'Stops and sizing matter more than entries.'],
    ['How to read an annual report', 'how to read an annual report for beginners investing', 'Fundamental basics.'],
    ['Valuation (Damodaran)', 'Aswath Damodaran valuation class intrinsic value', 'The best free valuation teaching anywhere.'],
    ['Shariah stock screening explained', 'Islamic Finance Guru how to check if a stock is halal', 'How screens work and their limits.'],
    ['Purifying dividends', 'how to purify dividends halal investing', 'The practical step most people skip.'],
    ['Is day trading halal?', 'is day trading halal scholars', 'Hear the scholarly views directly.'],
    ['Reading the economic calendar', 'how CPI and FOMC affect stock market explained', 'Why stocks jump on data days.'],
    ['Bursa Malaysia for beginners', 'how to invest in Bursa Malaysia beginners', 'Local market mechanics.'],
    ['US estate tax for Singapore investors', 'US estate tax Singapore investors Ireland domiciled ETF', 'An overlooked risk for Asia-based investors.'],
    ['VWAP and opening range (intraday)', 'VWAP opening range breakout strategy explained', 'If you do day trade, learn these first.'],
  ],
  channels: [
    ['StockedUp (YouTube)', 'https://www.youtube.com/@StockedUp', 'Market stories; the video you shared'],
    ['Rayner Teo (YouTube)', 'https://www.youtube.com/@RaynerTeo', 'Price action and trading process (Singapore)'],
    ['The Plain Bagel (YouTube)', 'https://www.youtube.com/@ThePlainBagel', 'Clear, hype-free finance explainers'],
    ['Ben Felix (YouTube)', 'https://www.youtube.com/@BenFelixCSI', 'Evidence-based investing'],
    ['Aswath Damodaran (YouTube)', 'https://www.youtube.com/@AswathDamodaranonValuation', 'Valuation masterclasses'],
    ['Patrick Boyle (YouTube)', 'https://www.youtube.com/@PBoyle', 'Markets with a sceptical eye'],
    ['Islamic Finance Guru (YouTube)', 'https://www.youtube.com/@ifgofficial', 'Halal investing'],
    ['Zoya (YouTube)', 'https://www.youtube.com/@ZoyaFinance', 'Shariah screening explainers'],
    ['Odd Lots (podcast)', 'https://podcasts.apple.com/us/podcast/odd-lots/id1056200096', 'Bloomberg: how markets really work'],
    ['Thoughts on the Market (podcast)', 'https://podcasts.apple.com/us/podcast/thoughts-on-the-market/id1466686717', 'Morgan Stanley, short daily'],
    ['BFM Market Watch (podcast)', 'https://podcasts.apple.com/us/podcast/market-watch/id868001881', 'Malaysia market wrap'],
    ['The Business Times Podcasts', 'https://podcasts.apple.com/us/podcast/the-business-times-podcasts/id1565901403', 'Singapore markets'],
    ['IslamicFinanceGuru Podcasts', 'https://podcasts.apple.com/us/podcast/islamicfinanceguru-podcasts/id1447775029', 'Halal investing conversations'],
    ['Animal Spirits (podcast)', 'https://podcasts.apple.com/us/podcast/animal-spirits-podcast/id1310192007', 'Markets and behaviour'],
  ],
};
