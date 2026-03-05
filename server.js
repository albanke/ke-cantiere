const express = require('express');
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const { Pool } = require('pg');

// ── PostgreSQL ────────────────────────────────────────────
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDB() {
  if (!pool) {
    console.warn('[DB] DATABASE_URL non impostata — uso file JSON locale (dati non persistenti!)');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store (
      key  TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}'
    )
  `);
  console.log('[DB] PostgreSQL connesso ✓');
}

// ── Helpers dati (PostgreSQL o file JSON fallback) ────────
const DATA_FILE  = path.join(__dirname, 'data.json');
const USERS_FILE = path.join(__dirname, 'users.json');

function hashPwd(pwd) {
  const salt = 'ke_cantiere_2024';
  let r = '';
  for (let i = 0; i < pwd.length; i++)
    r += String.fromCharCode(pwd.charCodeAt(i) ^ salt.charCodeAt(i % salt.length));
  return Buffer.from(r).toString('base64');
}

const DEFAULT_USERS = [
  { username: 'admin',    password: hashPwd('admin123'), role: 'admin' },
  { username: 'cantiere', password: hashPwd('cantiere'), role: 'user'  }
];

const EMPTY_DB = { operai:[], cantieri:[], giornate:[], registrazioni:[], segnalazioni:[], diari:[] };

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
    return (users && users.length > 0) ? users : DEFAULT_USERS;
  }
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return (data && data.length > 0) ? data : DEFAULT_USERS;
  } catch { return DEFAULT_USERS; }
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

// ── Upload documenti ──────────────────────────────────────
const DOCS_DIR = path.join(__dirname, 'uploads', 'documenti');
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(DOCS_DIR, req.params.operaioId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_() àèéìòùÀÈÉÌÒÙ]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf','image/jpeg','image/png','image/webp',
                     'application/msword',
                     'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// ── App ───────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── API: DB completo ──────────────────────────────────────
app.get('/api/data', async (req, res) => {
  try { res.json(await readData()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/data', async (req, res) => {
  try {
    const body = req.body;
    if (!body || (!body.operai && !body.giornate)) return res.status(400).json({ error: 'Dati non validi' });
    if (!body.diari) body.diari = [];
    await writeData(body);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: Utenti ───────────────────────────────────────────
app.get('/api/users', async (req, res) => {
  try { res.json(await readUsers()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', async (req, res) => {
  try {
    const users = req.body;
    if (!users || !Array.isArray(users) || users.length === 0)
      return res.status(400).json({ error: 'Lista non valida' });
    await writeUsers(users);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: Operai ───────────────────────────────────────────
app.get('/api/operai', async (req, res) => {
  try { res.json((await readData()).operai); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/operai', async (req, res) => {
  try {
    const db = await readData();
    const o = { ...req.body, id: 'w' + Math.random().toString(16).slice(2, 10) };
    db.operai.push(o); await writeData(db); res.json(o);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/operai/:id', async (req, res) => {
  try {
    const db = await readData();
    const idx = db.operai.findIndex(o => o.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    db.operai[idx] = { ...db.operai[idx], ...req.body };
    await writeData(db); res.json(db.operai[idx]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/operai/:id', async (req, res) => {
  try {
    const db = await readData();
    db.operai   = db.operai.filter(o => o.id !== req.params.id);
    db.giornate = db.giornate.filter(g => g.operaio !== req.params.id);
    await writeData(db); res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: Cantieri ─────────────────────────────────────────
app.get('/api/cantieri', async (req, res) => {
  try { res.json((await readData()).cantieri); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/cantieri', async (req, res) => {
  try {
    const db = await readData();
    const c = { ...req.body, id: 'c' + Date.now() };
    db.cantieri.push(c); await writeData(db); res.json(c);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/cantieri/:id', async (req, res) => {
  try {
    const db = await readData();
    const idx = db.cantieri.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    db.cantieri[idx] = { ...db.cantieri[idx], ...req.body };
    await writeData(db); res.json(db.cantieri[idx]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: Giornate ─────────────────────────────────────────
app.get('/api/giornate', async (req, res) => {
  try {
    const db = await readData();
    let list = db.giornate;
    if (req.query.data)     list = list.filter(g => g.data === req.query.data);
    if (req.query.cantiere) list = list.filter(g => g.cantiere === req.query.cantiere);
    res.json(list);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/giornate', async (req, res) => {
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

// ── API: Diari ────────────────────────────────────────────
app.get('/api/diari', async (req, res) => {
  try {
    const db = await readData();
    let list = db.diari || [];
    if (req.query.cantiere) list = list.filter(d => d.cantiere === req.query.cantiere);
    res.json(list.map(d => ({ ...d, foto: d.foto ? d.foto.map(() => '[foto]') : [] })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/diari/:id', async (req, res) => {
  try {
    const entry = ((await readData()).diari || []).find(d => d.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json(entry);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/diari', async (req, res) => {
  try {
    const db = await readData();
    const entry = { ...req.body, id: 'd' + Date.now(), ts: new Date().toISOString() };
    db.diari.push(entry); await writeData(db);
    res.json({ ok: true, id: entry.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/diari/:id', async (req, res) => {
  try {
    const db = await readData();
    db.diari = (db.diari || []).filter(d => d.id !== req.params.id);
    await writeData(db); res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: Segnalazioni ─────────────────────────────────────
app.get('/api/segnalazioni', async (req, res) => {
  try { res.json((await readData()).segnalazioni); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/segnalazioni', async (req, res) => {
  try {
    const db = await readData();
    const s = { ...req.body, id: 's' + Date.now(), aperta: true };
    db.segnalazioni.push(s); await writeData(db); res.json(s);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/segnalazioni/:id', async (req, res) => {
  try {
    const db = await readData();
    db.segnalazioni = db.segnalazioni.filter(s => s.id !== req.params.id);
    await writeData(db); res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: Documenti operaio ────────────────────────────────
app.get('/api/documenti/:operaioId', (req, res) => {
  const dir = path.join(DOCS_DIR, req.params.operaioId);
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).map(filename => {
    const stat = fs.statSync(path.join(dir, filename));
    return {
      id: filename,
      name: filename.replace(/^\d+_/, ''),
      size: stat.size,
      uploadedAt: stat.mtime.toISOString(),
      url: `/uploads/documenti/${req.params.operaioId}/${filename}`
    };
  }).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  res.json(files);
});

app.post('/api/documenti/:operaioId', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File non valido o troppo grande (max 20MB)' });
  res.json({
    ok: true, id: req.file.filename,
    name: req.file.originalname.replace(/[^a-zA-Z0-9.\-_() àèéìòùÀÈÉÌÒÙ]/g, '_'),
    size: req.file.size,
    url: `/uploads/documenti/${req.params.operaioId}/${req.file.filename}`
  });
});

app.patch('/api/documenti/:operaioId/:filename', (req, res) => {
  const dir = path.join(DOCS_DIR, req.params.operaioId);
  const oldPath = path.join(dir, req.params.filename);
  if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'File non trovato' });
  const ts = req.params.filename.match(/^(\d+)_/)?.[1] || Date.now();
  const newName = `${ts}_${(req.body.name||'documento').replace(/[^a-zA-Z0-9.\-_() àèéìòùÀÈÉÌÒÙ]/g, '_')}`;
  fs.renameSync(oldPath, path.join(dir, newName));
  res.json({ ok: true, id: newName, name: req.body.name });
});

app.delete('/api/documenti/:operaioId/:filename', (req, res) => {
  const filePath = path.join(DOCS_DIR, req.params.operaioId, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File non trovato' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// ── Catch-all ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Avvio ─────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  KE·CANTIERE  →  http://localhost:${PORT}\n`);
  });
});
