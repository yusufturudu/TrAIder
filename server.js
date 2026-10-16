// TrAIder yerel sunucu
// - index.html'i sunar
// - .env içindeki OPENROUTER_API_KEY / GEMINI_API_KEY'i okur (anahtar tarayıcıya hiç gitmez)
// - /api/chat isteğini yapay zekaya (OpenRouter veya Gemini) iletir
// - Veritabanı (PostgreSQL): hesaplar, portföy, alarmlar, sohbet hafızası, fiyat geçmişi  →  db.js
// - /api/n8n/*: n8n otomasyonlarının çağırdığı uç noktalar
// - /api/report: günün haberlerini Google'da arayıp PDF raporu için özet hazırlar
// Çalıştırma: node server.js   (Node 18+ gerekir, ek paket yok)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- .env dosyasını oku ---
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
}
loadEnv();
const db = require('./db');
const reportPdf = require('./report-pdf');

const PORT = process.env.PORT || 3000;

// ---------- YAPAY ZEKA SAĞLAYICISI ----------
// .env'de OPENROUTER_API_KEY varsa OpenRouter, yoksa GEMINI_API_KEY ile Gemini kullanılır.
// OpenRouter key'i yanlışlıkla GEMINI_API_KEY satırına yazılmışsa ("sk-or-" ile başlar) onu da OpenRouter say
const looksOR = k => typeof k === 'string' && k.startsWith('sk-or-');
const OR_KEY = process.env.OPENROUTER_API_KEY || (looksOR(process.env.GEMINI_API_KEY) ? process.env.GEMINI_API_KEY : undefined);
const GEMINI_KEY = looksOR(process.env.GEMINI_API_KEY) ? undefined : process.env.GEMINI_API_KEY;
const PROVIDER = OR_KEY ? 'openrouter' : (GEMINI_KEY ? 'gemini' : null);

const list = (v, def) => (v || def).split(',').map(s => s.trim()).filter(Boolean);

// OpenRouter: openrouter/free = o an çalışan ücretsiz bir modele otomatik yönlendirir
const OR_MODELS = list(process.env.OPENROUTER_MODEL, 'openrouter/free')
    .concat(list(process.env.OPENROUTER_FALLBACK_MODELS, ''));

// Gemini: ana model yoğunsa sırayla yedekler denenir
const GEMINI_MODELS = [...new Set(list(process.env.GEMINI_MODEL, 'gemini-flash-lite-latest')
    .concat(list(process.env.GEMINI_FALLBACK_MODELS, 'gemini-2.5-flash-lite,gemini-flash-latest')))];

if (!PROVIDER) {
    console.warn('⚠️  API key bulunamadı. .env dosyasına OPENROUTER_API_KEY=... (veya GEMINI_API_KEY=...) ekle.');
}

function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(new Error('Geçersiz istek')); } });
        req.on('error', reject);
    });
}

const shortMsg = (data) => (data?.error?.message || '').split('\n')[0].slice(0, 160);

// Sağlayıcıdan bağımsız tek fonksiyon.
// contents: [{ role: 'user' | 'model', parts: [{ text }] }]  (sayfadaki format)
// Dönüş: { ok, status, error, text, sources: [{title, uri}], model }
async function aiGenerate({ system, contents, search = false }) {
    if (!PROVIDER) return { ok: false, status: 500, error: '.env dosyasında OPENROUTER_API_KEY veya GEMINI_API_KEY yok.' };
    return PROVIDER === 'openrouter' ? openRouterGenerate({ system, contents, search }) : geminiGenerate({ system, contents, search });
}

async function openRouterGenerate({ system, contents, search }) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    for (const c of contents) {
        messages.push({ role: c.role === 'model' ? 'assistant' : 'user', content: (c.parts || []).map(p => p.text || '').join('') });
    }

    let r, data, model;
    for (model of OR_MODELS) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            const body = { model, messages };
            if (search) body.plugins = [{ id: 'web', max_results: 5 }]; // OpenRouter web araması
            r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OR_KEY}`,
                    'HTTP-Referer': `http://localhost:${PORT}`,
                    'X-Title': 'TrAIder Terminal'
                },
                body: JSON.stringify(body)
            });
            data = await r.json().catch(() => ({}));
            const msg = data.choices?.[0]?.message;

            if (r.ok && msg && !data.error) {
                const sources = [];
                const seen = new Set();
                for (const a of msg.annotations || []) {
                    const u = a.url_citation;
                    if (a.type === 'url_citation' && u?.url && !seen.has(u.url)) {
                        seen.add(u.url);
                        sources.push({ title: u.title || new URL(u.url).hostname, uri: u.url });
                    }
                }
                const used = data.model || model;
                console.log(`🤖 OpenRouter cevap verdi (model: ${used}${search ? ', web araması' : ''})`);
                return { ok: true, status: 200, text: (msg.content || '').trim(), sources, model: used };
            }

            const status = data.error?.code && Number.isInteger(data.error.code) ? data.error.code : (r.ok ? 502 : r.status);
            console.log(`🚫 OpenRouter ${model} hata (${status}): ${shortMsg(data)}`);
            if ([401, 402, 403].includes(status)) return { ok: false, status, error: shortMsg(data) || 'OpenRouter hatası', model };
            if (status === 400) break; // bu modelle olmuyor, sıradakine geç
            if (attempt === 1 && [429, 500, 502, 503].includes(status)) {
                await new Promise(s => setTimeout(s, 2000));
                continue;
            }
            break;
        }
    }
    return { ok: false, status: r?.status || 500, error: shortMsg(data) || 'OpenRouter hatası', model };
}

async function geminiGenerate({ system, contents, search }) {
    const body = {
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        contents,
        tools: search ? [{ google_search: {} }] : undefined
    };
    const payload = JSON.stringify(body);
    let r, data, model;
    for (model of GEMINI_MODELS) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
                body: payload
            });
            data = await r.json().catch(() => ({}));
            if (r.ok) {
                if (model !== GEMINI_MODELS[0]) console.log(`↪️  Yedek model kullanıldı: ${model}`);
                const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
                const sources = [];
                const seen = new Set();
                for (const c of data.candidates?.[0]?.groundingMetadata?.groundingChunks || []) {
                    if (c.web?.uri && !seen.has(c.web.title)) {
                        seen.add(c.web.title);
                        sources.push({ title: c.web.title || c.web.uri, uri: c.web.uri });
                    }
                }
                return { ok: true, status: 200, text, sources, model };
            }
            if (![429, 500, 503].includes(r.status)) return { ok: false, status: r.status, error: shortMsg(data) || 'Gemini API hatası', model };
            if (r.status === 429) { console.log(`🚫 ${model} kota/limit (429): ${shortMsg(data)}`); break; }
            console.log(`⏳ ${model} yoğun (${r.status}), deneme ${attempt}...`);
            await new Promise(s => setTimeout(s, 1500 * attempt));
        }
    }
    return { ok: false, status: r?.status || 500, error: shortMsg(data) || 'Gemini API hatası', model };
}

