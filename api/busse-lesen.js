// Vercel Serverless Function: /api/busse-lesen
// Liest eine fotografierte Busse (Bild oder PDF) mit der Claude API aus und gibt die Angaben als JSON zurück:
// Kontrollschild, Datum, Uhrzeit, Ort, Betrag, Übertretung, Behörde, Referenz, Zahlungsfrist.
// Die Zuordnung zum Fahrer macht danach die Fahrzeug-App anhand der Übernahmen und Abgaben.
//
// Environment Variables in Vercel (Project → Settings → Environment Variables):
//   ANTHROPIC_API_KEY  (Pflicht)  API-Key aus der Claude Console (console.anthropic.com)
//   BUSSEN_MODEL       (optional) Standard: claude-haiku-4-5-20251001
//
// Schutz: Nur mit gültigem Verwaltungscode (wird in Supabase geprüft), damit niemand sonst den API-Key nutzen kann.

const SB_URL = 'https://yjnkaeplhxcsubwqpqkz.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlqbmthZXBsaHhjc3Vid3FwcWt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2MjM5MzAsImV4cCI6MjEwNTE5OTkzMH0.nruDrgHbM2quYxo9MyjhMsDSC5gabTj6aO3R2YXmVZ8'; // öffentlicher Supabase-Schlüssel
const MAX_BASE64 = 4 * 1024 * 1024; // Vercel erlaubt max. 4.5 MB pro Anfrage
const TYPEN = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

async function codeOk(code) {
  try {
    const r = await fetch(SB_URL + '/rest/v1/rpc/fz_admin_ok', {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_code: String(code || '') })
    });
    return r.ok && (await r.json()) === true;
  } catch (e) { return false; }
}

const SCHEMA = {
  type: 'object',
  properties: {
    lesbar: { type: 'boolean', description: 'true, wenn es sich um eine Busse / Ordnungsbusse / Strafverfügung / Parkbusse handelt und die Angaben lesbar sind' },
    kontrollschild: { type: ['string', 'null'], description: 'Kontrollschild wie auf dem Dokument, z. B. "ZH 257 777"' },
    datum: { type: ['string', 'null'], description: 'Datum der Übertretung (nicht Ausstellungsdatum) im Format YYYY-MM-DD' },
    uhrzeit: { type: ['string', 'null'], description: 'Uhrzeit der Übertretung im Format HH:MM (24h)' },
    ort: { type: ['string', 'null'], description: 'Ort / Strasse der Übertretung' },
    betrag: { type: ['number', 'null'], description: 'Bussenbetrag in CHF (ohne Gebühren, falls getrennt ausgewiesen)' },
    gebuehren: { type: ['number', 'null'], description: 'Zusätzliche Gebühren in CHF, falls separat ausgewiesen' },
    uebertretung: { type: ['string', 'null'], description: 'Kurze Beschreibung der Übertretung auf Deutsch, z. B. "Geschwindigkeitsüberschreitung innerorts um 8 km/h" oder "Parkieren ohne Parkscheibe"' },
    behoerde: { type: ['string', 'null'], description: 'Ausstellende Behörde, z. B. "Stadtpolizei Zürich"' },
    referenz: { type: ['string', 'null'], description: 'Bussen-/Referenz-/Verfügungsnummer' },
    zahlbar_bis: { type: ['string', 'null'], description: 'Zahlungsfrist im Format YYYY-MM-DD' },
    sicherheit: { type: 'string', enum: ['hoch', 'mittel', 'tief'], description: 'Wie sicher Kontrollschild, Datum und Uhrzeit gelesen wurden' },
    hinweis: { type: ['string', 'null'], description: 'Kurzer Hinweis auf Deutsch, falls etwas unklar oder unleserlich ist' }
  },
  required: ['lesbar', 'kontrollschild', 'datum', 'uhrzeit', 'ort', 'betrag', 'uebertretung', 'behoerde', 'referenz', 'zahlbar_bis', 'sicherheit', 'hinweis']
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Nur POST erlaubt' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY ist in Vercel nicht hinterlegt' });

  let p = req.body;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { return res.status(400).json({ error: 'Ungültiges JSON' }); } }
  if (!p || !p.data || !p.mediaType) return res.status(400).json({ error: 'Datei fehlt' });
  if (!TYPEN.includes(p.mediaType)) return res.status(415).json({ error: 'Nur Foto (JPG, PNG) oder PDF' });
  if (String(p.data).length > MAX_BASE64) return res.status(413).json({ error: 'Datei zu gross (max. ca. 3 MB)' });
  if (!(await codeOk(p.code))) return res.status(403).json({ error: 'Kein Zugriff' });

  const flotte = Array.isArray(p.fahrzeuge) ? p.fahrzeuge.slice(0, 200).map(v => `Nr. ${v.nr}: ${v.plate} (${v.model})`).join('\n') : '';
  const datei = p.mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data } }
    : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } };

  const body = {
    model: process.env.BUSSEN_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system: 'Du liest Schweizer Bussen (Ordnungsbussen, Parkbussen, Radarbussen, Strafverfügungen) für die Fahrzeugverwaltung der Clean Service Scaramuzzo AG aus. Gib die Angaben exakt so zurück, wie sie auf dem Dokument stehen. Rate nichts: Was nicht lesbar ist, ist null. Datum und Uhrzeit sind die der Übertretung, nicht das Ausstellungsdatum. Antworte ausschliesslich über das Werkzeug busse_daten.' +
      (flotte ? '\n\nKontrollschilder der eigenen Flotte (nur zur Hilfe beim Lesen, nicht erfinden):\n' + flotte : ''),
    tools: [{ name: 'busse_daten', description: 'Ausgelesene Angaben der Busse', input_schema: SCHEMA }],
    tool_choice: { type: 'tool', name: 'busse_daten' },
    messages: [{ role: 'user', content: [datei, { type: 'text', text: 'Lies diese Busse aus.' }] }]
  };

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || ('Claude API HTTP ' + r.status) });
    const t = (j.content || []).find(c => c.type === 'tool_use');
    if (!t) return res.status(502).json({ error: 'Keine Angaben erhalten' });
    return res.status(200).json({ ok: true, daten: t.input, usage: j.usage || null, model: j.model || body.model });
  } catch (e) {
    return res.status(502).json({ error: 'Claude API nicht erreichbar' });
  }
};
