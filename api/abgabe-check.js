// Vercel Serverless Function: /api/abgabe-check
// Wird von der Mitarbeiter-App direkt nach jeder neuen Übernahme aufgerufen.
// Hat die vorherige Person das Fahrzeug übernommen, aber keine Abgabe erfasst, dann:
//   1. Mail an personal@clean-service.ch (Cc logistik@clean-service.ch) mit der Bitte um eine Busse CHF 100
//   2. Beekeeper-Nachricht vom HR BOT an diese Person
// Ob eine Abgabe fehlt, prüft die Datenbank selbst (fz_abgabe_claim) – die App kann keine Busse erzwingen.
// Pro fehlender Abgabe gibt es nur eine Busse. Fahrzeuge mit «Geteiltes Fahrzeug» sind ausgenommen.
//
// Environment Variables in Vercel: RESEND_API_KEY, BEEKEEPER_TOKEN (wie bei send-mail.js / beekeeper.js)

const SB_URL = 'https://yjnkaeplhxcsubwqpqkz.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlqbmthZXBsaHhjc3Vid3FwcWt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2MjM5MzAsImV4cCI6MjEwNTE5OTkzMH0.nruDrgHbM2quYxo9MyjhMsDSC5gabTj6aO3R2YXmVZ8'; // öffentlicher Supabase-Schlüssel
const MAIL_TO = 'personal@clean-service.ch';
const MAIL_CC = 'logistik@clean-service.ch';