async function handleChat(req, res) {
    try {
        const body = await readBody(req);
        const user = await db.getUser(req);

        // Giriş yapılmamışsa: eski davranış (geçmiş sadece sayfada tutulur)
        if (!user) {
            const { system, contents } = body;
            if (!Array.isArray(contents) || contents.length === 0) return sendJson(res, 400, { error: 'Mesaj boş.' });
            const g = await aiGenerate({ system, contents });
            if (!g.ok) return sendJson(res, g.status, { error: g.error });
            return sendJson(res, 200, { text: g.text || '(Boş yanıt geldi)' });
        }

        // Giriş yapılmışsa: sohbet veritabanında saklanır, yapay zeka önceki mesajları + özeti görür
        const message = String(body.message || '').trim().slice(0, 4000);
        if (!message) return sendJson(res, 400, { error: 'Mesaj boş.' });
        let convId = parseInt(body.conversationId, 10) || null;

        if (convId) {
            const own = await db.q('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [convId, user.id]);
            if (!own.rows.length) convId = null;
        }
        if (!convId) {
            const title = message.length > 40 ? message.slice(0, 40) + '…' : message;
            convId = (await db.q('INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id', [user.id, title])).rows[0].id;
        }

        const conv = (await db.q('SELECT summary, summarized_upto FROM conversations WHERE id = $1', [convId])).rows[0];
        const hist = (await db.q('SELECT role, content FROM messages WHERE conversation_id = $1 AND id > $2 ORDER BY id', [convId, conv.summarized_upto])).rows;

        // Sistem talimatı + hafıza (özet) + kullanıcının portföyü
        let system = String(body.system || '');
        if (conv.summary) system += `\n\nBu kullanıcıyla bu sohbetin önceki kısmının özeti (hatırla ve buna göre devam et):\n${conv.summary}`;
        const pf = (await db.q('SELECT asset, amount FROM portfolio WHERE user_id = $1', [user.id])).rows;
        if (pf.length) system += `\n\nKullanıcının portföyü: ${pf.map(r => `${(+r.amount)} ${PORTFOLIO_ASSETS[r.asset]?.label || r.asset}`).join(', ')}. Soru portföyle ilgiliyse bunu kullan.`;
        system += `\nKullanıcının adı: ${user.username}.`;

        const contents = hist.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
        const live = String(body.liveData || '');
        contents.push({ role: 'user', parts: [{ text: live ? `${live} Kullanıcı Sorusu: ${message}` : message }] });

        const g = await aiGenerate({ system, contents });
        if (!g.ok) return sendJson(res, g.status, { error: g.error, conversationId: convId });
        const reply = g.text || '(Boş yanıt geldi)';

        // Canlı veri notu olmadan, temiz haliyle kaydet
        await db.q('INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3), ($1, $4, $5)', [convId, 'user', message, 'assistant', reply]);
        await db.q('UPDATE conversations SET updated_at = now() WHERE id = $1', [convId]);
        maybeSummarize(convId).catch(e => console.log('📝 Özetleme hatası:', e.message));

        sendJson(res, 200, { text: reply, conversationId: convId });
    } catch (e) {
        sendJson(res, 500, { error: e.message });
    }
}

// Sohbet uzayınca (24+ özetlenmemiş mesaj) eskilerini özetle; son 12 mesaj aynen kalır.
// Böylece yapay zekaya giden metin kısa kalır ama konuşmanın bağlamı kaybolmaz.
const SUMMARIZE_AFTER = 24, KEEP_RECENT = 12;
const summarizing = new Set();
async function maybeSummarize(convId) {
    if (summarizing.has(convId)) return;
    summarizing.add(convId);
    try {
        const conv = (await db.q('SELECT summary, summarized_upto FROM conversations WHERE id = $1', [convId])).rows[0];
        const rows = (await db.q('SELECT id, role, content FROM messages WHERE conversation_id = $1 AND id > $2 ORDER BY id', [convId, conv.summarized_upto])).rows;
        if (rows.length < SUMMARIZE_AFTER) return;
        const old = rows.slice(0, rows.length - KEEP_RECENT);
        const transcript = old.map(m => `${m.role === 'user' ? 'Kullanıcı' : 'Asistan'}: ${m.content}`).join('\n');
        const prompt = `Bir piyasa asistanı ile kullanıcı arasındaki sohbetin hafızasını güncelle.
${conv.summary ? `Mevcut özet:\n${conv.summary}\n\n` : ''}Yeni mesajlar:\n${transcript}

Görev: Mevcut özeti ve yeni mesajları birleştirerek en fazla 12 maddelik, kısa bir Türkçe özet yaz.
Şunları mutlaka koru: kullanıcının ilgilendiği varlıklar, verdiği bilgiler ve tercihler (ör. risk, hedef, bütçe), sorduğu önemli sorular ve verilen önemli cevaplar/sayılar.
Sadece maddeleri yaz, her madde "- " ile başlasın.`;
        const g = await aiGenerate({ contents: [{ role: 'user', parts: [{ text: prompt }] }] });
        if (!g.ok || !g.text) return;
        await db.q('UPDATE conversations SET summary = $1, summarized_upto = $2 WHERE id = $3', [g.text.slice(0, 6000), old[old.length - 1].id, convId]);
        console.log(`📝 Sohbet #${convId} özetlendi (${old.length} mesaj hafızaya alındı)`);
    } finally {
        summarizing.delete(convId);
    }
}

// PDF raporu: canlı veriler + internette aranan günün haberleri → yapılandırılmış özet
async function handleReport(req, res) {
    try {
        const { marketText, date } = await readBody(req);

        const prompt = `Bugünün tarihi: ${date}.
Elimdeki canlı piyasa verileri:
${marketText || '(veri yok)'}

Görev: İnternette BUGÜN ve son 24 saatte piyasaları etkileyen en önemli haberleri ara (Türkiye ve dünya: TCMB, Fed, enflasyon, faiz, jeopolitik gelişmeler, emtia, kripto, Borsa İstanbul).
Sonra SADECE aşağıdaki JSON'u döndür. Başka hiçbir yazı, açıklama veya \`\`\` ekleme. Türkçe, sade ve net yaz.
{
  "ozet": "Günün piyasa özeti, 3-4 cümle. Yukarıdaki fiyatları kullan.",
  "haberler": [
    { "baslik": "Haber başlığı", "ozet": "1-2 cümle ne oldu", "etki": "Hangi varlığı nasıl etkileyebilir (ör. Altın ↑, TL ↓)", "kaynak": "Haber sitesi adı" }
  ],
  "gorunum": "Kısa vadede dikkat edilmesi gerekenler, 2-3 cümle."
}
haberler listesinde 5-7 haber olsun. Sadece aramada gerçekten bulduğun haberleri yaz, uydurma.`;

        // Önce web aramalı dene
        let searched = true;
        let g = await aiGenerate({ contents: [{ role: 'user', parts: [{ text: prompt }] }], search: true });

        // Arama çalıştı ama hiç kaynak gelmediyse haberler doğrulanamaz → aramasız moda geç
        if (g.ok && g.sources.length === 0) {
            console.log('🔎 Web araması kaynak döndürmedi, haberler doğrulanamıyor.');
            g = { ok: false };
        }
        if (!g.ok) {
            console.log('🔎 Aramalı rapor alınamadı, aramasız deneniyor...');
            searched = false;
            // Arama yoksa haber İSTEME: model haber ve kaynak uydurmasın, sadece fiyatlardan özet çıkarsın
            const noSearchPrompt = `Bugünün tarihi: ${date}.
Elimdeki canlı piyasa verileri:
${marketText || '(veri yok)'}

Sadece bu fiyatlara bakarak kısa bir değerlendirme yap. Haber, olay veya kaynak UYDURMA; bilmediğin gelişmelerden bahsetme.
SADECE şu JSON'u döndür, başka yazı ekleme:
{ "ozet": "Fiyatlara dayalı 3-4 cümlelik özet", "haberler": [], "gorunum": "Fiyat hareketlerine göre dikkat edilecekler, 2-3 cümle" }`;
            g = await aiGenerate({ contents: [{ role: 'user', parts: [{ text: noSearchPrompt }] }] });
        }
        if (!g.ok) return sendJson(res, g.status || 500, { error: g.error || 'Yapay zeka hatası' });

        const raw = g.text || '';
        let report;
        try {
            report = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
        } catch {
            report = { ozet: raw, haberler: [], gorunum: '' };
        }

        if (!searched) report.haberler = []; // güvenlik: arama yoksa haber gösterme
        sendJson(res, 200, { ...report, sources: searched ? g.sources : [], searched, model: g.model });
    } catch (e) {
        sendJson(res, 500, { error: e.message });
    }
}

// ---------- HABERLER SEKMESİ ----------
// Web aramasıyla günün haberlerini derler. Kredi harcamamak için 10 dakika önbellekte tutar.
let newsCache = { at: 0, data: null };
const NEWS_TTL = 10 * 60 * 1000;

async function handleNews(req, res) {
    try {
        const force = req.url.includes('refresh=1');
        if (!force && newsCache.data && Date.now() - newsCache.at < NEWS_TTL) {
            return sendJson(res, 200, newsCache.data);
        }

        const date = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
        const prompt = `Bugünün tarihi: ${date}.
İnternette son 24 saatte finansal piyasaları etkileyen en önemli haberleri ara.
Konular: Türkiye (TCMB, enflasyon, Borsa İstanbul, TL), dünya (Fed, ABD verileri, Avrupa, Çin, jeopolitik), kripto paralar, emtia (altın, petrol), döviz.
SADECE aşağıdaki JSON'u döndür, başka yazı veya \`\`\` ekleme. Türkçe, sade yaz.
{
  "haberler": [
    { "kategori": "Türkiye | Dünya | Kripto | Emtia | Döviz (birini seç)", "baslik": "Haber başlığı", "ozet": "2-3 cümle ne oldu", "etki": "Hangi varlığı nasıl etkileyebilir (ör. Altın ↑, TL ↓)", "kaynak": "Haber sitesi adı" }
  ]
}
8-10 haber olsun, en önemliden başla. Sadece aramada gerçekten bulduğun haberleri yaz, uydurma.`;

        const g = await aiGenerate({ contents: [{ role: 'user', parts: [{ text: prompt }] }], search: true });
        if (!g.ok) return sendJson(res, g.status || 500, { error: `Haber araması yapılamadı: ${g.error || 'bilinmeyen hata'}` });
        if (!g.sources.length) {
            // Kaynak yoksa haberlerin gerçekliği doğrulanamaz → göstermiyoruz
            return sendJson(res, 502, { error: 'Web araması kaynak döndürmedi, haberler doğrulanamadı.' });
        }

        let parsed;
        try {
            const raw = g.text || '';
            parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
        } catch {
            return sendJson(res, 502, { error: 'Yapay zekanın cevabı okunamadı, tekrar dene.' });
        }

        const data = {
            haberler: Array.isArray(parsed.haberler) ? parsed.haberler.slice(0, 12) : [],
            sources: g.sources.slice(0, 15),
            model: g.model,
            updatedAt: Date.now()
        };
        newsCache = { at: Date.now(), data };
        console.log(`📰 ${data.haberler.length} haber derlendi (${data.sources.length} kaynak)`);
        sendJson(res, 200, data);
    } catch (e) {
        sendJson(res, 500, { error: e.message });
    }
}

// ---------- PİYASA VERİLERİ (sunucu tarafında çekilir; tarayıcı engellerine takılmaz) ----------
async function getJson(url, timeoutMs = 8000) {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'TrAIder/1.0' } });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
}

