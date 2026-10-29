// Vercel Serverless Function: /api/km-lesen
// Liest den Gesamtkilometerstand von einem Tachofoto mit der Claude API aus.
// Wird in der Mitarbeiter-App beim Schritt «Kilometerstand» aufgerufen (Tanken, Fahrzeugmeldung, Übernahme/Abgabe).
//
// Auf vielen Displays stehen mehrere Zahlen (Tageszähler, Reichweite, Service-Intervall, Tempo, Uhrzeit ...).
// Claude listet deshalb ALLE sichtbaren Zahlen mit ihrer Bedeutung auf und wählt daraus den Gesamtkilometerstand.
// Zusätzlich hilft der letzte bekannte Kilometerstand des Fahrzeugs beim Auswählen (nie beim Ablesen der Ziffern).
//
// Environment Variables in Vercel:
//   ANTHROPIC_API_KEY  (Pflicht)  derselbe Schlüssel wie beim Bussen-Finder
//   KM_MODEL           (optional) Standard: claude-sonnet-5
//
// Schutz: Nur mit Anmeldung der Mitarbeiter-App (Personalnummer-Kennung), nur Fotos bis ca. 3 MB.

const MAX_BASE64 = 4 * 1024 * 1024;
const TYPEN = ['image/jpeg', 'image/png', 'image/webp'];
const GRUENDE = ['unscharf', 'spiegelung', 'zu_weit', 'kein_tacho', 'tageszaehler', 'dunkel', 'andere'];
const ARTEN = ['gesamt', 'tageszaehler', 'reichweite', 'service', 'geschwindigkeit', 'uhrzeit', 'temperatur', 'verbrauch', 'andere'];

const SCHEMA = {
  type: 'object',
  properties: {
    zahlen: {
      type: 'array',
      description: 'ALLE auf dem Display/Tacho sichtbaren Zahlen, jede mit ihrer Bedeutung',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Die Zahl genau so, wie sie angezeigt wird, inkl. Einheit/Beschriftung, z. B. "123456 km", "TRIP A 312.4", "Reichweite 480 km"' },
          wert: { type: ['number', 'null'], description: 'Zahlenwert ohne Tausendertrennzeichen' },
          art: { type: 'string', enum: ARTEN, description: 'gesamt = Gesamtkilometerstand/Odometer/ODO; tageszaehler = TRIP/A/B/Tageskm (oft mit Nachkommastelle); reichweite = Restreichweite (oft mit Tanksäule-Symbol oder "Reichweite/Range"); service = km bis zum Service (Schraubenschlüssel); geschwindigkeit; uhrzeit; temperatur; verbrauch (l/100 km); andere' },
          lesbar: { type: 'boolean', description: 'true, wenn jede Ziffer dieser Zahl eindeutig lesbar ist' }
        },
        required: ['text', 'wert', 'art', 'lesbar']
      }
    },
    km: { type: ['integer', 'null'], description: 'Der Gesamtkilometerstand (Odometer) als ganze Zahl. null, wenn kein Gesamtkilometerstand eindeutig lesbar ist' },
    sicherheit: { type: 'string', enum: ['hoch', 'mittel', 'tief'], description: 'Wie sicher die Zahl bei km der Gesamtkilometerstand ist und richtig gelesen wurde' },
    grund: { type: ['string', 'null'], enum: [...GRUENDE, null], description: 'Nur wenn km null ist: unscharf, spiegelung, zu_weit, kein_tacho, tageszaehler (nur Tageszähler sichtbar), dunkel (Display aus), andere' }
  },
  required: ['zahlen', 'km', 'sicherheit', 'grund']
};

const istKm = n => Number.isInteger(n) && n >= 0 && n < 3000000;

