const express = require('express');
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const bcrypt  = require('bcrypt');
const crypto  = require('crypto');
const { Pool } = require('pg');

// ── PostgreSQL ────────────────────────────────────────────
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDB() {
  if (!pool) {
    console.warn('[DB] DATABASE_URL non impostata — uso file JSON locale');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store (
      key  TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}'
    )
  `);
  await initDocsTable();
  console.log('[DB] PostgreSQL connesso ✓');
}

// ── Rate limiting (in-memory) ─────────────────────────────
const loginAttempts = new Map(); // ip -> { count, blockedUntil }
const MAX_ATTEMPTS  = 5;
const BLOCK_MS      = 15 * 60 * 1000; // 15 minuti

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };
  if (entry.blockedUntil > now) {
    const remaining = Math.ceil((entry.blockedUntil - now) / 60000);
    return { blocked: true, remaining };
  }
  return { blocked: false };
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };
  entry.count++;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.blockedUntil = now + BLOCK_MS;
    entry.count = 0;
    console.warn(`[Auth] IP bloccato per 15 min: ${ip}`);
  }
  loginAttempts.set(ip, entry);
}

function clearAttempts(ip) {
  loginAttempts.delete(ip);
}

// Pulisci entry scadute ogni ora
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts.entries()) {
    if (entry.blockedUntil < now && entry.count === 0) loginAttempts.delete(ip);
  }
}, 60 * 60 * 1000);

// ── Session store (in-memory) ────────────────────────────
const sessions = new Map(); // token -> { username, role, expiresAt }
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 ore

function createSession(username, role) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, role, expiresAt: Date.now() + SESSION_TTL });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { sessions.delete(token); return null; }
  s.expiresAt = Date.now() + SESSION_TTL; // rinnova
  return s;
}

function destroySession(token) {
  sessions.delete(token);
}

// Pulisci sessioni scadute ogni ora
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions.entries()) {
    if (s.expiresAt < now) sessions.delete(token);
  }
}, 60 * 60 * 1000);

// ── Middleware auth ───────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['x-session-token'];
  const s = getSession(token);
  if (!s) return res.status(401).json({ error: 'Non autenticato' });
  req.sessionUser = s;
  next();
}

// ── Helpers dati ──────────────────────────────────────────
const DATA_FILE  = path.join(__dirname, 'data.json');
const USERS_FILE = path.join(__dirname, 'users.json');

const EMPTY_DB = { operai:[], cantieri:[], giornate:[], registrazioni:[], segnalazioni:[], diari:[] };

// Password di default con bcrypt (generate a freddo)
// admin123 e cantiere — cambiarle dalla sezione Impostazioni
const DEFAULT_USERS_PLAIN = [
  { username: 'admin',    password: 'admin123', role: 'admin' },
  { username: 'cantiere', password: 'cantiere', role: 'user'  }
];

let _defaultUsersCache = null;
async function getDefaultUsers() {
  if (_defaultUsersCache) return _defaultUsersCache;
  _defaultUsersCache = await Promise.all(DEFAULT_USERS_PLAIN.map(async u => ({
    username: u.username,
    password: await bcrypt.hash(u.password, 12),
    role: u.role
  })));
  return _defaultUsersCache;
}

async function readData() {
  if (pool) {
    const res = await pool.query("SELECT data FROM store WHERE key='main'");
    const data = res.rows[0] ? res.rows[0].data : null;
    if (data) {
      if (!data.diari) data.diari = [];
      if (!data.segnalazioni) data.segnalazioni = [];
      return data;
    }
    return { ...EMPTY_DB };
  }
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!d.diari) d.diari = [];
    if (!d.segnalazioni) d.segnalazioni = [];
    return d;
  } catch { return { ...EMPTY_DB }; }
}

async function writeData(data) {
  if (pool) {
    await pool.query(
      "INSERT INTO store (key, data) VALUES ('main', $1) ON CONFLICT (key) DO UPDATE SET data=$1",
      [data]
    );
    return;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

async function readUsers() {
  if (pool) {
    const res = await pool.query("SELECT data FROM store WHERE key='users'");
    const users = res.rows[0] ? res.rows[0].data : null;
    if (users && users.length > 0) return users;
  } else {
    try {
      const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      if (data && data.length > 0) return data;
    } catch {}
  }
  return getDefaultUsers();
}

async function writeUsers(users) {
  if (pool) {
    await pool.query(
      "INSERT INTO store (key, data) VALUES ('users', $1) ON CONFLICT (key) DO UPDATE SET data=$1",
      [JSON.stringify(users)]
    );
    return;
  }
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

// ── Upload documenti (in-memory → PostgreSQL) ────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf','image/jpeg','image/png','image/webp',
                     'application/msword',
                     'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// Inizializza tabella documenti
async function initDocsTable() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documenti (
      id          TEXT PRIMARY KEY,
      operaio_id  TEXT NOT NULL,
      name        TEXT NOT NULL,
      mime_type   TEXT,
      size        INTEGER,
      data        TEXT NOT NULL,
      uploaded_at TEXT NOT NULL
    )
  `);
}