// Sırayla dener, ilk çalışanı döndürür
async function firstOk(name, attempts) {
    for (const [label, fn] of attempts) {
        try { return await fn(); } catch (e) {
            // "fetch failed" asıl sebebi saklar; e.cause içindeki kodu da yaz (ör. ENOTFOUND, ECONNRESET, CERT_...)
            const cause = e.cause ? ` → ${e.cause.code || ''} ${e.cause.message || ''}`.trim() : '';
            console.log(`⚠️  ${name}: ${label} çalışmadı (${e.message.slice(0, 80)}${cause ? ' ' + cause.slice(0, 120) : ''})`);
        }
    }
    console.log(`❌ ${name}: hiçbir kaynaktan alınamadı`);
    return null;
}

const BINANCE_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision', 'https://api1.binance.com'];
const CRYPTO = [
    { sym: 'BTCUSDT', name: 'BTC', cg: 'bitcoin' },
    { sym: 'ETHUSDT', name: 'ETH', cg: 'ethereum' },
    { sym: 'SOLUSDT', name: 'SOL', cg: 'solana' },
    { sym: 'XRPUSDT', name: 'XRP', cg: 'ripple' },
    { sym: 'DOGEUSDT', name: 'DOGE', cg: 'dogecoin' },
    { sym: 'ADAUSDT', name: 'ADA', cg: 'cardano' },
    { sym: 'PAXGUSDT', name: 'GOLD', cg: 'pax-gold' }
];

async function fetchTickers() {
    const binance = BINANCE_HOSTS.map(h => [h, async () => {
        const url = `${h}/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(CRYPTO.map(c => c.sym)))}`;
        const list = await getJson(url);
        return Object.fromEntries(list.map(t => [t.symbol, { price: +t.lastPrice, change: +t.priceChangePercent }]));
    }]);
    const coingecko = ['CoinGecko', async () => {
        const d = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${CRYPTO.map(c => c.cg).join(',')}&vs_currencies=usd&include_24hr_change=true`);
        return Object.fromEntries(CRYPTO.filter(c => d[c.cg]).map(c => [c.sym, { price: d[c.cg].usd, change: d[c.cg].usd_24h_change }]));
    }];
    return firstOk('Kripto/altın fiyatları', [...binance, coingecko]);
}

async function fetchFx() {
    return firstOk('Döviz kurları', [
        ['open.er-api.com', async () => (await getJson('https://open.er-api.com/v6/latest/USD')).rates],
        ['Frankfurter', async () => ({ USD: 1, ...(await getJson('https://api.frankfurter.dev/v1/latest?base=USD')).rates })]
    ]);
}

async function fetchKlines(c) {
    const binance = BINANCE_HOSTS.map(h => [h, async () =>
        (await getJson(`${h}/api/v3/klines?symbol=${c.sym}&interval=1d&limit=30`)).map(r => ({ t: r[0], v: +r[4] }))]);
    const coingecko = ['CoinGecko', async () =>
        (await getJson(`https://api.coingecko.com/api/v3/coins/${c.cg}/market_chart?vs_currency=usd&days=30&interval=daily`)).prices.map(([t, v]) => ({ t, v }))];
    return (await firstOk(`${c.name} 30 günlük grafik`, [...binance, coingecko])) || [];
}

async function fetchUsdTryHistory() {
    const from = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
    const conv = d => Object.entries(d.rates || {}).map(([day, r]) => ({ t: new Date(day).getTime(), v: r.TRY })).slice(-30);
    return (await firstOk('USD/TRY 30 günlük grafik', [
        ['frankfurter.dev', async () => conv(await getJson(`https://api.frankfurter.dev/v1/${from}..?base=USD&symbols=TRY`))],
        ['frankfurter.app', async () => conv(await getJson(`https://api.frankfurter.app/${from}..?from=USD&to=TRY`))]
    ])) || [];
}

let marketCache = { at: 0, data: null };

// Anlık fiyat özeti (döviz, altın, kripto). 20 sn önbellek.
async function getSnapshot() {
    if (!marketCache.data || Date.now() - marketCache.at > 20000) {
        const [rates, tickers] = await Promise.all([fetchFx(), fetchTickers()]);
        marketCache = { at: Date.now(), data: { rates, tickers } };
    }
    const { rates, tickers } = marketCache.data;
    const snap = { fx: [], metals: [], crypto: [], usdTry: 0 };

    if (rates && rates.TRY) {
        const t = rates.TRY;
        snap.usdTry = t;
        snap.fx.push({ name: 'USD/TRY', value: t });
        if (rates.EUR) snap.fx.push({ name: 'EUR/TRY', value: t / rates.EUR });
        if (rates.GBP) snap.fx.push({ name: 'GBP/TRY', value: t / rates.GBP });
        if (rates.CHF) snap.fx.push({ name: 'CHF/TRY', value: t / rates.CHF });
        if (rates.CAD) snap.fx.push({ name: 'CAD/TRY', value: t / rates.CAD });
        if (rates.JPY) snap.fx.push({ name: '100 JPY/TRY', value: (t / rates.JPY) * 100 });
    }
    if (tickers) {
        const g = tickers.PAXGUSDT;
        if (g) {
            snap.metals.push({ name: 'Ons Altın', value: g.price, unit: '$', change: g.change });
            if (snap.usdTry) {
                const gram = (g.price / 31.1035) * snap.usdTry;
                snap.metals.push({ name: 'Gram Altın', value: gram, unit: '₺', change: g.change });
                snap.metals.push({ name: 'Çeyrek Altın', value: gram * 1.635, unit: '₺', change: g.change });
                const gumusOns = g.price / 82; // altın/gümüş oranıyla tahmini
                snap.metals.push({ name: 'Gümüş Ons (tahmini)', value: gumusOns, unit: '$' });
                snap.metals.push({ name: 'Gram Gümüş (tahmini)', value: (gumusOns / 31.1035) * snap.usdTry, unit: '₺' });
            }
        }
        for (const c of CRYPTO) {
            if (c.sym !== 'PAXGUSDT' && tickers[c.sym]) snap.crypto.push({ name: c.name, value: tickers[c.sym].price, unit: '$', change: tickers[c.sym].change });
        }
    }
    return snap;
}

// Portföy ve alarmlarda kullanılabilen varlıklar.
// price: varlığın kendi birimindeki fiyatı (alarm hedefi bu birimde), tryValue: 1 adedinin TL karşılığı
const PORTFOLIO_ASSETS = {
    BTC: { label: 'Bitcoin (BTC)', unit: '$' }, ETH: { label: 'Ethereum (ETH)', unit: '$' }, SOL: { label: 'Solana (SOL)', unit: '$' },
    XRP: { label: 'XRP', unit: '$' }, DOGE: { label: 'Dogecoin (DOGE)', unit: '$' }, ADA: { label: 'Cardano (ADA)', unit: '$' },
    GOLD: { label: 'Ons Altın', unit: '$' }, GAU: { label: 'Gram Altın', unit: '₺' }, CEYREK: { label: 'Çeyrek Altın', unit: '₺' },
    USD: { label: 'Amerikan Doları', unit: '₺' }, EUR: { label: 'Euro', unit: '₺' }, GBP: { label: 'İngiliz Sterlini', unit: '₺' }
};

function priceTable(snap) {
    const t = {};
    const usd = snap.usdTry;
    for (const c of snap.crypto) if (PORTFOLIO_ASSETS[c.name] && usd) t[c.name] = { price: c.value, tryValue: c.value * usd, change: c.change };
    const m = n => snap.metals.find(x => x.name === n);
    if (m('Ons Altın') && usd) t.GOLD = { price: m('Ons Altın').value, tryValue: m('Ons Altın').value * usd, change: m('Ons Altın').change };
    if (m('Gram Altın')) t.GAU = { price: m('Gram Altın').value, tryValue: m('Gram Altın').value, change: m('Gram Altın').change };
    if (m('Çeyrek Altın')) t.CEYREK = { price: m('Çeyrek Altın').value, tryValue: m('Çeyrek Altın').value, change: m('Çeyrek Altın').change };
    const fx = n => snap.fx.find(x => x.name === n);
    if (fx('USD/TRY')) t.USD = { price: fx('USD/TRY').value, tryValue: fx('USD/TRY').value };
    if (fx('EUR/TRY')) t.EUR = { price: fx('EUR/TRY').value, tryValue: fx('EUR/TRY').value };
    if (fx('GBP/TRY')) t.GBP = { price: fx('GBP/TRY').value, tryValue: fx('GBP/TRY').value };
    return t;
}

// 30 günlük grafik verisi (PDF raporlarında kullanılır)
async function getHistory() {
    const pick = s => CRYPTO.find(c => c.sym === s);
    const [btc, eth, gold, usdtry] = await Promise.all([
        fetchKlines(pick('BTCUSDT')), fetchKlines(pick('ETHUSDT')), fetchKlines(pick('PAXGUSDT')), fetchUsdTryHistory()
    ]);
    const history = [
        { title: 'Bitcoin (BTC)', unit: '$', color: '#f59e0b', data: btc },
        { title: 'Ethereum (ETH)', unit: '$', color: '#6366f1', data: eth },
        { title: 'Ons Altın', unit: '$', color: '#ca8a04', data: gold },
        { title: 'USD/TRY', unit: '₺', color: '#2563eb', data: usdtry }
    ].filter(h => h.data.length > 1);
    console.log(`📈 Grafik verisi: ${history.map(h => h.title).join(', ') || 'YOK'}`);
    return history;
}

async function handleMarket(req, res) {
    try {
        const wantHistory = req.url.includes('history=1');
        const snap = await getSnapshot();

        const history = wantHistory ? await getHistory() : [];
        sendJson(res, 200, { snap, history });
    } catch (e) {
        sendJson(res, 500, { error: e.message });
    }
}

// ---------- TEKNİK ANALİZ ----------
const TA_ASSETS = {
    BTC: { label: 'Bitcoin (BTC)', unit: '$', sym: 'BTCUSDT', cg: 'bitcoin' },
    ETH: { label: 'Ethereum (ETH)', unit: '$', sym: 'ETHUSDT', cg: 'ethereum' },
    SOL: { label: 'Solana (SOL)', unit: '$', sym: 'SOLUSDT', cg: 'solana' },
    XRP: { label: 'XRP', unit: '$', sym: 'XRPUSDT', cg: 'ripple' },
    DOGE: { label: 'Dogecoin (DOGE)', unit: '$', sym: 'DOGEUSDT', cg: 'dogecoin' },
    ADA: { label: 'Cardano (ADA)', unit: '$', sym: 'ADAUSDT', cg: 'cardano' },
    GOLD: { label: 'Ons Altın', unit: '$', sym: 'PAXGUSDT', cg: 'pax-gold' },
    USDTRY: { label: 'USD/TRY', unit: '₺', fx: 'USD' }
};

// Frankfurter'ın desteklediği dövizler (TL karşısında analiz edilebilir)
const FX_NAMES = {
    USD: 'Amerikan Doları', EUR: 'Euro', GBP: 'İngiliz Sterlini', CHF: 'İsviçre Frangı', JPY: 'Japon Yeni', CAD: 'Kanada Doları',
    AUD: 'Avustralya Doları', CNY: 'Çin Yuanı', SEK: 'İsveç Kronu', NOK: 'Norveç Kronu', DKK: 'Danimarka Kronu', PLN: 'Polonya Zlotisi',
    HUF: 'Macar Forinti', CZK: 'Çek Korunası', RON: 'Romen Leyi', BGN: 'Bulgar Levası', INR: 'Hindistan Rupisi', KRW: 'Güney Kore Wonu',
    MXN: 'Meksika Pesosu', BRL: 'Brezilya Reali', ZAR: 'Güney Afrika Randı', HKD: 'Hong Kong Doları', SGD: 'Singapur Doları',
    NZD: 'Yeni Zelanda Doları', ILS: 'İsrail Şekeli', IDR: 'Endonezya Rupisi', MYR: 'Malezya Ringgiti', PHP: 'Filipin Pesosu', THB: 'Tayland Bahtı', ISK: 'İzlanda Kronu'
};

// "BTC", "GOLD", "FX:EUR" veya herhangi bir Binance "XXXUSDT" sembolünü analiz edilebilir varlığa çevirir
function resolveAsset(key) {
    if (TA_ASSETS[key]) return TA_ASSETS[key];
    let m = key.match(/^FX:([A-Z]{3})$/);
    if (m && FX_NAMES[m[1]]) return { label: `${m[1]}/TRY (${FX_NAMES[m[1]]})`, unit: '₺', fx: m[1] };
    m = key.match(/^([A-Z0-9]{2,20})USDT$/);
    if (m) return { label: `${m[1]} (${m[1]}/USDT)`, unit: '$', sym: key };
    return null;
}

// Günlük mumlar: { t, o, h, l, c }  (bazı kaynaklarda sadece kapanış var; o zaman h=l=c)
async function fetchCandles(a, days = 220) {
    if (a.fx) {
        const from = new Date(Date.now() - days * 1.5 * 864e5).toISOString().slice(0, 10);
        const conv = d => Object.entries(d.rates || {}).map(([day, r]) => { const v = r.TRY; return { t: new Date(day).getTime(), o: v, h: v, l: v, c: v }; });
        return (await firstOk(`${a.label} geçmiş veri`, [
            ['frankfurter.dev', async () => conv(await getJson(`https://api.frankfurter.dev/v1/${from}..?base=${a.fx}&symbols=TRY`))],
            ['frankfurter.app', async () => conv(await getJson(`https://api.frankfurter.app/${from}..?from=${a.fx}&to=TRY`))]
        ])) || [];
    }
    const binance = BINANCE_HOSTS.map(h => [h, async () =>
        (await getJson(`${h}/api/v3/klines?symbol=${a.sym}&interval=1d&limit=${days}`)).map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] }))]);
    const coingecko = a.cg ? [['CoinGecko', async () =>
        (await getJson(`https://api.coingecko.com/api/v3/coins/${a.cg}/market_chart?vs_currency=usd&days=${days}&interval=daily`))
            .prices.map(([t, v]) => ({ t, o: v, h: v, l: v, c: v }))]] : [];
    return (await firstOk(`${a.label} geçmiş veri`, [...binance, ...coingecko])) || [];
}

