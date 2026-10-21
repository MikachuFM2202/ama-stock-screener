// Sends the Web Push messages that build.py queued in push.json: node scripts/push.mjs push.json
import fs from 'node:fs';
import webpush from 'web-push';

const PUBLIC = 'BJIdRX6WvAnQGUXn8UX-ZnLxmmNiqxw_J3zZd7H_K_KiIpYUwvT9LIdvtIilKX2a07QkkajLu1mJ1YbeNPmiMPQ';
const { subs = [], msgs = [] } = JSON.parse(fs.readFileSync(process.argv[2] || 'push.json', 'utf8'));
webpush.setVapidDetails(`https://github.com/${process.env.GITHUB_REPOSITORY || 'MikachuFM2202/stocks-tracker'}`, PUBLIC, process.env.VAPID_PRIVATE);
let ok = 0, fail = 0;
for (const m of msgs) for (const s of subs) {
  try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(m), { TTL: 86400, urgency: 'normal' }); ok++; }
  catch (e) { fail++; console.log(`push failed (${e.statusCode || e.message}) for ${s.dev || s.endpoint.slice(0, 40)}${e.statusCode === 410 ? ': subscription expired, re-enable on that device' : ''}`); }
}
console.log(`sent ${ok}, failed ${fail}, messages ${msgs.length}, devices ${subs.length}`);
