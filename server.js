const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

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
    // Preserva nome originale ma evita collisioni
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_() àèéìòùÀÈÉÌÒÙ]/g, '_');
    const ts = Date.now();
    cb(null, `${ts}_${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB per file
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf','image/jpeg','image/png','image/webp',
                     'application/msword',
                     'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    cb(null, allowed.includes(file.mimetype));
  }
});

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE  = path.join(__dirname, 'data.json');
const USERS_FILE = path.join(__dirname, 'users.json');

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ──────────────────────────────────────────────
function readData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!d.diari)         d.diari = [];
    if (!d.segnalazioni)  d.segnalazioni = [];
    if (!d.registrazioni) d.registrazioni = [];
    return d;
  } catch {
    return { operai:[], cantieri:[], giornate:[], registrazioni:[], segnalazioni:[], diari:[] };
  }
}
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Stesso algoritmo del frontend
function hashPwd(pwd) {
  const salt = 'ke_cantiere_2024';
  let r = '';
  for (let i = 0; i < pwd.length; i++) {
    r += String.fromCharCode(pwd.charCodeAt(i) ^ salt.charCodeAt(i % salt.length));
  }
  return Buffer.from(r).toString('base64');
}

const DEFAULT_USERS = [
  { username: 'admin',    password: hashPwd('admin123'), role: 'admin' },
  { username: 'cantiere', password: hashPwd('cantiere'), role: 'user'  }
];

function readUsers() {
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return (data && data.length > 0) ? data : DEFAULT_USERS;
  } catch {
    // File non esiste: crealo con i default
    writeUsers(DEFAULT_USERS);
    return DEFAULT_USERS;
  }
}
function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

// ── API: DB completo ──────────────────────────────────────
app.get('/api/data', (req, res) => { res.json(readData()); });

app.post('/api/data', (req, res) => {
  try {
    const body = req.body;
    if (!body || (!body.operai && !body.giornate)) return res.status(400).json({ error: 'Dati non validi' });
    if (!body.diari) body.diari = [];
    writeData(body);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Utenti ───────────────────────────────────────────
app.get('/api/users', (req, res) => { res.json(readUsers()); });

app.post('/api/users', (req, res) => {
  try {
    const users = req.body;
    if (!users || !Array.isArray(users) || users.length === 0) return res.status(400).json({ error: 'Lista non valida' });
    writeUsers(users);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: Operai ───────────────────────────────────────────
app.get('/api/operai', (req, res) => { res.json(readData().operai); });
app.post('/api/operai', (req, res) => {
  const db = readData();
  const o = { ...req.body, id: 'w' + Math.random().toString(16).slice(2, 10) };
  db.operai.push(o); writeData(db); res.json(o);
});
app.put('/api/operai/:id', (req, res) => {
  const db = readData();
  const idx = db.operai.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.operai[idx] = { ...db.operai[idx], ...req.body }; writeData(db); res.json(db.operai[idx]);
});
app.delete('/api/operai/:id', (req, res) => {
  const db = readData();
  db.operai   = db.operai.filter(o => o.id !== req.params.id);
  db.giornate = db.giornate.filter(g => g.operaio !== req.params.id);
  writeData(db); res.json({ ok: true });
});

// ── API: Cantieri ─────────────────────────────────────────
app.get('/api/cantieri', (req, res) => { res.json(readData().cantieri); });
app.post('/api/cantieri', (req, res) => {
  const db = readData();
  const c = { ...req.body, id: 'c' + Date.now() };
  db.cantieri.push(c); writeData(db); res.json(c);
});
app.put('/api/cantieri/:id', (req, res) => {
  const db = readData();
  const idx = db.cantieri.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.cantieri[idx] = { ...db.cantieri[idx], ...req.body }; writeData(db); res.json(db.cantieri[idx]);
});

// ── API: Giornate ─────────────────────────────────────────
app.get('/api/giornate', (req, res) => {
  const db = readData();
  let list = db.giornate;
  if (req.query.data)     list = list.filter(g => g.data === req.query.data);
  if (req.query.cantiere) list = list.filter(g => g.cantiere === req.query.cantiere);
  res.json(list);
});
app.post('/api/giornate', (req, res) => {
  const db = readData();
  const { data, cantiere, presenze } = req.body;
  db.giornate = db.giornate.filter(g => !(g.data === data && g.cantiere === cantiere));
  const nuove = presenze.map(p => ({
    id: 'g' + Date.now() + Math.random().toString(16).slice(2, 6),
    data, cantiere, operaio: p.operaio, presente: p.presente !== false,
    ore: p.ore || 8, straordinari: p.straordinari || 0,
    motivoTipo: p.motivoTipo || '', motivoNote: p.motivoNote || '', note: p.note || ''
  }));
  db.giornate.push(...nuove); writeData(db); res.json({ ok: true, count: nuove.length });
});

// ── API: Diari ────────────────────────────────────────────
app.get('/api/diari', (req, res) => {
  const db = readData();
  let list = db.diari || [];
  if (req.query.cantiere) list = list.filter(d => d.cantiere === req.query.cantiere);
  res.json(list.map(d => ({ ...d, foto: d.foto ? d.foto.map(() => '[foto]') : [] })));
});
app.get('/api/diari/:id', (req, res) => {
  const entry = (readData().diari || []).find(d => d.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  res.json(entry);
});
app.post('/api/diari', (req, res) => {
  try {
    const db = readData();
    const entry = { ...req.body, id: 'd' + Date.now(), ts: new Date().toISOString() };
    db.diari.push(entry); writeData(db); res.json({ ok: true, id: entry.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/diari/:id', (req, res) => {
  const db = readData();
  db.diari = (db.diari || []).filter(d => d.id !== req.params.id);
  writeData(db); res.json({ ok: true });
});

// ── API: Segnalazioni ─────────────────────────────────────
app.get('/api/segnalazioni', (req, res) => { res.json(readData().segnalazioni); });
app.post('/api/segnalazioni', (req, res) => {
  const db = readData();
  const s = { ...req.body, id: 's' + Date.now(), aperta: true };
  db.segnalazioni.push(s); writeData(db); res.json(s);
});
app.delete('/api/segnalazioni/:id', (req, res) => {
  const db = readData();
  db.segnalazioni = db.segnalazioni.filter(s => s.id !== req.params.id);
  writeData(db); res.json({ ok: true });
});

// ── API: Documenti operaio ────────────────────────────────

// Lista documenti di un operaio
app.get('/api/documenti/:operaioId', (req, res) => {
  const dir = path.join(DOCS_DIR, req.params.operaioId);
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).map(filename => {
    const filePath = path.join(dir, filename);
    const stat = fs.statSync(filePath);
    // Il nome originale è tutto dopo il primo underscore (es: 1234567890_documento.pdf)
    const originalName = filename.replace(/^\d+_/, '');
    return {
      id: filename,
      name: originalName,
      size: stat.size,
      uploadedAt: stat.mtime.toISOString(),
      url: `/uploads/documenti/${req.params.operaioId}/${filename}`
    };
  }).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  res.json(files);
});

// Upload documento
app.post('/api/documenti/:operaioId', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File non valido o troppo grande (max 20MB)' });
  const originalName = req.file.originalname.replace(/[^a-zA-Z0-9.\-_() àèéìòùÀÈÉÌÒÙ]/g, '_');
  res.json({
    ok: true,
    id: req.file.filename,
    name: originalName,
    size: req.file.size,
    url: `/uploads/documenti/${req.params.operaioId}/${req.file.filename}`
  });
});

// Rinomina documento
app.patch('/api/documenti/:operaioId/:filename', (req, res) => {
  const dir = path.join(DOCS_DIR, req.params.operaioId);
  const oldPath = path.join(dir, req.params.filename);
  if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'File non trovato' });
  const ts = req.params.filename.match(/^(\d+)_/)?.[1] || Date.now();
  const newName = `${ts}_${(req.body.name||'documento').replace(/[^a-zA-Z0-9.\-_() àèéìòùÀÈÉÌÒÙ]/g, '_')}`;
  fs.renameSync(oldPath, path.join(dir, newName));
  res.json({ ok: true, id: newName, name: req.body.name });
});

// Elimina documento
app.delete('/api/documenti/:operaioId/:filename', (req, res) => {
  const filePath = path.join(DOCS_DIR, req.params.operaioId, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File non trovato' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// Servi i file statici della cartella uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Catch-all ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  KE·CANTIERE  →  http://localhost:${PORT}`);
  console.log(`  Rete locale   →  http://<IP-server>:${PORT}\n`);
});
