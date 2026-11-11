/* Startgespräche laden und speichern.
   GET  /api/gespraeche          → übernimmt neue gewonnene Aufträge aus dem Verkaufstool und liefert alle Gespräche
   PUT  /api/gespraeche          → speichert geänderte Gespräche { items: [{ id, daten, version }], von }
   Gespeichert wird in der Supabase «Besprechungstermin» (Tabelle gespraeche, Verlauf in ereignisse). */
const { E, okToken, body, db, vk } = require('./_lib');
const GO_LIVE = () => E.GO_LIVE || '2026-11-09';
const enc = encodeURIComponent;

/* ---------- Verkaufstool → Startgespräch ---------- */
function freqOf(o) {
  const rh = (o.rh || [])[0];
  if (rh && rh.f === '14T') return 'alle 14 Tage';
  if (rh && rh.f === 'M') return '1x pro Monat';
  const n = (o.days || []).length;
  return (n || 1) + 'x pro Woche';
}
function aufwandOf(o) {
  if (o.stdProTag === true || o.stdProTag === 'true') { const v = Object.values(o.stdTage || {}).map(Number).filter(x => x > 0); if (v.length) return Math.round(v.reduce((a, b) => a + b, 0) / v.length * 100) / 100; }
  return o.stdEinsatz != null && o.stdEinsatz !== '' ? Number(o.stdEinsatz) : (rh => rh ? Number(rh.h) : '')((o.rh || [])[0]);
}
function extrasOf(o) {
  const x = [], add = (k, n, mode, p, m2) => { if (!mode || mode === 'nein') return; x.push({ k, n, mode: mode === 'm2' ? 'm2' : 'pauschal', p: Number(p) || 0, m2: Number(m2) || undefined, unit: 'pro Ausführung' }); };
  add('fenster', 'Fensterreinigung 2-seitig', o.fensterMode, o.fensterPreis, o.fensterM2);
  add('glas', 'Glastrennwände 2-seitig', o.glasMode, o.glasPreis, o.glasM2);
  add('teppich', 'Teppiche sprühextrahieren', o.teppichMode, o.teppichPreis, o.teppichM2);
  return x;
}
const bewerbOf = o => ((o.vak && o.vak.apps) || []).map(a => ({ n: a.name, pnr: a.pnr || '', d: a.datum || '', z: a.uhrzeit || '' }));
function mapObj(o, c) {
  const a = o.annahme || {};
  const termin = a.d ? { datum: a.d, zeit: a.t || '', invited: true, von: 'Kunde (online gebucht)', am: (a.at || '').slice(0, 10) } : null;
  const fe = extrasOf(o).find(e => e.k === 'fenster');
  return {
    id: o.id, firma: c.firma || o.name || 'Ohne Namen', kontakt: c.kontakt || a.name || '', anrede: c.anrede || '', email: c.email || a.email || '', tel: c.tel || '',
    adresse: o.adresse || c.adresse || '', objNr: o.objNr || o.nr || '', nr: o.nr || '',
    start: a.vb || '', startZeit: '', startPer: a.vbTxt || (o.aktivAb ? o.aktivAb : ''), startFix: false,
    freq: freqOf(o), aufwand: aufwandOf(o), tage: o.days || [], zeit: o.zeit || '',
    ma: [], bewerb: bewerbOf(o), chat: !!(o.bk && o.bk.chatId), verk: o.verkaeufer || '', al: a.calName || (o.einf && o.einf.name) || 'Sergio Da Silva',
    status: 'offen', neu: true, termin, fenster: fe ? { preis: fe.p, nr: o.nr, datum: o.sent || '' } : null, extras: extrasOf(o), wasch: !!o.wasch,
    prot: null, fotos: [],
    log: [{ t: (a.at || o.auftragAm || '').slice(0, 10), x: `Aus Verkaufstool übernommen: Auftrag erteilt${a.at ? ' online' : ''}, Offerte ${o.nr || ''}${a.vbTxt ? ', Vertragsbeginn per ' + a.vbTxt : ''}` }]
      .concat(termin ? [{ t: termin.am || termin.datum, x: `Startgespräch vom Kunden gebucht: ${termin.datum} ${termin.zeit} Uhr` }] : [])
  };
}
async function sync() {
  if (!E.VK_KEY) return { neu: 0, hinweis: 'Verbindung zum Verkaufstool noch nicht eingerichtet (VK_KEY fehlt)' };
  const objs = await vk(`docs?select=data&path=like.${enc('objects/*')}&data->>status=eq.gewonnen&or=(deleted.is.null,deleted.eq.false)`);
  const ab = GO_LIVE(), cand = objs.map(r => r.data).filter(o => o && o.id && (((o.annahme && o.annahme.at) || o.auftragAm || '').slice(0, 10) >= ab));
  if (!cand.length) return { neu: 0 };
  const have = await db(`gespraeche?select=id,status,daten&id=in.(${cand.map(o => '"' + o.id + '"').join(',')})`);
  const byId = Object.fromEntries(have.map(h => [h.id, h]));
  const fresh = cand.filter(o => !byId[o.id]);
  let neu = 0;
  if (fresh.length) {
    const cids = [...new Set(fresh.map(o => o.customerId).filter(Boolean))];
    const cust = cids.length ? await vk(`docs?select=data&path=in.(${cids.map(i => '"customers/' + i + '"').join(',')})`) : [];
    const cm = Object.fromEntries(cust.map(r => [r.data.id, r.data]));
    const rows = fresh.map(o => { const d = mapObj(o, cm[o.customerId] || {}); return { id: d.id, nr: d.nr, firma: d.firma, al: d.al, status: 'offen', termin_datum: d.termin ? d.termin.datum : null, quelle: 'verkaufstool', daten: d }; });
    await db('gespraeche', { method: 'POST', body: rows, headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } });
    await db('ereignisse', { method: 'POST', body: rows.map(r => ({ gespraech_id: r.id, von: 'Verkaufstool', text: 'Aus Verkaufstool übernommen' })), headers: { Prefer: 'return=minimal' } });
    neu = rows.length;
  }
  /* Bei offenen Gesprächen Bewerber und gebuchten Termin nachführen (ohne Versionswechsel) */
  for (const o of cand) {
    const h = byId[o.id]; if (!h || h.status === 'erledigt') continue;
    const d = h.daten || {}, b = bewerbOf(o), a = o.annahme || {}, ch = {};
    if (JSON.stringify(b) !== JSON.stringify(d.bewerb || [])) ch.bewerb = b;
    if (!d.termin && a.d) ch.termin = { datum: a.d, zeit: a.t || '', invited: true, von: 'Kunde (online gebucht)', am: (a.at || '').slice(0, 10) };
    if (!d.chat && o.bk && o.bk.chatId) ch.chat = true;
    if (Object.keys(ch).length) await db(`gespraeche?id=eq.${enc(o.id)}`, { method: 'PATCH', body: Object.assign({ daten: Object.assign({}, d, ch) }, ch.termin ? { termin_datum: ch.termin.datum } : {}), headers: { Prefer: 'return=minimal' } });
  }
  return { neu };
}