async function rpc(fn, args) {
  const r = await fetch(SB_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  if (!r.ok) throw new Error(fn + ' HTTP ' + r.status);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dt = iso => { try { return new Date(iso).toLocaleString('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return String(iso || ''); } };
const tag = iso => { try { return new Date(iso).toLocaleDateString('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric' }); } catch (e) { return ''; } };
const zeit = iso => { try { return new Date(iso).toLocaleTimeString('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
const km = n => n == null || n === '' ? '–' : Number(n).toLocaleString('de-CH').replace(/[’,]/g, "'") + ' km';
const pnT = (who, pn) => esc(who) + (pn ? ' (PN ' + esc(pn) + ')' : '');

function bkText(d, veh) {
  return `Hallo ${d.prev.who}\n\nDu hast das Fahrzeug ${veh} am ${tag(d.prev.at)} übernommen, aber in der Fahrzeug-App keine Abgabe erfasst. Am ${tag(d.neu.at)} um ${zeit(d.neu.at)} hat eine andere Person das Fahrzeug übernommen.\n\nGemäss Dienstwagenreglement wird dafür eine Busse von CHF 100.– ausgestellt. Die Personalabteilung meldet sich mit den Details.\n\nBitte fülle bei jeder Rückgabe das Abgabeformular in der Fahrzeug-App aus.\n\nPersonalabteilung`;
}

function mailHtml(d, veh, bk) {
  const row = (l, x) => `<tr><td style="padding:7px 12px 7px 0;color:#6A7378;width:190px;vertical-align:top;border-bottom:1px solid #E2E7EA">${l}</td><td style="padding:7px 0;border-bottom:1px solid #E2E7EA">${x}</td></tr>`;
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#2B3135;line-height:1.55"><div style="background:#FBEDEB;color:#B8433A;border-radius:8px;padding:12px 16px;font-weight:700;margin-bottom:16px">Bitte um Fahrzeugbusse CHF 100.– – fehlende Fahrzeugabgabe</div>
  <p>Guten Tag</p><p>Die Fahrzeug-App hat eine fehlende Fahrzeugabgabe erkannt. Wir bitten euch, gemäss Dienstwagenreglement eine Fahrzeugbusse von CHF 100.– auszustellen.</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px;margin:6px 0 14px">${row('Mitarbeiter', `<b>${pnT(d.prev.who, d.prev.pn)}</b>`)}${row('Busse', '<b>CHF 100.–</b>')}${row('Fahrzeug', `<b>${esc(veh)}</b>`)}${row('Übernommen', `${dt(d.prev.at)} · ${km(d.prev.km)}`)}${row('Abgabe', '<b style="color:#B8433A">nicht erfasst</b>')}${row('Nächste Übernahme', `${pnT(d.neu.who, d.neu.pn)} · ${dt(d.neu.at)} · ${km(d.neu.km)}`)}${row('Beekeeper', bk.ok ? `${esc(d.prev.who)} wurde vom HR BOT informiert` : `<span style="color:#B8433A">Nachricht konnte nicht gesendet werden${bk.err ? ' (' + esc(bk.err) + ')' : ''} – bitte Mitarbeiter direkt informieren</span>`)}</table>
  <p style="margin:0">Freundliche Grüsse<br>Clean Service Scaramuzzo AG · Fahrzeuge</p><p style="color:#6A7378;font-size:12px;margin-top:14px">Automatische Meldung der Fahrzeug-App · Fall ${esc(d.prev.id)} (Übernahme ohne Abgabe) · ${esc(d.neu.id)} (nächste Übernahme)</p></div>`;
}

async function sendBeekeeper(pn, name, text) {
  const token = process.env.BEEKEEPER_TOKEN;
  if (!token) return { ok: false, err: 'BEEKEEPER_TOKEN fehlt' };
  const base = String(process.env.BEEKEEPER_URL || 'https://clean-service.ch.beekeeper.io').replace(/\/+$/, '') + '/api/2/';
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { Authorization: 'Token ' + token, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
  };
  const nameOf = u => u.display_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.name || '';
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  let user = null;
  if (pn) { const r = await call('GET', 'users/by_tenant_user_id/' + encodeURIComponent(pn)); if (r.ok && r.data && r.data.id) user = r.data; }
  if (!user && name) {
    const r = await call('GET', 'users?limit=20&include_bots=false&q=' + encodeURIComponent(name));
    const list = r.ok && Array.isArray(r.data) ? r.data : [];
    let hits = list.filter(u => norm(nameOf(u)) === norm(name));
    if (!hits.length) { const parts = norm(name).split(' '); hits = list.filter(u => parts.every(p => norm(nameOf(u)).includes(p))); }
    if (hits.length === 1) user = hits[0];
    else if (hits.length > 1) return { ok: false, err: 'mehrere Personen mit diesem Namen in Beekeeper' };
  }
  if (!user) return { ok: false, err: 'Person in Beekeeper nicht gefunden' };
  const ids = [...new Set([user.id, user.uuid, user.user_id].filter(Boolean).map(String))];
  let last = null;
  for (const uid of ids) {
    const m = await call('POST', 'chats/users/' + encodeURIComponent(uid) + '/messages?apply_rich_text=false', { body: text });
    if (m.ok) return { ok: true, an: nameOf(user), at: new Date().toISOString() };
    last = m; if (m.status === 401 || m.status === 403) break;
  }
  return { ok: false, err: 'HTTP ' + (last ? last.status : '?') };
}

async function sendMail(subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, err: 'RESEND_API_KEY fehlt' };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM || 'Fahrzeug-App Clean Service <fahrzeuge@clean-service.ch>', to: [MAIL_TO], cc: [MAIL_CC], subject: subject.slice(0, 300), html })
  });
  const j = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, id: j.id || null, at: new Date().toISOString() } : { ok: false, err: (j && j.message) || 'HTTP ' + r.status };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Nur POST erlaubt' });
  let p = req.body;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { return res.status(400).json({ error: 'Ungültiges JSON' }); } }
  const id = String((p && p.id) || '');
  if (!/^FZ-\d{4}-\d{5}$/.test(id)) return res.status(400).json({ error: 'Vorgang fehlt' });
  // Fahrzeugbezeichnung nur als Anzeigetext (der Fall selbst kommt aus der Datenbank)
  const veh = String((p && p.vehTxt) || '').replace(/[<>]/g, '').slice(0, 120) || 'Fahrzeug';

  let d;
  try { d = await rpc('fz_abgabe_claim', { p_id: id }); }
  catch (e) { return res.status(502).json({ error: 'Datenbank nicht erreichbar' }); }
  if (!d) return res.status(200).json({ busse: false });

  const bk = await sendBeekeeper(d.prev.pn ? String(d.prev.pn) : '', d.prev.who, bkText(d, veh)).catch(e => ({ ok: false, err: 'Beekeeper nicht erreichbar' }));
  const mail = await sendMail(`Bitte um Fahrzeugbusse CHF 100 · fehlende Abgabe · ${veh} · ${d.prev.who}`, mailHtml(d, veh, bk)).catch(e => ({ ok: false, err: 'Mail nicht gesendet' }));
  try { await rpc('fz_abgabe_status', { p_id: d.prev.id, p_token: d.token, p_status: mail.ok ? 'gesendet' : 'fehler', p_patch: { mail, bk, vehTxt: veh } }); } catch (e) { /* Status wird in der Verwaltung als «neu» angezeigt */ }
  return res.status(200).json({ busse: true, mail: mail.ok, beekeeper: bk.ok });
};
