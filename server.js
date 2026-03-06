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


// ── Export Excel presenze (ExcelJS formattato) ────────────
app.post('/api/export/presenze', requireAuth, async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const { month, data } = req.body;
    const [year, mon] = month.split('-').map(Number);
    const monthLabel = new Date(year, mon-1, 1).toLocaleDateString('it-IT', {month:'long', year:'numeric'});
    const daysInMonth = new Date(year, mon, 0).getDate();
    const allDays = Array.from({length: daysInMonth}, (_, i) => {
      return `${year}-${String(mon).padStart(2,'0')}-${String(i+1).padStart(2,'0')}`;
    });
    const DOW = ['D','L','M','Me','G','V','S'];
    const operaiAttivi = (data.operai || []).filter(o => o.stato === 'attivo');
    const edili = operaiAttivi.filter(o => o.contratto === 'cassa_edile');
    const metalmeccanici = operaiAttivi.filter(o => o.contratto === 'metalmeccanico');
    const giornate = data.giornate || [];

    function titleCase(s) { return s ? s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : ''; }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'KE Cantiere';

    // ── FOGLIO SINTESI ────────────────────────────────────
    function buildSintesi() {
      const ws = wb.addWorksheet('Sintesi');
      const lista = [...edili, ...metalmeccanici];
      ws.columns = [
        {width:8},{width:34},{width:18},{width:20},
        {width:12},{width:12},{width:12},{width:12},{width:12}
      ];

      // Titolo
      ws.mergeCells('A1:I1');
      const t1 = ws.getCell('A1');
      t1.value = `KE CANTIERE — PRESENZE ${monthLabel.toUpperCase()}`;
      t1.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF0D5C2E'}};
      t1.font = {name:'Calibri',size:14,bold:true,color:{argb:'FFFFFFFF'}};
      t1.alignment = {horizontal:'center',vertical:'middle'};
      ws.getRow(1).height = 30;

      // Sottotitolo
      ws.mergeCells('A2:I2');
      const t2 = ws.getCell('A2');
      t2.value = `Esportato il ${new Date().toLocaleDateString('it-IT')}`;
      t2.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF1A7A3C'}};
      t2.font = {name:'Calibri',size:10,color:{argb:'FFCCFFDD'}};
      t2.alignment = {horizontal:'center',vertical:'middle'};
      ws.getRow(2).height = 16;

      // Riga vuota
      ws.getRow(3).height = 6;

      // Header
      const hdrs = ['Matr.','Nome','Contratto','Mansione','GG Pres.','GG Ass.','Ore Ord.','Straord.','Ore Tot.'];
      const hColors = ['333333','333333','333333','333333','1A7A3C','7A1A1A','0D5C2E','7A4A00','0A4A24'];
      const hRow = ws.getRow(4);
      hRow.height = 22;
      hdrs.forEach((h, i) => {
        const cell = hRow.getCell(i+1);
        cell.value = h;
        cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF'+hColors[i]}};
        cell.font = {name:'Calibri',size:11,bold:true,color:{argb:'FFFFFFFF'}};
        cell.alignment = {horizontal:i<4?'left':'center',vertical:'middle'};
        cell.border = {top:{style:'thin',color:{argb:'FFCCCCCC'}},bottom:{style:'thin',color:{argb:'FFCCCCCC'}},left:{style:'thin',color:{argb:'FFCCCCCC'}},right:{style:'thin',color:{argb:'FFCCCCCC'}}};
      });

      let tP=0,tA=0,tO=0,tS=0;
      lista.forEach((o, i) => {
        const r = ws.getRow(5+i);
        r.height = 20;
        const g = giornate.filter(x => x.operaio === o.id && x.data.startsWith(month));
        const pres = g.filter(x => x.presente);
        const ass  = g.filter(x => !x.presente);
        const oreO = pres.reduce((a,x) => a+(x.ore||0), 0);
        const str  = pres.reduce((a,x) => a+(x.straordinari||0), 0);
        tP+=pres.length; tA+=ass.length; tO+=oreO; tS+=str;
        const bg  = i%2===0 ? 'FFF4FBF7' : 'FFFFFFFF';
        const bgN = i%2===0 ? 'FFEAF7EF' : 'FFF4FBF7';
        const isCE = o.contratto==='cassa_edile';
        const vals = [o.matr||'', titleCase(o.name), isCE?'Cassa Edile':'Metalmeccanico', o.mansione||'', pres.length, ass.length, oreO, str, oreO+str];
        const fgs  = [bg,bg,bg,bg,bgN,bgN,bgN,bgN,bgN];
        const fons = ['888888','111111',isCE?'1A7A3C':'1E40AF','666666', pres.length>0?'155724':'888888', ass.length>0?'B71C1C':'888888','0D5C2E',str>0?'B45309':'888888','0D5C2E'];
        const bolds= [false,true,true,false,pres.length>0,ass.length>0,oreO>0,str>0,true];
        const aligs= ['center','left','left','left','center','center','center','center','center'];
        vals.forEach((v, ci) => {
          const cell = r.getCell(ci+1);
          cell.value = v;
          cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:fgs[ci]}};
          cell.font = {name:'Calibri',size:10,bold:bolds[ci],color:{argb:'FF'+fons[ci]}};
          cell.alignment = {horizontal:aligs[ci],vertical:'middle'};
          cell.border = {top:{style:'thin',color:{argb:'FFDDDDDD'}},bottom:{style:'thin',color:{argb:'FFDDDDDD'}},left:{style:'thin',color:{argb:'FFDDDDDD'}},right:{style:'thin',color:{argb:'FFDDDDDD'}}};
        });
      });

      // Totale
      const rT = ws.getRow(5+lista.length);
      rT.height = 22;
      const totVals = ['','TOTALE','','',tP,tA,tO,tS,tO+tS];
      const totFons = ['FFFFFF','FFFFFF','FFFFFF','FFFFFF','AAFFD0','FFB3B3','AAFFD0',tS>0?'FFD580':'AAFFD0','FFFFFF'];
      totVals.forEach((v, ci) => {
        const cell = rT.getCell(ci+1);
        cell.value = v;
        cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF0D5C2E'}};
        cell.font = {name:'Calibri',size:ci===8?13:12,bold:true,color:{argb:'FF'+totFons[ci]}};
        cell.alignment = {horizontal:ci===1?'left':'center',vertical:'middle'};
        cell.border = {top:{style:'medium',color:{argb:'FF000000'}},bottom:{style:'medium',color:{argb:'FF000000'}},left:{style:'thin',color:{argb:'FFAAAAAA'}},right:{style:'thin',color:{argb:'FFAAAAAA'}}};
      });
    }

    // ── FOGLIO DETTAGLIO ──────────────────────────────────
    function buildDettaglio(lista, label) {
      const ws = wb.addWorksheet(label);
      const fN = 3;
      const sN = 5;
      const totCols = fN + daysInMonth + sN;

      // Larghezze colonne
      ws.getColumn(1).width = 7;
      ws.getColumn(2).width = 30;
      ws.getColumn(3).width = 13;
      for (let i=0; i<daysInMonth; i++) ws.getColumn(fN+1+i).width = 4.5;
      for (let i=0; i<sN; i++) ws.getColumn(fN+daysInMonth+1+i).width = 6;

      // Titolo
      ws.mergeCells(1,1,1,totCols);
      const t1 = ws.getCell(1,1);
      t1.value = `KE CANTIERE — ${label.toUpperCase()} — ${monthLabel.toUpperCase()}`;
      t1.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF0D5C2E'}};
      t1.font = {name:'Calibri',size:13,bold:true,color:{argb:'FFFFFFFF'}};
      t1.alignment = {horizontal:'center',vertical:'middle'};
      ws.getRow(1).height = 26;

      // Riga giorni settimana
      const r2 = ws.getRow(2);
      r2.height = 13;
      r2.getCell(1).fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF1E1E1E'}};
      r2.getCell(2).fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF1E1E1E'}};
      r2.getCell(3).fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF1E1E1E'}};
      for (let i=0; i<daysInMonth; i++) {
        const dow = new Date(allDays[i]+'T00:00:00').getDay();
        const we  = dow===0||dow===6;
        const cell = r2.getCell(fN+1+i);
        cell.value = DOW[dow];
        cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:we?'FF5C1A1A':'FF1E1E1E'}};
        cell.font = {name:'Calibri',size:8,bold:true,color:{argb:we?'FFFF9999':'FF999999'}};
        cell.alignment = {horizontal:'center',vertical:'middle'};
      }
      const sCols = ['1A7A3C','7A1A1A','0D5C2E','7A4A00','0A4A24'];
      ['P','A','Ore','St.','Tot.'].forEach((lb,i) => {
        const cell = r2.getCell(fN+daysInMonth+1+i);
        cell.value = lb;
        cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF'+sCols[i]}};
        cell.font = {name:'Calibri',size:8,bold:true,color:{argb:'FFAAFFD0'}};
        cell.alignment = {horizontal:'center',vertical:'middle'};
      });

      // Header colonne
      const r3 = ws.getRow(3);
      r3.height = 21;
      ['Matr.','Nome','Mans.'].forEach((h,i) => {
        const cell = r3.getCell(i+1);
        cell.value = h;
        cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF222222'}};
        cell.font = {name:'Calibri',size:i===1?11:10,bold:true,color:{argb:'FFFFFFFF'}};
        cell.alignment = {horizontal:i===1?'left':'center',vertical:'middle'};
      });
      for (let i=0; i<daysInMonth; i++) {
        const dow = new Date(allDays[i]+'T00:00:00').getDay();
        const we  = dow===0||dow===6;
        const cell = r3.getCell(fN+1+i);
        cell.value = i+1;
        cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:we?'FF6B2121':'FF1A7A3C'}};
        cell.font = {name:'Calibri',size:9,bold:true,color:{argb:'FFFFFFFF'}};
        cell.alignment = {horizontal:'center',vertical:'middle'};
      }
      sCols.forEach((col,i) => {
        const cell = r3.getCell(fN+daysInMonth+1+i);
        cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF'+col}};
        cell.font = {name:'Calibri',size:10,bold:true,color:{argb:'FFFFFFFF'}};
        cell.alignment = {horizontal:'center',vertical:'middle'};
      });

      // Dati
      const totD = new Array(daysInMonth).fill(0);
      let tP=0,tA=0,tO=0,tS=0;
      lista.forEach((o, oi) => {
        const r = ws.getRow(4+oi);
        r.height = 19;
        const gg = {};
        giornate.filter(g => g.operaio===o.id && g.data.startsWith(month)).forEach(g => { gg[g.data]=g; });
        let gP=0,gA=0,oO=0,oS=0;
        const bg  = oi%2===0 ? 'FFF9FFFE' : 'FFFFFFFF';
        const bgS = oi%2===0 ? 'FFEAF7EF' : 'FFF4FBF7';

        r.getCell(1).value = o.matr||'';
        r.getCell(1).fill = {type:'pattern',pattern:'solid',fgColor:{argb:bg}};
        r.getCell(1).font = {name:'Calibri',size:9,color:{argb:'FF999999'}};
        r.getCell(1).alignment = {horizontal:'center',vertical:'middle'};

        r.getCell(2).value = titleCase(o.name);
        r.getCell(2).fill = {type:'pattern',pattern:'solid',fgColor:{argb:bg}};
        r.getCell(2).font = {name:'Calibri',size:11,bold:true,color:{argb:'FF111111'}};
        r.getCell(2).alignment = {horizontal:'left',vertical:'middle'};

        r.getCell(3).value = o.mansione||'';
        r.getCell(3).fill = {type:'pattern',pattern:'solid',fgColor:{argb:bg}};
        r.getCell(3).font = {name:'Calibri',size:9,color:{argb:'FF666666'}};
        r.getCell(3).alignment = {horizontal:'left',vertical:'middle'};

        for (let i=0; i<daysInMonth; i++) {
          const d = allDays[i];
          const g = gg[d];
          const dow = new Date(d+'T00:00:00').getDay();
          const we  = dow===0||dow===6;
          const cell = r.getCell(fN+1+i);
          if (!g) {
            cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:we?'FFF5E8E8':'FFF5F5F5'}};
            cell.font = {name:'Calibri',size:9,color:{argb:we?'FFDDAAAA':'FFDDDDDD'}};
          } else if (g.presente) {
            const h = (g.ore||0)+(g.straordinari||0);
            gP++; oO+=g.ore||0; oS+=g.straordinari||0; totD[i]+=h;
            cell.value = h;
            cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FFD4EDDA'}};
            cell.font = {name:'Calibri',size:10,bold:true,color:{argb:'FF155724'}};
          } else {
            gA++;
            cell.value = (g.motivoTipo||'A').substring(0,1).toUpperCase();
            cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFDECEA'}};
            cell.font = {name:'Calibri',size:9,bold:true,color:{argb:'FFB71C1C'}};
          }
          cell.alignment = {horizontal:'center',vertical:'middle'};
          cell.border = {top:{style:'hair',color:{argb:'FFCCCCCC'}},bottom:{style:'hair',color:{argb:'FFCCCCCC'}},left:{style:'hair',color:{argb:'FFCCCCCC'}},right:{style:'hair',color:{argb:'FFCCCCCC'}}};
        }
        tP+=gP; tA+=gA; tO+=oO; tS+=oS;

        [[gP,gP>0?'155724':'888888',gP>0,bgS],[gA,gA>0?'B71C1C':'888888',gA>0,bgS],[oO,'0D5C2E',oO>0,bgS],[oS,oS>0?'B45309':'888888',oS>0,bgS],[oO+oS,'0D5C2E',true,bgS]].forEach(([v,fc,bold,fill],i) => {
          const cell = r.getCell(fN+daysInMonth+1+i);
          cell.value = v;
          cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:fill}};
          cell.font = {name:'Calibri',size:10,bold:bold,color:{argb:'FF'+fc}};
          cell.alignment = {horizontal:'center',vertical:'middle'};
        });
      });

      // Totale
      const rT = ws.getRow(4+lista.length);
      rT.height = 20;
      rT.getCell(1).fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF0D5C2E'}};
      rT.getCell(2).value = 'TOTALE';
      rT.getCell(2).fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF0D5C2E'}};
      rT.getCell(2).font = {name:'Calibri',size:12,bold:true,color:{argb:'FFFFFFFF'}};
      rT.getCell(2).alignment = {horizontal:'left',vertical:'middle'};
      rT.getCell(3).fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF0D5C2E'}};
      for (let i=0; i<daysInMonth; i++) {
        const v = totD[i];
        const cell = rT.getCell(fN+1+i);
        cell.value = v>0 ? v : '';
        cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF0D5C2E'}};
        cell.font = {name:'Calibri',size:10,bold:v>0,color:{argb:v>0?'FFAAFFD0':'FF4A7A5A'}};
        cell.alignment = {horizontal:'center',vertical:'middle'};
      }
      [[tP,'AAFFD0'],[tA,'FFB3B3'],[tO,'AAFFD0'],[tS,tS>0?'FFD580':'AAFFD0'],[tO+tS,'FFFFFF']].forEach(([v,fc],i) => {
        const cell = rT.getCell(fN+daysInMonth+1+i);
        cell.value = v;
        cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF0A4A24'}};
        cell.font = {name:'Calibri',size:12,bold:true,color:{argb:'FF'+fc}};
        cell.alignment = {horizontal:'center',vertical:'middle'};
        cell.border = {top:{style:'medium',color:{argb:'FF000000'}},bottom:{style:'medium',color:{argb:'FF000000'}}};
      });
    }

    buildSintesi();
    buildDettaglio(edili, 'Cassa Edile');
    buildDettaglio(metalmeccanici, 'Metalmeccanico');

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Presenze_${month.replace('-','_')}.xlsx"`);
    res.send(buf);
  } catch(e) {
    console.error('[Export]', e);
    res.status(500).json({ error: e.message });
  }
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