// --- Gösterge hesapları (hepsi kapanış fiyatları dizisi üzerinden) ---
const sma = (arr, n) => arr.map((_, i) => i < n - 1 ? null : arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);
function ema(arr, n) {
    const k = 2 / (n + 1), out = [];
    let prev = null;
    arr.forEach((v, i) => {
        if (i < n - 1) return out.push(null);
        prev = prev === null ? arr.slice(0, n).reduce((a, b) => a + b, 0) / n : v * k + prev * (1 - k);
        out.push(prev);
    });
    return out;
}
function rsi(arr, n = 14) {
    const out = Array(arr.length).fill(null);
    if (arr.length <= n) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n; i++) { const d = arr[i] - arr[i - 1]; d >= 0 ? gain += d : loss -= d; }
    gain /= n; loss /= n;
    out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = n + 1; i < arr.length; i++) {           // Wilder yumuşatması
        const d = arr[i] - arr[i - 1];
        gain = (gain * (n - 1) + Math.max(d, 0)) / n;
        loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
}
function macd(arr) {
    const e12 = ema(arr, 12), e26 = ema(arr, 26);
    const line = arr.map((_, i) => e12[i] !== null && e26[i] !== null ? e12[i] - e26[i] : null);
    const valid = line.filter(v => v !== null);
    const sigValid = ema(valid, 9);
    const offset = line.length - valid.length;
    const signal = line.map((_, i) => i < offset ? null : sigValid[i - offset]);
    return { line, signal, hist: line.map((v, i) => v !== null && signal[i] !== null ? v - signal[i] : null) };
}
function bollinger(arr, n = 20, k = 2) {
    const mid = sma(arr, n);
    const upper = [], lower = [];
    arr.forEach((_, i) => {
        if (mid[i] === null) { upper.push(null); lower.push(null); return; }
        const slice = arr.slice(i - n + 1, i + 1);
        const sd = Math.sqrt(slice.reduce((a, v) => a + (v - mid[i]) ** 2, 0) / n);
        upper.push(mid[i] + k * sd); lower.push(mid[i] - k * sd);
    });
    return { mid, upper, lower };
}

