/* Aktionen aus dem Startgespräch wirklich ausführen.
   POST /api/aktion { art: 'abschluss' | 'pdf' | 'vakanz', id, x?, name?, rest?, von? }
   Ablauf: Gespräch aus der Supabase «Besprechungstermin» laden → Auftrag in der Verkaufstool-Datenbank (bt_jobs) anlegen
   → Verkaufstool führt ihn aus (Mails, PDFs auf Logopapier, Beekeeper, Stellenportal) → Ergebnis jedes Schritts zurück.
   Zusätzlich bei «abschluss»: Richtmengen, Selbstbesorgung und Hauptlager an «Materialbestellungen UH» (wenn MB_KEY gesetzt). */
const crypto = require('crypto');
const { E, okToken, body, db, vk } = require('./_lib');
const VK_APP = () => String(E.VK_APP || 'https://offertplattform-uh.vercel.app').replace(/\/+$/, '');
const MB_URL = () => E.MB_URL || 'https://yjnkaeplhxcsubwqpqkz.supabase.co';
const enc = encodeURIComponent;

async function mb(path, opt = {}) {
  const r = await fetch(MB_URL() + '/rest/v1/' + path, { method: opt.method || 'GET', headers: Object.assign({ apikey: E.MB_KEY, Authorization: 'Bearer ' + E.MB_KEY, 'Content-Type': 'application/json' }, opt.headers || {}), body: opt.body ? JSON.stringify(opt.body) : undefined });
  const t = await r.text(); if (!r.ok) throw new Error('Materialbestellungen ' + r.status + ': ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}
/* Materialbestellungen UH: Objekt muss dort bereits existieren (kommt aus der Objektliste) */
async function material(g, x) {
  const P = g.prot || {}, nr = String(g.objNr || '').trim(), out = [];
  const mat = (x.mat || []).filter(m => m && m.id && +m.m > 0), kunde = P.material === 'Kunde', lager = P.lieferung === 'Clean Service Hauptlager';
  if (!mat.length && !kunde && !lager) return out;
  if (!E.MB_KEY) return [{ k: 'material', ok: false, t: 'Materialbestellungen UH: Verbindung noch nicht eingerichtet (MB_KEY fehlt), bitte manuell erfassen' }];
  if (!nr || nr === '0000') return [{ k: 'material', ok: false, t: 'Materialbestellungen UH: keine gültige Objektnummer, nichts übertragen' }];
  try {
    const ob = await mb(`kunden_objekte?select=objektnummer,selbstbesorgung,hauptlager&objektnummer=eq.${enc(nr)}`);
    if (!ob.length) return [{ k: 'material', ok: false, t: `Materialbestellungen UH: Objekt ${nr} ist dort noch nicht erfasst, Richtmengen bitte nach dem Import erneut senden` }];
    const ch = {};
    if (kunde && (x.vm || []).length) ch.selbstbesorgung = [...new Set([].concat(ob[0].selbstbesorgung || [], x.vm))];
    if (lager && !ob[0].hauptlager) ch.hauptlager = true;
    if (Object.keys(ch).length) await mb(`kunden_objekte?objektnummer=eq.${enc(nr)}`, { method: 'PATCH', body: ch, headers: { Prefer: 'return=minimal' } });
    if (mat.length) await mb('uh_referenz?on_conflict=objektnummer,artikel_code', { method: 'POST', body: mat.map(m => ({ objektnummer: nr, artikel_code: m.id, geb_monat: +m.m })), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
    out.push({ k: 'material', ok: true, t: 'Materialbestellungen UH: ' + [mat.length && mat.length + ' Richtmengen', ch.selbstbesorgung && 'Selbstbesorgung', ch.hauptlager && 'Hauptlager'].filter(Boolean).join(', ') + ' übertragen' });
  } catch (e) { out.push({ k: 'material', ok: false, t: e.message }); }
  return out;
}

async function job(art, payload) {
  if (!E.VK_KEY) throw new Error('Verbindung zum Verkaufstool fehlt (VK_KEY)');
  const id = crypto.randomBytes(16).toString('hex');
  await vk('bt_jobs', { method: 'POST', body: { id, art, payload }, headers: { Prefer: 'return=minimal' } });
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 58000);
  try {
    const r = await fetch(VK_APP() + '/api/ordner', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bt: id }), signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Verkaufstool antwortet mit Status ' + r.status);
    return j.results || [];
  } catch (e) { throw new Error(e.name === 'AbortError' ? 'Verkaufstool antwortet nicht rechtzeitig (der Versand läuft eventuell trotzdem weiter)' : e.message); }
  finally { clearTimeout(tm); }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  if (!okToken(req)) return res.status(401).json({ error: 'Bitte neu anmelden' });
  const b = await body(req), art = String(b.art || ''), id = String(b.id || '');
  if (!['abschluss', 'pdf', 'vakanz'].includes(art) || !id) return res.status(400).json({ error: 'Aktion oder Gespräch fehlt' });
  try {
    const row = (await db(`gespraeche?select=id,daten&id=eq.${enc(id)}`))[0];
    if (!row) return res.status(404).json({ error: 'Gespräch nicht gefunden, bitte zuerst speichern' });
    const g = Object.assign({}, row.daten, { id: row.id }), x = b.x || {};
    let results = [];
    if (art === 'vakanz') {
      const name = String(b.name || '').trim(); if (!name) return res.status(400).json({ error: 'Person fehlt' });
      results = await job('vakanz', { id, name, rest: (b.rest || []).slice(0, 20), start: (g.prot && g.prot.start) || g.start || '', von: b.von || '' });
    } else {
      if (!g.prot) return res.status(400).json({ error: 'Protokoll fehlt' });
      results = await job(art, { g, x });
      if (art === 'abschluss') results = results.concat(await material(g, x));
    }
    /* Ergebnis direkt beim Gespräch ablegen (ohne Versionswechsel), damit es auch sichtbar ist, wenn das Gerät inzwischen geschlossen wurde */
    if (art === 'abschluss') await db(`gespraeche?id=eq.${enc(id)}`, { method: 'PATCH', body: { daten: Object.assign({}, row.daten, { sending: false, sendRes: { at: new Date().toISOString().slice(0, 10), results } }) }, headers: { Prefer: 'return=minimal' } }).catch(() => {});
    const txt = (art === 'vakanz' ? 'Vakanz' : art === 'pdf' ? 'PDFs erneut' : 'Abschluss') + ': ' + results.map(r => (r.ok ? '✓ ' : '✗ ') + r.t).join(' · ');
    await db('ereignisse', { method: 'POST', body: { gespraech_id: id, von: b.von || null, text: txt.slice(0, 2000) }, headers: { Prefer: 'return=minimal' } }).catch(() => {});
    res.status(200).json({ ok: results.every(r => r.ok), results });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
};
