/* Gemeinsame Helfer für die Server-Funktionen von «Startgespräch UH».
   Umgebungsvariablen (in Vercel eintragen):
   APP_CODE  Zugangscode für die Anmeldung
   SB_KEY    service_role-Schlüssel der Supabase «Besprechungstermin»
   VK_KEY    service_role-Schlüssel der Supabase «VerkaufUH» (nur Lesen der gewonnenen Aufträge)
   optional: SB_URL, VK_URL, GO_LIVE (ab welchem Datum Aufträge übernommen werden), SESSION_SECRET */
const crypto = require('crypto');
const E = process.env;
const SB_URL = E.SB_URL || 'https://cxgejioegnxqpukavqzh.supabase.co';
const VK_URL = E.VK_URL || 'https://mnbgjcijwrfenvcmwsxa.supabase.co';
const SECRET = () => E.SESSION_SECRET || crypto.createHash('sha256').update('sg|' + (E.SB_KEY || '') + '|' + (E.APP_CODE || '')).digest('hex');

function makeToken(days = 30) {
  const exp = Date.now() + days * 864e5, p = String(exp);
  return { token: p + '.' + crypto.createHmac('sha256', SECRET()).update(p).digest('hex'), exp };
}
function okToken(req) {
  const h = String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), [p, s] = h.split('.');
  if (!p || !s || +p < Date.now()) return false;
  const want = crypto.createHmac('sha256', SECRET()).update(p).digest('hex');
  return s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want));
}
async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  let raw = ''; for await (const c of req) raw += c; try { return JSON.parse(raw || '{}'); } catch (e) { return {}; }
}
/* PostgREST-Aufruf */
async function rest(base, key, path, opt = {}) {
  if (!key) throw new Error('Server ist noch nicht eingerichtet (Schlüssel fehlt)');
  const r = await fetch(base + '/rest/v1/' + path, { method: opt.method || 'GET', headers: Object.assign({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, opt.headers || {}), body: opt.body ? JSON.stringify(opt.body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error('Datenbank ' + r.status + ': ' + t.slice(0, 300));
  return t ? JSON.parse(t) : null;
}
const db = (path, opt) => rest(SB_URL, E.SB_KEY, path, opt);
const vk = (path, opt) => rest(VK_URL, E.VK_KEY, path, opt);
module.exports = { E, makeToken, okToken, body, db, vk };