function analyze(candles) {
    const closes = candles.map(c => c.c);
    const n = closes.length, last = closes[n - 1];
    const pct = (a, b) => b ? ((a - b) / b) * 100 : null;
    const at = (arr) => arr[arr.length - 1];

    const s20 = sma(closes, 20), s50 = sma(closes, 50), s200 = sma(closes, 200);
    const r = rsi(closes), m = macd(closes), bb = bollinger(closes);

    // Pivot noktaları (önceki günün yüksek/düşük/kapanışı)
    const prev = candles[n - 2] || candles[n - 1];
    const P = (prev.h + prev.l + prev.c) / 3;
    const pivots = { P, R1: 2 * P - prev.l, S1: 2 * P - prev.h, R2: P + (prev.h - prev.l), S2: P - (prev.h - prev.l) };
    const hasHL = candles.slice(-30).some(c => c.h !== c.l);

    // 30 günlük en düşük/en yüksek = güçlü destek/direnç
    const last30 = candles.slice(-30);
    const support30 = Math.min(...last30.map(c => c.l));
    const resistance30 = Math.max(...last30.map(c => c.h));

    // Günlük oynaklık (son 30 günün getiri standart sapması)
    const rets = closes.slice(-31).map((v, i, a) => i ? (v - a[i - 1]) / a[i - 1] : null).filter(v => v !== null);
    const meanR = rets.reduce((a, b) => a + b, 0) / rets.length;
    const vol = Math.sqrt(rets.reduce((a, v) => a + (v - meanR) ** 2, 0) / rets.length) * 100;

    // Sinyaller: her biri +1 (pozitif), -1 (negatif) veya 0
    const signals = [];
    const add = (name, score, text) => signals.push({ name, score, text });
    if (at(s20)) add('SMA 20', last > at(s20) ? 1 : -1, last > at(s20) ? 'Fiyat 20 günlük ortalamanın üstünde' : 'Fiyat 20 günlük ortalamanın altında');
    if (at(s50)) add('SMA 50', last > at(s50) ? 1 : -1, last > at(s50) ? 'Fiyat 50 günlük ortalamanın üstünde' : 'Fiyat 50 günlük ortalamanın altında');
    if (at(s200)) add('SMA 200', last > at(s200) ? 1 : -1, last > at(s200) ? 'Uzun vadeli trend yukarı (200 günlük üstünde)' : 'Uzun vadeli trend aşağı (200 günlük altında)');
    const rv = at(r);
    if (rv !== null) add('RSI 14', rv < 30 ? 1 : rv > 70 ? -1 : 0, rv < 30 ? 'Aşırı satılmış bölgede (tepki yükselişi gelebilir)' : rv > 70 ? 'Aşırı alınmış bölgede (düzeltme gelebilir)' : 'Nötr bölgede');
    if (at(m.signal) !== null) add('MACD', at(m.line) > at(m.signal) ? 1 : -1, at(m.line) > at(m.signal) ? 'MACD sinyal çizgisinin üstünde (yukarı ivme)' : 'MACD sinyal çizgisinin altında (aşağı ivme)');
    if (at(bb.upper) !== null) add('Bollinger', last < at(bb.lower) ? 1 : last > at(bb.upper) ? -1 : 0, last < at(bb.lower) ? 'Fiyat alt bandın altında (aşırı düşüş)' : last > at(bb.upper) ? 'Fiyat üst bandın üstünde (aşırı yükseliş)' : 'Fiyat bantların içinde');

    const score = signals.reduce((a, s) => a + s.score, 0);
    const verdict = score >= 2 ? 'Pozitif' : score <= -2 ? 'Negatif' : 'Nötr';

    const tail = 90; // grafikte son 90 gün
    const sliceT = arr => arr.slice(-tail);
    return {
        last,
        change: { d1: pct(last, closes[n - 2]), d7: pct(last, closes[n - 8]), d30: pct(last, closes[n - 31]) },
        sma: { s20: at(s20), s50: at(s50), s200: at(s200) },
        rsi: rv,
        macd: { line: at(m.line), signal: at(m.signal), hist: at(m.hist) },
        bollinger: { upper: at(bb.upper), mid: at(bb.mid), lower: at(bb.lower) },
        pivots: hasHL ? pivots : null,
        support30, resistance30,
        volatility: vol,
        signals, score, verdict,
        chart: {
            t: sliceT(candles.map(c => c.t)), close: sliceT(closes),
            s20: sliceT(s20), s50: sliceT(s50), bbU: sliceT(bb.upper), bbL: sliceT(bb.lower), rsi: sliceT(r)
        },
        days: n
    };
}

const taCache = {};
async function handleAnalysis(req, res) {
    try {
        const key = (new URL(req.url, 'http://x').searchParams.get('asset') || 'BTC').toUpperCase();
        const asset = resolveAsset(key);
        if (!asset) return sendJson(res, 400, { error: 'Bilinmeyen varlık' });
        if (taCache[key] && Date.now() - taCache[key].at < 5 * 60 * 1000) return sendJson(res, 200, taCache[key].data);

        const candles = await fetchCandles(asset);
        if (candles.length < 35) return sendJson(res, 502, { error: candles.length
            ? `Bu varlığın geçmişi çok kısa (${candles.length} gün). Analiz için en az 35 gün gerekiyor.`
            : 'Geçmiş veri alınamadı. Sembol yanlış olabilir ya da internet bağlantını kontrol et.' });

        const data = { asset: key, label: asset.label, unit: asset.unit, ...analyze(candles), updatedAt: Date.now() };
        taCache[key] = { at: Date.now(), data };
        console.log(`📊 Teknik analiz: ${data.label} (${data.days} gün, görünüm: ${data.verdict})`);
        sendJson(res, 200, data);
    } catch (e) {
        sendJson(res, 500, { error: e.message });
    }
}

// Göstergeleri yapay zekaya sade dille yorumlatır (web araması yok → ücretsiz)
async function handleAnalysisAI(req, res) {
    try {
        const { summary } = await readBody(req);
        const prompt = `Aşağıda bir varlığın günlük teknik göstergeleri var. Bunları lise öğrencisinin anlayacağı sade bir Türkçeyle yorumla.
Kurallar: 4-6 kısa madde yaz. Her madde "• " ile başlasın. Sadece verilen sayıları kullan, haber veya olay uydurma.
Son maddede kısa vadede izlenecek seviyeleri (destek/direnç) söyle. "Al" veya "sat" deme; bunun yatırım tavsiyesi olmadığını hatırlat.

${summary}`;
        const g = await aiGenerate({ contents: [{ role: 'user', parts: [{ text: prompt }] }] });
        if (!g.ok) return sendJson(res, g.status || 500, { error: g.error });
        sendJson(res, 200, { text: g.text });
    } catch (e) {
        sendJson(res, 500, { error: e.message });
    }
}

// Arama çubuğu için varlık listesi: hazır varlıklar + dövizler + Binance'teki tüm USDT çiftleri (1 saat önbellek)
const COIN_NAMES = {
    BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', XRP: 'Ripple', DOGE: 'Dogecoin', ADA: 'Cardano', BNB: 'Binance Coin', TRX: 'Tron',
    AVAX: 'Avalanche', DOT: 'Polkadot', LINK: 'Chainlink', LTC: 'Litecoin', SHIB: 'Shiba Inu', PEPE: 'Pepe', TON: 'Toncoin',
    SUI: 'Sui', APT: 'Aptos', ARB: 'Arbitrum', OP: 'Optimism', NEAR: 'Near', ATOM: 'Cosmos', UNI: 'Uniswap', AAVE: 'Aave',
    FET: 'Fetch.ai', RENDER: 'Render', INJ: 'Injective', HBAR: 'Hedera', XLM: 'Stellar', BCH: 'Bitcoin Cash', ETC: 'Ethereum Classic',
    FIL: 'Filecoin', ICP: 'Internet Computer', WIF: 'dogwifhat', BONK: 'Bonk', TRUMP: 'Trump', SEI: 'Sei', TIA: 'Celestia'
};
const POPULAR = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'ADA', 'TRX', 'AVAX', 'LINK', 'DOT', 'LTC', 'SHIB', 'TON', 'SUI', 'PEPE'];
let symbolsCache = { at: 0, data: null };

async function handleSymbols(req, res) {
    try {
        if (symbolsCache.data && Date.now() - symbolsCache.at < 60 * 60 * 1000) return sendJson(res, 200, symbolsCache.data);

        const items = [
            { id: 'GOLD', label: 'Ons Altın', type: 'Emtia', keywords: 'altın gold xau ons paxg' },
            ...Object.entries(FX_NAMES).map(([c, name]) => ({
                id: c === 'USD' ? 'USDTRY' : `FX:${c}`, label: `${c}/TRY`, name, type: 'Döviz',
                keywords: `${c} ${name} ${c === 'USD' ? 'dolar' : ''} ${c === 'EUR' ? 'avro' : ''} ${c === 'GBP' ? 'sterlin pound' : ''} ${c === 'JPY' ? 'yen' : ''}`.toLowerCase()
            }))
        ];

        const all = await firstOk('Kripto sembol listesi', BINANCE_HOSTS.map(h => [h, async () => getJson(`${h}/api/v3/ticker/price`, 12000)]));
        const bases = new Set();
        if (Array.isArray(all)) {
            for (const t of all) {
                const m = t.symbol.match(/^([A-Z0-9]{2,20})USDT$/);
                // kaldıraçlı tokenları (BTCUP/BTCDOWN vb.) ve stabil coinleri atla
                if (m && !/(UP|DOWN|BULL|BEAR)$/.test(m[1]) && !['USDC', 'FDUSD', 'TUSD', 'BUSD', 'USDP', 'DAI', 'EUR', 'TRY'].includes(m[1])) bases.add(m[1]);
            }
        } else {
            POPULAR.forEach(b => bases.add(b)); // liste alınamazsa en azından popülerler
        }
        const coins = [...bases].sort((a, b) => {
            const pa = POPULAR.indexOf(a), pb = POPULAR.indexOf(b);
            if (pa !== -1 || pb !== -1) return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
            return a.localeCompare(b);
        }).map(b => ({
            id: TA_ASSETS[b] ? b : `${b}USDT`, label: b, name: COIN_NAMES[b] || '', type: 'Kripto',
            keywords: `${b} ${COIN_NAMES[b] || ''}`.toLowerCase()
        }));

        const data = { items: [...coins.slice(0, POPULAR.length), ...items, ...coins.slice(POPULAR.length)] };
        symbolsCache = { at: Date.now(), data };
        console.log(`🔍 Arama listesi hazır: ${coins.length} kripto, ${items.length} diğer`);
        sendJson(res, 200, data);
    } catch (e) {
        sendJson(res, 500, { error: e.message });
    }
}

