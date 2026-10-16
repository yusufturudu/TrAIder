// TrAIder veritabanı katmanı (PostgreSQL)
// - Bağlantı havuzu, tabloların otomatik oluşturulması, giriş/oturum yardımcıları
// - Veritabanı yoksa site yine çalışır; sadece hesap/portföy/alarm/sohbet geçmişi kapalı olur.

const crypto = require('crypto');

let Pool = null;
try { ({ Pool } = require('pg')); } catch { /* npm install yapılmamış */ }

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://traider:traider@localhost:5433/traider';
let pool = null;
let ready = false;
let lastError = '';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    username        TEXT UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    telegram_chat_id TEXT,
    daily_report    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset       TEXT NOT NULL,
    amount      NUMERIC NOT NULL CHECK (amount > 0),
    cost_try    NUMERIC,                -- toplam alış maliyeti (TL), isteğe bağlı
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset           TEXT NOT NULL,
    direction       TEXT NOT NULL CHECK (direction IN ('above', 'below')),
    target          NUMERIC NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    triggered_at    TIMESTAMPTZ,
    triggered_price NUMERIC
);

CREATE TABLE IF NOT EXISTS price_history (
    id          BIGSERIAL PRIMARY KEY,
    asset       TEXT NOT NULL,
    price       NUMERIC NOT NULL,       -- varlığın kendi biriminde (BTC için $, gram altın için ₺)
    unit        TEXT NOT NULL,
    price_try   NUMERIC,                -- TL karşılığı
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_history_asset_time ON price_history (asset, recorded_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title            TEXT NOT NULL DEFAULT 'Yeni sohbet',
    summary          TEXT,               -- eski mesajların yapay zeka özeti (hafıza)
    summarized_upto  BIGINT NOT NULL DEFAULT 0,  -- bu id'ye kadarki mesajlar özete dahil
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
    id               BIGSERIAL PRIMARY KEY,
    conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content          TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages (conversation_id, id);
`;

async function init() {
    if (!Pool) {
        lastError = '"pg" paketi kurulu değil. TrAIder klasöründe "npm install" çalıştır.';
        console.log('🗄️  Veritabanı kapalı: ' + lastError);
        return false;
    }
    try {
        pool = new Pool({ connectionString: DATABASE_URL, max: 5, connectionTimeoutMillis: 4000 });
        pool.on('error', e => console.log('🗄️  Veritabanı bağlantı hatası:', e.message));
        await pool.query(SCHEMA);
        ready = true;
        lastError = '';
        console.log('🗄️  Veritabanı bağlandı ve tablolar hazır.');
        return true;
    } catch (e) {
        ready = false;
        lastError = `Veritabanına bağlanılamadı (${e.code || e.message}). Docker'da PostgreSQL çalışıyor mu? ("docker compose up -d")`;
        console.log('🗄️  ' + lastError);
        if (pool) { pool.end().catch(() => {}); pool = null; }
        return false;
    }
}

// Veritabanı ilk açılışta kapalıysa (ör. Docker sonradan başlatıldıysa) 30 sn'de bir tekrar dene
let retrying = null;
function ensureRetry() {
    if (ready || retrying) return;
    retrying = setInterval(async () => {
        if (await init()) { clearInterval(retrying); retrying = null; }
    }, 30000);
}

const q = (text, params) => pool.query(text, params);
const isReady = () => ready;
const getError = () => lastError;

// ---------- Şifre ve oturum ----------
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
    const [salt, hash] = String(stored).split(':');
    if (!salt || !hash) return false;
    const test = crypto.scryptSync(password, salt, 64);
    const real = Buffer.from(hash, 'hex');
    return real.length === test.length && crypto.timingSafeEqual(real, test);
}

const SESSION_DAYS = 30;

async function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    await q(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [token, userId]);
    q('DELETE FROM sessions WHERE expires_at < now()').catch(() => {}); // eski oturumları temizle
    return token;
}

function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

async function getUser(req) {
    if (!ready) return null;
    const token = parseCookies(req).traider_sid;
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    try {
        const r = await q(
            `SELECT u.id, u.username, u.telegram_chat_id, u.daily_report
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token = $1 AND s.expires_at > now()`, [token]);
        return r.rows[0] || null;
    } catch { return null; }
}

function sessionCookie(token) {
    return `traider_sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
const clearCookie = 'traider_sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0';

module.exports = {
    init, ensureRetry, q, isReady, getError,
    hashPassword, verifyPassword, createSession, getUser, parseCookies, sessionCookie, clearCookie
};
