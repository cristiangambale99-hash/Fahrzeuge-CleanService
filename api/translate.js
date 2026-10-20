// Vercel Serverless Function: /api/translate
// Übersetzt Freitexte der Mitarbeitenden (Beschreibungen, Bemerkungen) automatisch ins Deutsche,
// damit Meldungen, Mails und PDFs für die Verwaltung immer auf Deutsch lesbar sind.
//
// Anbieter:
//   - DeepL, wenn in Vercel die Environment Variable DEEPL_API_KEY gesetzt ist (empfohlen, offizielle API)
//   - sonst Google Translate (frei, ohne Schlüssel)
// Klappt die Übersetzung nicht, gibt die Funktion den Originaltext zurück – die App funktioniert normal weiter.

const MAX_TEXTS = 10;
const MAX_LEN = 2000;

async function viaDeepL(texts, key) {
  const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const body = new URLSearchParams();
  texts.forEach(t => body.append('text', t));
  body.append('target_lang', 'DE');
  const r = await fetch(host + '/v2/translate', {
    method: 'POST',
    headers: { Authorization: 'DeepL-Auth-Key ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!r.ok) throw new Error('DeepL HTTP ' + r.status);
  const j = await r.json();
  return (j.translations || []).map((x, i) => ({ text: x.text || texts[i], src: String(x.detected_source_language || '').toLowerCase() }));
}

async function viaGoogle(text) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=de&dt=t&q=' + encodeURIComponent(text);
  const r = await fetch(url);
  if (!r.ok) throw new Error('Google HTTP ' + r.status);
  const j = await r.json();
  const out = (j[0] || []).map(seg => seg && seg[0] ? seg[0] : '').join('');
  return { text: out || text, src: String(j[2] || '').toLowerCase() };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Nur POST erlaubt' });
  let p = req.body;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { return res.status(400).json({ error: 'Ungültiges JSON' }); } }
  const texts = Array.isArray(p && p.texts) ? p.texts.slice(0, MAX_TEXTS).map(t => String(t || '').slice(0, MAX_LEN)) : [];
  if (!texts.length) return res.status(400).json({ error: 'Keine Texte' });

  const empty = texts.map(t => !t.trim());
  const todo = texts.filter((t, i) => !empty[i]);
  let done = [];
  try {
    const key = process.env.DEEPL_API_KEY;
    if (key) done = await viaDeepL(todo, key);
    else done = await Promise.all(todo.map(viaGoogle));
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message || e), results: texts.map(t => ({ text: t, src: '' })) });
  }
  let k = 0;
  const results = texts.map((t, i) => empty[i] ? { text: t, src: '' } : done[k++]);
  return res.status(200).json({ ok: true, results });
};