/* ---------- Speichern ---------- */
async function saveOne(it, von) {
  const d = it.daten || {}, id = String(it.id || d.id || ''); if (!id) throw new Error('ID fehlt');
  const size = JSON.stringify(d).length; if (size > 3800000) throw new Error('Zu viele oder zu grosse Fotos in diesem Gespräch');
  const cols = { firma: d.firma || null, al: d.al || null, status: d.status === 'erledigt' ? 'erledigt' : 'offen', termin_datum: d.termin && d.termin.datum ? d.termin.datum : null, daten: d, aktualisiert_am: new Date().toISOString(), aktualisiert_von: von || null };
  const v = Number(it.version) || 0;
  if (v > 0) {
    const r = await db(`gespraeche?id=eq.${enc(id)}&version=eq.${v}&select=version,status,abgeschlossen_am`, { method: 'PATCH', body: Object.assign({}, cols, { version: v + 1 }), headers: { Prefer: 'return=representation' } });
    if (r && r.length) {
      if (cols.status === 'erledigt' && !r[0].abgeschlossen_am) { await db(`gespraeche?id=eq.${enc(id)}`, { method: 'PATCH', body: { abgeschlossen_am: new Date().toISOString() }, headers: { Prefer: 'return=minimal' } }); await db('ereignisse', { method: 'POST', body: { gespraech_id: id, von, text: 'Protokoll abgeschlossen und unterschrieben' }, headers: { Prefer: 'return=minimal' } }); }
      return { id, version: v + 1 };
    }
    const cur = await db(`gespraeche?id=eq.${enc(id)}&select=daten,version`);
    if (cur.length) return { id, konflikt: true, version: cur[0].version, daten: cur[0].daten };
  }
  /* neu (z. B. manuell erfasst) */
  await db('gespraeche', { method: 'POST', body: Object.assign({ id, nr: d.objNr || null, quelle: v > 0 ? 'verkaufstool' : 'manuell', version: 1 }, cols), headers: { Prefer: 'return=minimal' } });
  await db('ereignisse', { method: 'POST', body: { gespraech_id: id, von, text: 'Gespräch manuell erfasst' }, headers: { Prefer: 'return=minimal' } });
  return { id, version: 1 };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!okToken(req)) return res.status(401).json({ error: 'Bitte neu anmelden' });
  try {
    if (req.method === 'GET') {
      let s = { neu: 0 };
      try { s = await sync(); } catch (e) { s = { neu: 0, hinweis: 'Verkaufstool nicht erreichbar: ' + e.message }; }
      const seit = new Date(Date.now() - 120 * 864e5).toISOString();
      const rows = await db(`gespraeche?select=id,version,daten&or=(status.eq.offen,abgeschlossen_am.gt.${enc('"' + seit + '"')})&order=termin_datum.asc.nullslast`);
      return res.status(200).json({ items: rows.map(r => Object.assign({}, r.daten, { id: r.id, _v: r.version })), sync: s });
    }
    if (req.method === 'PUT') {
      const b = await body(req), out = [];
      for (const it of (b.items || []).slice(0, 20)) { try { out.push(await saveOne(it, b.von)); } catch (e) { out.push({ id: it.id, error: e.message }); } }
      return res.status(200).json({ results: out });
    }
    res.status(405).end();
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
};
