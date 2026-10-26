// Vercel Serverless Function: /api/send-mail
// Versendet die E-Mails der Fahrzeug-App (Tankprotokolle, Fahrzeugmeldungen, Übernahmen/Abgaben, Abschleppungen)
// über Resend, inklusive PDF-Anhang auf Logopapier.
//
// Environment Variables in Vercel (Project → Settings → Environment Variables):
//   RESEND_API_KEY  (Pflicht)  API-Key aus dem Resend-Konto
//   MAIL_FROM       (optional) Standard: "Fahrzeug-App Clean Service <fahrzeuge@clean-service.ch>"
//
// Schutz: Es werden nur Mails an fest hinterlegte Empfänger verschickt – plus an Garagen,
// die in der Verwaltung der Fahrzeug-App bei einem Fahrzeug als Abschlepp-Garage hinterlegt sind
// (diese Angaben kann nur die Verwaltung mit dem Verwaltungscode ändern).

const ERLAUBT = [
  'c08d33f1.clean-service.ch@emea.teams.ms', // Teams-Kanal Tankprotokolle
  '04fbbc5a.clean-service.ch@emea.teams.ms', // Teams-Kanal Infrastruktur (Fahrzeugmeldungen, Abschleppungen)
  '1b6e08b6.clean-service.ch@emea.teams.ms', // Teams-Kanal Übernahmen/Abgaben
  'info@oerlike.ch',                         // Carrosserie
  'info@fegolaautomobile.ch',                // Garage Fegola Automobile
  'buero@garage-gerstl.ch',                  // Garage Gerstl AG
  'info.il@haeusermann.com',                 // Häusermann Automobile AG
  'info@garagemoser.ch'                      // Garage Carrosserie Moser AG
];

const SB_URL = 'https://yjnkaeplhxcsubwqpqkz.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlqbmthZXBsaHhjc3Vid3FwcWt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2MjM5MzAsImV4cCI6MjEwNTE5OTkzMH0.nruDrgHbM2quYxo9MyjhMsDSC5gabTj6aO3R2YXmVZ8'; // öffentlicher Supabase-Schlüssel (nur Lesezugriff über freigegebene Funktionen)
const MAX_PDF_BASE64 = 6 * 1024 * 1024;

let cache = { t: 0, list: [] };
async function garagenAusVerwaltung() {
  if (Date.now() - cache.t < 5 * 60 * 1000) return cache.list;
  try {
    const r = await fetch(SB_URL + '/rest/v1/rpc/fz_vehicles', {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
      body: '{}'
    });
    if (r.ok) {
      const l = await r.json();
      cache = { t: Date.now(), list: (l || []).filter(x => !x.removed && x.data && x.data.garageMail).map(x => String(x.data.garageMail).toLowerCase().trim()) };
    }
  } catch (e) { /* bei Fehler gelten nur die fest hinterlegten Adressen */ }
  return cache.list;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Nur POST erlaubt' });

  const key = process.env.RESEND_API_KEY;
  if (!key) return res.status(500).json({ error: 'RESEND_API_KEY ist in Vercel nicht hinterlegt' });

  let p = req.body;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { return res.status(400).json({ error: 'Ungültiges JSON' }); } }
  if (!p || !p.to || !p.subject || !p.html) return res.status(400).json({ error: 'to, subject und html sind Pflicht' });

  const to = String(p.to).split(/[;,]/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const erlaubt = ERLAUBT.concat(await garagenAusVerwaltung());
  const fremd = to.filter(a => !erlaubt.includes(a));
  if (!to.length || fremd.length) return res.status(403).json({ error: 'Empfänger nicht erlaubt', fremd });

  if (p.attachmentBase64 && String(p.attachmentBase64).length > MAX_PDF_BASE64) return res.status(413).json({ error: 'Anhang zu gross' });

  const payload = {
    from: process.env.MAIL_FROM || 'Fahrzeug-App Clean Service <fahrzeuge@clean-service.ch>',
    to,
    subject: String(p.subject).slice(0, 300),
    html: String(p.html)
  };
  if (p.attachmentBase64) payload.attachments = [{ filename: String(p.attachmentName || 'Protokoll.pdf'), content: String(p.attachmentBase64) }];

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: j.message || ('Resend HTTP ' + r.status) });
    return res.status(200).json({ success: true, id: j.id });
  } catch (e) {
    return res.status(502).json({ error: 'Versanddienst nicht erreichbar' });
  }
};