// Wählt den Gesamtkilometerstand – zuerst Claudes Wahl, sonst aus den erkannten Zahlen.
function auswahl(x, lastKm) {
  const zahlen = Array.isArray(x.zahlen) ? x.zahlen : [];
  const passt = n => lastKm == null || (n >= lastKm - 50 && n - lastKm <= 20000);
  // 1. Claudes eigene Wahl
  if (istKm(x.km) && x.sicherheit !== 'tief' && passt(x.km)) return { km: x.km, sicherheit: x.sicherheit, weg: 'claude' };
  // 2. Genau eine lesbare Zahl, die als Gesamtkilometerstand erkannt wurde
  const ges = zahlen.filter(z => z.art === 'gesamt' && z.lesbar && istKm(Math.round(z.wert)) && Number.isInteger(z.wert));
  const gesPasst = ges.filter(z => passt(z.wert));
  if (gesPasst.length === 1) return { km: gesPasst[0].wert, sicherheit: 'mittel', weg: 'gesamt' };
  // 3. Mit dem letzten Kilometerstand: genau eine ganze Zahl, die als Gesamtstand in Frage kommt
  if (lastKm != null) {
    const ausschluss = ['tageszaehler', 'geschwindigkeit', 'uhrzeit', 'temperatur', 'verbrauch', 'reichweite', 'service'];
    const kand = zahlen.filter(z => z.lesbar && Number.isInteger(z.wert) && !ausschluss.includes(z.art) && passt(z.wert) && z.wert >= 1000);
    const werte = [...new Set(kand.map(z => z.wert))];
    if (werte.length === 1) return { km: werte[0], sicherheit: 'mittel', weg: 'letzterStand' };
  }
  // 4. Claude hat eine Zahl, die aber nicht zum letzten Stand passt – trotzdem zurückgeben, die App fragt nach
  if (istKm(x.km) && x.sicherheit !== 'tief') return { km: x.km, sicherheit: 'mittel', weg: 'claude_unplausibel' };
  return null;
}

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
  const lastKm = Number.isInteger(p.lastKm) && p.lastKm >= 0 ? p.lastKm : null;
  const fahrzeug = String(p.fahrzeug || '').slice(0, 80);

  const body = {
    model: process.env.KM_MODEL || 'claude-sonnet-5',
    max_tokens: 700,
    system: 'Du liest auf Fotos von Fahrzeug-Armaturenbrettern den GESAMTKILOMETERSTAND (Odometer) ab. ' +
      'Auf vielen Displays stehen mehrere Zahlen. Gehe so vor: 1) Liste ALLE sichtbaren Zahlen mit ihrer Bedeutung auf. ' +
      '2) Bestimme, welche davon der Gesamtkilometerstand ist. Merkmale: meist die grösste km-Zahl, 4 bis 6 Stellen, ganze Zahl ohne Nachkommastelle, oft mit "km", "ODO" oder "Gesamt" beschriftet oder ohne Beschriftung unten im Display. ' +
      'NICHT der Gesamtstand sind: Tageszähler (TRIP, A/B, oft mit Nachkommastelle), Reichweite (Tanksäulen-Symbol, "Reichweite", "Range", meist unter 1500 km), Service-Intervall (Schraubenschlüssel, "Service in ..."), Geschwindigkeit, Uhrzeit, Aussentemperatur, Verbrauch. ' +
      'Ablesen: Lies jede Ziffer genau so, wie sie auf dem Foto steht. Rate keine Ziffern. Ist der Gesamtstand nicht vollständig lesbar, setze km=null und nenne den Grund. ' +
      (lastKm != null ? `Hilfe zur Auswahl: Der letzte bekannte Kilometerstand dieses Fahrzeugs war ${lastKm} km; der Gesamtstand ist in der Regel gleich oder etwas höher. Nutze das nur, um die richtige Zahl auszuwählen – ändere nie abgelesene Ziffern, damit sie passen. ` : '') +
      (fahrzeug ? `Fahrzeug: ${fahrzeug}. ` : '') +
      'Antworte ausschliesslich über das Werkzeug km_stand.',
    tools: [{ name: 'km_stand', description: 'Alle sichtbaren Zahlen und der Gesamtkilometerstand', input_schema: SCHEMA }],
    tool_choice: { type: 'tool', name: 'km_stand' },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: p.data } },
      { type: 'text', text: 'Welche Zahlen sind sichtbar, und welche davon ist der Gesamtkilometerstand?' }
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
    const a = auswahl(x, lastKm);
    const zahlen = (Array.isArray(x.zahlen) ? x.zahlen : []).slice(0, 12).map(z => ({ text: String(z.text || '').slice(0, 40), art: z.art }));
    if (a) return res.status(200).json({ ok: true, lesbar: true, km: a.km, sicherheit: a.sicherheit, weg: a.weg, zahlen });
    const nurTrip = zahlen.length && zahlen.every(z => z.art !== 'gesamt') && zahlen.some(z => z.art === 'tageszaehler');
    return res.status(200).json({ ok: true, lesbar: false, km: null, sicherheit: x.sicherheit || null, grund: GRUENDE.includes(x.grund) ? x.grund : (nurTrip ? 'tageszaehler' : 'andere'), zahlen });
  } catch (e) {
    return res.status(502).json({ error: 'Claude API nicht erreichbar' });
  }
};