// ── App ───────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ── Security headers ──────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));


// ══════════════════════════════════════════════════════════
// AUTH ROUTES (pubbliche)
// ══════════════════════════════════════════════════════════

// Login
app.post('/api/login', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;

  // Rate limit
  const rl = checkRateLimit(ip);
  if (rl.blocked) {
    return res.status(429).json({ error: `Troppi tentativi. Riprova tra ${rl.remaining} minuti.` });
  }

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Credenziali mancanti' });
  }

  try {
    const users = await readUsers();
    const user = users.find(u => u.username === username);

    if (!user) {
      recordFailedAttempt(ip);
      // Esegui bcrypt comunque per non rivelare che l'utente non esiste (timing attack)
      await bcrypt.compare(password, '$2b$12$invalidhashfortimingprotection000000000000000000000');
      return res.status(401).json({ error: 'Credenziali non valide' });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      recordFailedAttempt(ip);
      return res.status(401).json({ error: 'Credenziali non valide' });
    }

    clearAttempts(ip);
    const token = createSession(user.username, user.role);
    console.log(`[Auth] Login: ${user.username} da ${ip}`);

    res.json({ ok: true, token, username: user.username, role: user.role });
  } catch(e) {
    console.error('[Auth] Errore login:', e);
    res.status(500).json({ error: 'Errore server' });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) destroySession(token);
  res.json({ ok: true });
});

// Verifica sessione
app.get('/api/me', (req, res) => {
  const token = req.headers['x-session-token'];
  const s = getSession(token);
  if (!s) return res.status(401).json({ error: 'Non autenticato' });
  res.json({ username: s.username, role: s.role });
});

// ══════════════════════════════════════════════════════════
// API PROTETTE
// ══════════════════════════════════════════════════════════