// =====================================================================
// HESAP, PORTFÖY, ALARMLAR, SOHBET GEÇMİŞİ (veritabanı gerekir)
// =====================================================================
async function needUser(req, res) {
    if (!db.isReady()) { sendJson(res, 503, { error: db.getError() || 'Veritabanı kapalı.' }); return null; }
    const user = await db.getUser(req);
    if (!user) { sendJson(res, 401, { error: 'Bu özellik için giriş yapmalısın.' }); return null; }
    return user;
}

function sendJsonCookie(res, status, obj, cookie) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': cookie });
    res.end(JSON.stringify(obj));
}

// Basit deneme sınırı: aynı IP'den 10 dakikada en fazla 20 giriş/kayıt denemesi
const authTries = new Map();
function tooManyTries(req) {
    const ip = req.socket.remoteAddress || 'x';
    const now = Date.now();
    const list = (authTries.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
    list.push(now);
    authTries.set(ip, list);
    return list.length > 20;
}

async function handleRegister(req, res) {
    try {
        if (!db.isReady()) return sendJson(res, 503, { error: db.getError() || 'Veritabanı kapalı.' });
        if (tooManyTries(req)) return sendJson(res, 429, { error: 'Çok fazla deneme. 10 dakika sonra tekrar dene.' });
        const { username, password } = await readBody(req);
        const u = String(username || '').trim().toLowerCase();
        if (!/^[a-z0-9_.]{3,24}$/.test(u)) return sendJson(res, 400, { error: 'Kullanıcı adı 3-24 karakter olmalı; harf, rakam, nokta ve alt çizgi kullanabilirsin.' });
        if (String(password || '').length < 6) return sendJson(res, 400, { error: 'Şifre en az 6 karakter olmalı.' });
        const exists = await db.q('SELECT 1 FROM users WHERE username = $1', [u]);
        if (exists.rows.length) return sendJson(res, 409, { error: 'Bu kullanıcı adı alınmış.' });
        const id = (await db.q('INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id', [u, db.hashPassword(String(password))])).rows[0].id;
        const token = await db.createSession(id);
        console.log(`👤 Yeni kullanıcı: ${u}`);
        sendJsonCookie(res, 200, { user: { username: u, telegram_chat_id: null, daily_report: true } }, db.sessionCookie(token));
    } catch (e) { sendJson(res, 500, { error: e.message }); }
}

async function handleLogin(req, res) {
    try {
        if (!db.isReady()) return sendJson(res, 503, { error: db.getError() || 'Veritabanı kapalı.' });
        if (tooManyTries(req)) return sendJson(res, 429, { error: 'Çok fazla deneme. 10 dakika sonra tekrar dene.' });
        const { username, password } = await readBody(req);
        const u = String(username || '').trim().toLowerCase();
        const row = (await db.q('SELECT id, username, password_hash, telegram_chat_id, daily_report FROM users WHERE username = $1', [u])).rows[0];
        if (!row || !db.verifyPassword(String(password || ''), row.password_hash)) return sendJson(res, 401, { error: 'Kullanıcı adı veya şifre yanlış.' });
        const token = await db.createSession(row.id);
        sendJsonCookie(res, 200, { user: { username: row.username, telegram_chat_id: row.telegram_chat_id, daily_report: row.daily_report } }, db.sessionCookie(token));
    } catch (e) { sendJson(res, 500, { error: e.message }); }
}

async function handleLogout(req, res) {
    const token = db.parseCookies(req).traider_sid;
    if (token && db.isReady()) await db.q('DELETE FROM sessions WHERE token = $1', [token]).catch(() => {});
    sendJsonCookie(res, 200, { ok: true }, db.clearCookie);
}

async function handleMe(req, res) {
    const user = await db.getUser(req);
    sendJson(res, 200, {
        user: user ? { username: user.username, telegram_chat_id: user.telegram_chat_id, daily_report: user.daily_report } : null,
        db: db.isReady(), dbError: db.isReady() ? null : db.getError(),
        telegramBot: !!process.env.TELEGRAM_BOT_TOKEN,
        assets: PORTFOLIO_ASSETS
    });
}

async function handleSettings(req, res) {
    const user = await needUser(req, res); if (!user) return;
    try {
        const { telegram_chat_id, daily_report } = await readBody(req);
        const chat = String(telegram_chat_id ?? '').trim();
        if (chat && !/^-?\d{4,20}$/.test(chat)) return sendJson(res, 400, { error: 'Telegram sohbet ID sadece rakamlardan oluşmalı (ör. 123456789).' });
        await db.q('UPDATE users SET telegram_chat_id = $1, daily_report = $2 WHERE id = $3', [chat || null, daily_report !== false, user.id]);
        sendJson(res, 200, { ok: true });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
}

async function sendTelegram(chatId, text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('.env dosyasında TELEGRAM_BOT_TOKEN yok.');
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) throw new Error(d.description || `Telegram hatası (${r.status})`);
}

// Telegram'a dosya (PDF) gönder
async function sendTelegramDocument(chatId, buffer, filename, caption) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('.env dosyasında TELEGRAM_BOT_TOKEN yok.');
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', new Blob([buffer], { type: 'application/pdf' }), filename);
    if (caption) { form.append('caption', caption.slice(0, 1024)); form.append('parse_mode', 'HTML'); }
    const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) throw new Error(d.description || `Telegram hatası (${r.status})`);
}

