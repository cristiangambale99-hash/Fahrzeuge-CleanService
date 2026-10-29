// Vercel Serverless Function: /api/km-lesen
// Liest den Gesamtkilometerstand von einem Tachofoto mit der Claude API aus.
// Wird in der Mitarbeiter-App beim Schritt «Kilometerstand» aufgerufen (Tanken, Fahrzeugmeldung, Übernahme/Abgabe).
//
// Environment Variables in Vercel:
//   ANTHROPIC_API_KEY  (Pflicht)  derselbe Schlüssel wie beim Bussen-Finder
//   KM_MODEL           (optional) Standard: claude-haiku-4-5-20251001
//
// Schutz: Nur mit gültiger Anmeldung der Mitarbeiter-App (Personalnummer-Kennung), nur Fotos bis ca. 3 MB.

const MAX_BASE64 = 4 * 1024 * 1024;
const TYPEN = ['image/jpeg', 'image/png', 'image/webp'];
const GRUENDE = ['unscharf', 'spiegelung', 'zu_weit', 'kein_tacho', 'tageszaehler', 'dunkel', 'andere'];

const SCHEMA = {
  type: 'object',
  properties: {
    lesbar: { type: 'boolean', description: 'true nur, wenn der GESAMTkilometerstand (Odometer) vollständig und eindeutig lesbar ist' },
    km: { type: ['integer', 'null'], description: 'Gesamtkilometerstand als ganze Zahl ohne Trennzeichen, z. B. 45622. null, wenn nicht eindeutig lesbar' },
    sicherheit: { type: 'string', enum: ['hoch', 'mittel', 'tief'] },
    grund: { type: ['string', 'null'], enum: [...GRUENDE, null], description: 'Nur wenn nicht lesbar: unscharf, spiegelung, zu_weit, kein_tacho, tageszaehler (nur Tages-/Tripzähler sichtbar), dunkel (Display aus), andere' }
  },
  required: ['lesbar', 'km', 'sicherheit', 'grund']
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Nur POST erlaubt' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY ist in Vercel nicht hinterlegt' });

  let p = req.body;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { return res.status(400).json({ error: 'Ungültiges JSON' }); } }
  if (!p || !p.data) return res.status(400).json({ error: 'Foto fehlt' });
  if (!/^[0-9a-f]{64}$/.test(String(p.pnh || ''))) return res.status(403).json({ error: 'Kein Zugriff' });
  const mediaType = p.mediaType || 'image/jpeg';
  if (!TYPEN.includes(mediaType)) return res.status(415).json({ error: 'Nur Fotos' });
  if (String(p.data).length > MAX_BASE64) return res.status(413).json({ error: 'Foto zu gross' });

  const body = {
    model: process.env.KM_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: 'Du liest auf Fotos von Fahrzeug-Armaturenbrettern den GESAMTKILOMETERSTAND (Odometer) ab. ' +
      'Nicht verwechseln mit: Tageskilometerzähler/Trip (oft mit TRIP, A/B oder einer Nachkommastelle), Geschwindigkeit, Reichweite, Uhrzeit, Temperatur oder Serviceintervall. ' +
      'Gib die Zahl nur zurück, wenn jede Ziffer eindeutig lesbar ist. Rate nie: Ist auch nur eine Ziffer unsicher, abgeschnitten, spiegelnd oder unscharf, setze lesbar=false und km=null und nenne den Grund. ' +
      'Antworte ausschliesslich über das Werkzeug km_stand.',
    tools: [{ name: 'km_stand', description: 'Abgelesener Gesamtkilometerstand', input_schema: SCHEMA }],
    tool_choice: { type: 'tool', name: 'km_stand' },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: p.data } },
      { type: 'text', text: 'Wie hoch ist der Gesamtkilometerstand?' }
    ] }]
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
    const x = t.input || {};
    const km = Number.isInteger(x.km) && x.km >= 0 && x.km < 3000000 ? x.km : null;
    const lesbar = !!x.lesbar && km !== null && x.sicherheit !== 'tief';
    return res.status(200).json({ ok: true, lesbar, km: lesbar ? km : null, sicherheit: x.sicherheit || null, grund: lesbar ? null : (GRUENDE.includes(x.grund) ? x.grund : 'andere') });
  } catch (e) {
    return res.status(502).json({ error: 'Claude API nicht erreichbar' });
  }
};