// DB completo
app.get('/api/data', requireAuth, async (req, res) => {
  try { res.json(await readData()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/data', requireAuth, async (req, res) => {
  try {
    const body = req.body;
    if (!body || (!body.operai && !body.giornate)) return res.status(400).json({ error: 'Dati non validi' });
    if (!body.diari) body.diari = [];
    await writeData(body);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Utenti — solo admin, NON restituisce le password
app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const users = await readUsers();
    // Rimuovi password dalla risposta
    res.json(users.map(u => ({ username: u.username, role: u.role })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Aggiungi utente (solo admin)
app.post('/api/users', requireAuth, async (req, res) => {
  if (req.sessionUser.role !== 'admin') return res.status(403).json({ error: 'Non autorizzato' });
  try {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Dati mancanti' });
    const users = await readUsers();
    if (users.find(u => u.username === username)) return res.status(409).json({ error: 'Username già esistente' });
    const hashed = await bcrypt.hash(password, 12);
    users.push({ username, password: hashed, role: role || 'user' });
    await writeUsers(users);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Elimina utente (solo admin)
app.delete('/api/users/:username', requireAuth, async (req, res) => {
  if (req.sessionUser.role !== 'admin') return res.status(403).json({ error: 'Non autorizzato' });
  if (req.params.username === req.sessionUser.username) return res.status(400).json({ error: 'Non puoi eliminare te stesso' });
  try {
    const users = (await readUsers()).filter(u => u.username !== req.params.username);
    await writeUsers(users);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cambia password
app.post('/api/users/:username/password', requireAuth, async (req, res) => {
  const isAdmin = req.sessionUser.role === 'admin';
  const isSelf  = req.sessionUser.username === req.params.username;
  if (!isAdmin && !isSelf) return res.status(403).json({ error: 'Non autorizzato' });
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password troppo corta (min 6 caratteri)' });
    const users = await readUsers();
    const idx = users.findIndex(u => u.username === req.params.username);
    if (idx === -1) return res.status(404).json({ error: 'Utente non trovato' });
    users[idx].password = await bcrypt.hash(password, 12);
    await writeUsers(users);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Operai
app.get('/api/operai', requireAuth, async (req, res) => {
  try { res.json((await readData()).operai); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/operai', requireAuth, async (req, res) => {
  try {
    const db = await readData();
    const o = { ...req.body, id: 'w' + Math.random().toString(16).slice(2, 10) };
    db.operai.push(o); await writeData(db); res.json(o);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/operai/:id', requireAuth, async (req, res) => {
  try {
    const db = await readData();
    const idx = db.operai.findIndex(o => o.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    db.operai[idx] = { ...db.operai[idx], ...req.body };
    await writeData(db); res.json(db.operai[idx]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/operai/:id', requireAuth, async (req, res) => {
  try {
    const db = await readData();
    db.operai   = db.operai.filter(o => o.id !== req.params.id);
    db.giornate = db.giornate.filter(g => g.operaio !== req.params.id);
    await writeData(db); res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cantieri
app.get('/api/cantieri', requireAuth, async (req, res) => {
  try { res.json((await readData()).cantieri); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/cantieri', requireAuth, async (req, res) => {
  try {
    const db = await readData();
    const c = { ...req.body, id: 'c' + Date.now() };
    db.cantieri.push(c); await writeData(db); res.json(c);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/cantieri/:id', requireAuth, async (req, res) => {
  try {
    const db = await readData();
    const idx = db.cantieri.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    db.cantieri[idx] = { ...db.cantieri[idx], ...req.body };
    await writeData(db); res.json(db.cantieri[idx]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Giornate
app.get('/api/giornate', requireAuth, async (req, res) => {
  try {
    const db = await readData();
    let list = db.giornate;
    if (req.query.data)     list = list.filter(g => g.data === req.query.data);
    if (req.query.cantiere) list = list.filter(g => g.cantiere === req.query.cantiere);
    res.json(list);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/giornate', requireAuth, async (req, res) => {
  try {
    const db = await readData();
    const { data, cantiere, presenze } = req.body;
    db.giornate = db.giornate.filter(g => !(g.data === data && g.cantiere === cantiere));
    const nuove = presenze.map(p => ({
      id: 'g' + Date.now() + Math.random().toString(16).slice(2, 6),
      data, cantiere, operaio: p.operaio, presente: p.presente !== false,
      ore: p.ore || 8, straordinari: p.straordinari || 0,
      motivoTipo: p.motivoTipo || '', motivoNote: p.motivoNote || '', note: p.note || ''
    }));
    db.giornate.push(...nuove); await writeData(db);
    res.json({ ok: true, count: nuove.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Diari
app.get('/api/diari', requireAuth, async (req, res) => {
  try {
    const db = await readData();
    let list = db.diari || [];
    if (req.query.cantiere) list = list.filter(d => d.cantiere === req.query.cantiere);
    res.json(list.map(d => ({ ...d, foto: d.foto ? d.foto.map(() => '[foto]') : [] })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/diari/:id', requireAuth, async (req, res) => {
  try {
    const entry = ((await readData()).diari || []).find(d => d.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json(entry);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/diari', requireAuth, async (req, res) => {
  try {
    const db = await readData();
    const entry = { ...req.body, id: 'd' + Date.now(), ts: new Date().toISOString() };
    db.diari.push(entry); await writeData(db);
    res.json({ ok: true, id: entry.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/diari/:id', requireAuth, async (req, res) => {
  try {
    const db = await readData();
    db.diari = (db.diari || []).filter(d => d.id !== req.params.id);
    await writeData(db); res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Segnalazioni
app.get('/api/segnalazioni', requireAuth, async (req, res) => {
  try { res.json((await readData()).segnalazioni); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/segnalazioni', requireAuth, async (req, res) => {
  try {
    const db = await readData();
    const s = { ...req.body, id: 's' + Date.now(), aperta: true };
    db.segnalazioni.push(s); await writeData(db); res.json(s);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/segnalazioni/:id', requireAuth, async (req, res) => {
  try {
    const db = await readData();
    db.segnalazioni = db.segnalazioni.filter(s => s.id !== req.params.id);
    await writeData(db); res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Documenti operaio — salvati in PostgreSQL
app.get('/api/documenti/:operaioId', requireAuth, async (req, res) => {
  try {
    if (pool) {
      const r = await pool.query(
        'SELECT id, name, size, uploaded_at, mime_type FROM documenti WHERE operaio_id=$1 ORDER BY uploaded_at DESC',
        [req.params.operaioId]
      );
      return res.json(r.rows.map(d => ({
        id: d.id, name: d.name, size: d.size,
        uploadedAt: d.uploaded_at,
        url: `/api/documenti/${req.params.operaioId}/${d.id}/download`
      })));
    }
    res.json([]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/documenti/:operaioId/:docId/download', requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(404).json({ error: 'Non disponibile' });
    const r = await pool.query('SELECT * FROM documenti WHERE id=$1 AND operaio_id=$2', [req.params.docId, req.params.operaioId]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Non trovato' });
    const doc = r.rows[0];
    const buf = Buffer.from(doc.data, 'base64');
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${doc.name}"`);
    res.send(buf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/documenti/:operaioId', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File non valido o troppo grande (max 20MB)' });
  try {
    const id = Date.now() + '_' + Math.random().toString(16).slice(2,8);
    const name = req.file.originalname.replace(/[^a-zA-Z0-9.\-_() àèéìòùÀÈÉÌÒÙ]/g, '_');
    const data = req.file.buffer.toString('base64');
    const now  = new Date().toISOString();
    if (pool) {
      await pool.query(
        'INSERT INTO documenti (id, operaio_id, name, mime_type, size, data, uploaded_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, req.params.operaioId, name, req.file.mimetype, req.file.size, data, now]
      );
    }
    res.json({ ok: true, id, name, size: req.file.size, uploadedAt: now,
      url: `/api/documenti/${req.params.operaioId}/${id}/download` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/documenti/:operaioId/:docId', requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'DB non disponibile' });
    await pool.query('UPDATE documenti SET name=$1 WHERE id=$2 AND operaio_id=$3', [req.body.name, req.params.docId, req.params.operaioId]);
    res.json({ ok: true, id: req.params.docId, name: req.body.name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/documenti/:operaioId/:docId', requireAuth, async (req, res) => {
  try {
    if (pool) await pool.query('DELETE FROM documenti WHERE id=$1 AND operaio_id=$2', [req.params.docId, req.params.operaioId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Catch-all
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Avvio
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  KE·CANTIERE  →  http://localhost:${PORT}\n`);
  });
});