function readRaw(req, limit = 20 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = []; let size = 0;
        req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Dosya çok büyük.')); req.destroy(); } else chunks.push(c); });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

// Sitedeki "Günlük Rapor (PDF)" butonu: tarayıcıda oluşan PDF'i Telegram'a da gönder
async function handleTelegramPdf(req, res) {
    const user = await needUser(req, res); if (!user) return;
    try {
        if (!user.telegram_chat_id) return sendJson(res, 400, { error: 'Telegram ID kayıtlı değil (Portföy sekmesi).' });
        const buf = await readRaw(req);
        if (buf.length < 100 || buf.slice(0, 4).toString() !== '%PDF') return sendJson(res, 400, { error: 'Geçersiz PDF.' });
        const name = String(req.headers['x-filename'] || 'TrAIder_Rapor.pdf').replace(/[^\w.\-]/g, '_').slice(0, 80);
        await sendTelegramDocument(user.telegram_chat_id, buf, name, '📄 <b>TrAIder Piyasa Raporu</b>');
        console.log(`📨 PDF Telegram'a gönderildi (${user.username}, ${(buf.length / 1024).toFixed(0)} KB)`);
        sendJson(res, 200, { ok: true });
    } catch (e) {
        const hint = /chat not found/i.test(e.message) ? ' (Botuna /start yazman gerekiyor.)' : '';
        sendJson(res, 400, { error: e.message + hint });
    }
}

async function handleTelegramTest(req, res) {
    const user = await needUser(req, res); if (!user) return;
    try {
        if (!user.telegram_chat_id) return sendJson(res, 400, { error: 'Önce Telegram sohbet ID\'ni kaydet.' });
        await sendTelegram(user.telegram_chat_id, `✅ <b>TrAIder</b> bağlantısı çalışıyor, ${escHtml(user.username)}!\nAlarm ve günlük raporlar buraya gelecek.`);
        sendJson(res, 200, { ok: true });
    } catch (e) {
        const hint = /chat not found/i.test(e.message) ? ' (Önce Telegram\'da botuna /start yazman gerekiyor.)' : '';
        sendJson(res, 400, { error: e.message + hint });
    }
}

// --- Portföy ---
async function handlePortfolioGet(req, res) {
    const user = await needUser(req, res); if (!user) return;
    try {
        const rows = (await db.q('SELECT id, asset, amount, cost_try, created_at FROM portfolio WHERE user_id = $1 ORDER BY id', [user.id])).rows;
        const prices = priceTable(await getSnapshot());
        let total = 0, totalCost = 0, costKnown = 0;
        const items = rows.map(r => {
            const p = prices[r.asset];
            const amount = +r.amount, value = p ? amount * p.tryValue : null;
            const cost = r.cost_try === null ? null : +r.cost_try;
            if (value !== null) total += value;
            if (cost !== null && value !== null) { totalCost += cost; costKnown += value; }
            return {
                id: r.id, asset: r.asset, label: PORTFOLIO_ASSETS[r.asset]?.label || r.asset, unit: PORTFOLIO_ASSETS[r.asset]?.unit,
                amount, price: p?.price ?? null, priceTry: p?.tryValue ?? null, change24h: p?.change ?? null,
                value, cost, pnl: cost !== null && value !== null ? value - cost : null,
                pnlPct: cost ? ((value - cost) / cost) * 100 : null
            };
        });
        sendJson(res, 200, { items, total, totalCost, pnl: totalCost ? costKnown - totalCost : null, pnlPct: totalCost ? ((costKnown - totalCost) / totalCost) * 100 : null });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
}

async function handlePortfolioAdd(req, res) {
    const user = await needUser(req, res); if (!user) return;
    try {
        const { asset, amount, cost_try } = await readBody(req);
        if (!PORTFOLIO_ASSETS[asset]) return sendJson(res, 400, { error: 'Geçersiz varlık.' });
        const a = parseFloat(String(amount).replace(',', '.'));
        if (!(a > 0)) return sendJson(res, 400, { error: 'Miktar sıfırdan büyük olmalı.' });
        const c = cost_try === '' || cost_try === null || cost_try === undefined ? null : parseFloat(String(cost_try).replace(',', '.'));
        if (c !== null && !(c >= 0)) return sendJson(res, 400, { error: 'Maliyet geçersiz.' });
        await db.q('INSERT INTO portfolio (user_id, asset, amount, cost_try) VALUES ($1, $2, $3, $4)', [user.id, asset, a, c]);
        sendJson(res, 200, { ok: true });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
}

async function handlePortfolioDelete(req, res, id) {
    const user = await needUser(req, res); if (!user) return;
    await db.q('DELETE FROM portfolio WHERE id = $1 AND user_id = $2', [id, user.id]);
    sendJson(res, 200, { ok: true });
}

// --- Alarmlar ---
async function handleAlertsGet(req, res) {
    const user = await needUser(req, res); if (!user) return;
    try {
        const rows = (await db.q('SELECT id, asset, direction, target, active, created_at, triggered_at, triggered_price FROM alerts WHERE user_id = $1 ORDER BY active DESC, id DESC LIMIT 100', [user.id])).rows;
        const prices = priceTable(await getSnapshot());
        sendJson(res, 200, {
            items: rows.map(r => ({
                ...r, target: +r.target, triggered_price: r.triggered_price === null ? null : +r.triggered_price,
                label: PORTFOLIO_ASSETS[r.asset]?.label || r.asset, unit: PORTFOLIO_ASSETS[r.asset]?.unit || '', current: prices[r.asset]?.price ?? null
            }))
        });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
}

async function handleAlertsAdd(req, res) {
    const user = await needUser(req, res); if (!user) return;
    try {
        const { asset, direction, target } = await readBody(req);
        if (!PORTFOLIO_ASSETS[asset]) return sendJson(res, 400, { error: 'Geçersiz varlık.' });
        if (!['above', 'below'].includes(direction)) return sendJson(res, 400, { error: 'Geçersiz yön.' });
        const t = parseFloat(String(target).replace(',', '.'));
        if (!(t > 0)) return sendJson(res, 400, { error: 'Hedef fiyat sıfırdan büyük olmalı.' });
        const count = (await db.q('SELECT count(*)::int AS n FROM alerts WHERE user_id = $1 AND active', [user.id])).rows[0].n;
        if (count >= 30) return sendJson(res, 400, { error: 'En fazla 30 aktif alarm kurabilirsin.' });
        await db.q('INSERT INTO alerts (user_id, asset, direction, target) VALUES ($1, $2, $3, $4)', [user.id, asset, direction, t]);
        sendJson(res, 200, { ok: true });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
}

async function handleAlertsDelete(req, res, id) {
    const user = await needUser(req, res); if (!user) return;
    await db.q('DELETE FROM alerts WHERE id = $1 AND user_id = $2', [id, user.id]);
    sendJson(res, 200, { ok: true });
}

// --- Sohbet geçmişi ---
async function handleConversations(req, res) {
    const user = await needUser(req, res); if (!user) return;
    const rows = (await db.q(`SELECT c.id, c.title, c.updated_at, (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS count
                              FROM conversations c WHERE c.user_id = $1 ORDER BY c.updated_at DESC LIMIT 50`, [user.id])).rows;
    sendJson(res, 200, { items: rows });
}

async function handleConversationMessages(req, res, id) {
    const user = await needUser(req, res); if (!user) return;
    const own = await db.q('SELECT id, summary FROM conversations WHERE id = $1 AND user_id = $2', [id, user.id]);
    if (!own.rows.length) return sendJson(res, 404, { error: 'Sohbet bulunamadı.' });
    const rows = (await db.q('SELECT role, content, created_at FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 200', [id])).rows.reverse();
    sendJson(res, 200, { items: rows, hasSummary: !!own.rows[0].summary });
}

async function handleConversationDelete(req, res, id) {
    const user = await needUser(req, res); if (!user) return;
    await db.q('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [id, user.id]);
    sendJson(res, 200, { ok: true });
}

// =====================================================================
// n8n UÇ NOKTALARI (n8n zamanlayıcıları bunları çağırır; N8N_SECRET ile korunur)
// =====================================================================
const escHtml = t => String(t ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmtTR = (v, unit = '') => v === null || v === undefined || isNaN(v) ? '—'
    : unit + Number(v).toLocaleString('tr-TR', Math.abs(v) < 1 ? { maximumSignificantDigits: 4 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function n8nAuth(req, res) {
    const secret = process.env.N8N_SECRET;
    if (!secret || secret.startsWith('buraya')) { sendJson(res, 403, { error: '.env dosyasında N8N_SECRET ayarlanmamış.' }); return false; }
    const given = String(req.headers['x-n8n-secret'] || '');
    const a = Buffer.from(given), b = Buffer.from(secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { sendJson(res, 401, { error: 'Geçersiz n8n şifresi.' }); return false; }
    if (!db.isReady()) { sendJson(res, 503, { error: db.getError() || 'Veritabanı kapalı.' }); return false; }
    return true;
}

// 1) Saatlik: fiyatları veritabanına kaydet
async function handleN8nRecordPrices(req, res) {
    if (!n8nAuth(req, res)) return;
    try {
        const prices = priceTable(await getSnapshot());
        const keys = Object.keys(prices);
        if (!keys.length) return sendJson(res, 502, { error: 'Fiyatlar alınamadı.' });
        const values = [], params = [];
        keys.forEach((k, i) => {
            values.push(`($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`);
            params.push(k, prices[k].price, PORTFOLIO_ASSETS[k].unit, prices[k].tryValue);
        });
        await db.q(`INSERT INTO price_history (asset, price, unit, price_try) VALUES ${values.join(',')}`, params);
        console.log(`💾 n8n: ${keys.length} fiyat kaydedildi`);
        sendJson(res, 200, { inserted: keys.length, assets: keys });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// 2) 5 dakikada bir: alarmları kontrol et, tetiklenenleri Telegram mesajı olarak döndür
async function handleN8nCheckAlerts(req, res) {
    if (!n8nAuth(req, res)) return;
    try {
        const alerts = (await db.q(`SELECT a.id, a.asset, a.direction, a.target, u.username, u.telegram_chat_id
                                   FROM alerts a JOIN users u ON u.id = a.user_id WHERE a.active`)).rows;
        if (!alerts.length) return sendJson(res, 200, { checked: 0, triggered: 0, messages: [] });
        const prices = priceTable(await getSnapshot());
        const messages = [];
        let triggered = 0;
        for (const a of alerts) {
            const p = prices[a.asset];
            if (!p) continue;
            const hit = a.direction === 'above' ? p.price >= +a.target : p.price <= +a.target;
            if (!hit) continue;
            const upd = await db.q('UPDATE alerts SET active = FALSE, triggered_at = now(), triggered_price = $1 WHERE id = $2 AND active RETURNING id', [p.price, a.id]);
            if (!upd.rows.length) continue; // başka bir kontrol zaten tetiklemiş
            triggered++;
            const meta = PORTFOLIO_ASSETS[a.asset];
            if (a.telegram_chat_id) messages.push({
                chat_id: a.telegram_chat_id,
                text: `🔔 <b>Fiyat alarmı</b>\n${escHtml(meta.label)} ${a.direction === 'above' ? 'hedefin üstüne çıktı ⬆️' : 'hedefin altına indi ⬇️'}\n\nHedef: ${fmtTR(+a.target, meta.unit)}\nŞu an: <b>${fmtTR(p.price, meta.unit)}</b>`
            });
        }
        if (triggered) console.log(`🔔 n8n: ${triggered} alarm tetiklendi`);
        sendJson(res, 200, { checked: alerts.length, triggered, messages });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
}

// 3) Her sabah: grafikli PDF raporu herkese Telegram'dan gönderilir.
//    PDF gönderilemeyen kişiler için yazı mesajı döndürülür; n8n onları sendMessage ile yollar.
async function handleN8nDailyReport(req, res) {
    if (!n8nAuth(req, res)) return;
    try {
        const users = (await db.q('SELECT id, username, telegram_chat_id FROM users WHERE daily_report AND telegram_chat_id IS NOT NULL')).rows;
        if (!users.length) return sendJson(res, 200, { recipients: 0, pdfSent: 0, messages: [] });

        const now = new Date();
        const snap = await getSnapshot();
        const prices = priceTable(snap);
        const ch = v => typeof v === 'number' && !isNaN(v) ? ` (${v >= 0 ? '▲ +' : '▼ '}${v.toFixed(2)}%)` : '';
        const lines = [
            `💵 Dolar: <b>${fmtTR(prices.USD?.price, '₺')}</b>   💶 Euro: <b>${fmtTR(prices.EUR?.price, '₺')}</b>`,
            `🥇 Gram altın: <b>${fmtTR(prices.GAU?.price, '₺')}</b>${ch(prices.GAU?.change)}`,
            `₿ Bitcoin: <b>${fmtTR(prices.BTC?.price, '$')}</b>${ch(prices.BTC?.change)}`,
            `Ξ Ethereum: <b>${fmtTR(prices.ETH?.price, '$')}</b>${ch(prices.ETH?.change)}`
        ];
        const marketText = lines.join('\n').replace(/<[^>]+>/g, '');

        // Yapay zeka özeti (DAILY_REPORT_NEWS=true ise haber araması da yapar → kredi harcar)
        const withNews = String(process.env.DAILY_REPORT_NEWS).toLowerCase() === 'true';
        const prompt = `Bugünün piyasa verileri:\n${marketText}\n\n` + (withNews
            ? `İnternette son 24 saatin piyasayı etkileyen en önemli 3-5 haberini ara. SADECE şu JSON'u döndür: {"ozet":"2-3 cümle günün özeti","haberler":[{"baslik":"","ozet":"1-2 cümle","etki":"ör. Altın ↑","kaynak":"site adı"}],"gorunum":"2 cümle dikkat edilecekler"}. Türkçe, sade. Uydurma.`
            : `Sadece bu verilere bakarak SADECE şu JSON'u döndür: {"ozet":"3-4 cümlelik sade günlük piyasa özeti","gorunum":"fiyat hareketlerine göre 2 cümle dikkat edilecekler"}. Haber veya olay uydurma.`);
        const g = await aiGenerate({ contents: [{ role: 'user', parts: [{ text: prompt }] }], search: withNews });
        let ai = { ozet: 'Yapay zeka özeti şu an alınamadı.', haberler: [], gorunum: '' };
        if (g.ok && g.text) {
            try { ai = { haberler: [], gorunum: '', ...JSON.parse(g.text.slice(g.text.indexOf('{'), g.text.lastIndexOf('}') + 1)) }; }
            catch { ai.ozet = g.text; }
        }
        const sources = withNews && g.ok ? (g.sources || []) : [];
        if (withNews && !sources.length) ai.haberler = []; // kaynaksız haber gösterme
        if (!withNews) ai.haberler = [];

        const history = reportPdf.isAvailable() ? await getHistory() : [];
        const date = now.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Istanbul' });
        const fileDate = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' });
        const messages = [];
        let pdfSent = 0;

        for (const u of users) {
            // kullanıcının portföyü
            const pf = (await db.q('SELECT asset, amount, cost_try FROM portfolio WHERE user_id = $1', [u.id])).rows;
            let portfolio = null, pfLine = '';
            if (pf.length) {
                let total = 0, cost = 0, costVal = 0;
                const items = pf.map(r => {
                    const v = prices[r.asset] ? +r.amount * prices[r.asset].tryValue : 0;
                    total += v;
                    if (r.cost_try !== null) { cost += +r.cost_try; costVal += v; }
                    return { label: PORTFOLIO_ASSETS[r.asset]?.label || r.asset, amount: +r.amount, value: v };
                });
                portfolio = { total, pnl: cost ? costVal - cost : null, items };
                pfLine = `\n\n💼 Portföyün: <b>${fmtTR(total, '₺')}</b>` + (cost ? ` (${costVal - cost >= 0 ? '+' : ''}${fmtTR(costVal - cost, '₺')})` : '');
            }
            const caption = `☀️ <b>TrAIder Günlük Rapor</b> — ${escHtml(date)}\n\n${lines.join('\n')}${pfLine}`;

            // Önce grafikli PDF'i göndermeyi dene
            if (reportPdf.isAvailable() && process.env.TELEGRAM_BOT_TOKEN) {
                try {
                    const pdf = await reportPdf.buildReportPdf({
                        date: now, snap, history, summary: ai.ozet, outlook: ai.gorunum, news: ai.haberler, sources, portfolio, username: u.username
                    });
                    await sendTelegramDocument(u.telegram_chat_id, pdf, `TrAIder_Gunluk_Rapor_${fileDate}.pdf`, caption);
                    pdfSent++;
                    continue;
                } catch (e) {
                    console.log(`⚠️  ${u.username} için PDF gönderilemedi (${e.message}), yazı olarak gönderilecek.`);
                }
            }
            // Olmazsa yazı mesajı (n8n gönderir)
            messages.push({ chat_id: u.telegram_chat_id, text: `${caption}\n\n🤖 ${escHtml(ai.ozet)}\n\n<i>Yatırım tavsiyesi değildir.</i>` });
        }
        console.log(`☀️ n8n: günlük rapor — ${pdfSent} PDF gönderildi, ${messages.length} yazı mesajı n8n'e bırakıldı`);
        sendJson(res, 200, { recipients: users.length, pdfSent, messages });
    } catch (e) { sendJson(res, 500, { error: e.message }); }
}

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/chat') return handleChat(req, res);
    if (req.method === 'POST' && req.url === '/api/report') return handleReport(req, res);
    if (req.method === 'GET' && req.url.startsWith('/api/market')) return handleMarket(req, res);
    if (req.method === 'GET' && req.url.startsWith('/api/news')) return handleNews(req, res);
    if (req.method === 'GET' && req.url.startsWith('/api/analysis')) return handleAnalysis(req, res);
    if (req.method === 'POST' && req.url === '/api/analysis/ai') return handleAnalysisAI(req, res);
    if (req.method === 'GET' && req.url.startsWith('/api/symbols')) return handleSymbols(req, res);

    // Hesap / portföy / alarm / sohbet geçmişi
    const url = req.url.split('?')[0];
    const idOf = (prefix) => { const m = url.match(new RegExp('^' + prefix + '/(\\d+)$')); return m ? +m[1] : null; };
    if (req.method === 'GET' && url === '/api/me') return handleMe(req, res);
    if (req.method === 'POST' && url === '/api/register') return handleRegister(req, res);
    if (req.method === 'POST' && url === '/api/login') return handleLogin(req, res);
    if (req.method === 'POST' && url === '/api/logout') return handleLogout(req, res);
    if (req.method === 'POST' && url === '/api/settings') return handleSettings(req, res);
    if (req.method === 'POST' && url === '/api/telegram/test') return handleTelegramTest(req, res);
    if (req.method === 'POST' && url === '/api/telegram/pdf') return handleTelegramPdf(req, res);
    if (req.method === 'GET' && url === '/api/portfolio') return handlePortfolioGet(req, res);
    if (req.method === 'POST' && url === '/api/portfolio') return handlePortfolioAdd(req, res);
    if (req.method === 'DELETE' && idOf('/api/portfolio')) return handlePortfolioDelete(req, res, idOf('/api/portfolio'));
    if (req.method === 'GET' && url === '/api/alerts') return handleAlertsGet(req, res);
    if (req.method === 'POST' && url === '/api/alerts') return handleAlertsAdd(req, res);
    if (req.method === 'DELETE' && idOf('/api/alerts')) return handleAlertsDelete(req, res, idOf('/api/alerts'));
    if (req.method === 'GET' && url === '/api/conversations') return handleConversations(req, res);
    if (req.method === 'GET' && idOf('/api/conversations')) return handleConversationMessages(req, res, idOf('/api/conversations'));
    if (req.method === 'DELETE' && idOf('/api/conversations')) return handleConversationDelete(req, res, idOf('/api/conversations'));

    // n8n
    if (req.method === 'POST' && url === '/api/n8n/record-prices') return handleN8nRecordPrices(req, res);
    if (req.method === 'POST' && url === '/api/n8n/check-alerts') return handleN8nCheckAlerts(req, res);
    if (req.method === 'POST' && url === '/api/n8n/daily-report') return handleN8nDailyReport(req, res);

    // Sadece index.html'i sun (.env gibi dosyalar dışarı açılmasın)
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/index.html') || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    }

    res.writeHead(404);
    res.end('Bulunamadı');
});

db.init().then(ok => { if (!ok) db.ensureRetry(); });

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.log(`\n❌ ${PORT} portu zaten kullanılıyor: TrAIder başka bir pencerede hâlâ açık.`);
        console.log('   O pencerede Ctrl + C yap ya da PowerShell\'de şunu çalıştır:');
        console.log(`   Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess -Force\n`);
        process.exit(1);
    }
    throw e;
});

server.listen(PORT, () => {
    console.log(`✅ TrAIder çalışıyor: http://localhost:${PORT}  (yapay zeka: ${PROVIDER === 'openrouter' ? 'OpenRouter, model: ' + OR_MODELS[0] : PROVIDER === 'gemini' ? 'Gemini, model: ' + GEMINI_MODELS[0] : 'API KEY YOK'})`);
});
