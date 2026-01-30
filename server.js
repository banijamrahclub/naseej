const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const session = require('express-session');

const DB_FILE = path.join(__dirname, 'data.db');
const DEFAULT_ADMIN_PWD = 'admin123';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'change_this_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

// serve static site files
app.use('/', express.static(path.join(__dirname)));

// init db
const db = new sqlite3.Database(DB_FILE);

function runSql(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if(err) reject(err); else resolve(this);
    });
  });
}
function getSql(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if(err) reject(err); else resolve(row); });
  });
}
function allSql(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if(err) reject(err); else resolve(rows); });
  });
}

async function initDb(){
  await runSql(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    date TEXT NOT NULL, -- YYYY-MM-DD
    time TEXT NOT NULL, -- HH:MM
    duration INTEGER NOT NULL, -- minutes
    price REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await runSql(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  const row = await getSql(`SELECT value FROM settings WHERE key='admin_password'`);
  if(!row){
    const hash = await bcrypt.hash(DEFAULT_ADMIN_PWD, 10);
    await runSql(`INSERT INTO settings (key, value) VALUES ('admin_password', ?)` , [hash]);
    console.log('Admin password set to default ->', DEFAULT_ADMIN_PWD);
  }
}

initDb().catch(err => { console.error('DB init error', err); process.exit(1); });

// helper: check overlap
function timeToMinutes(t){ const [h,m] = t.split(':').map(Number); return h*60 + m; }
function overlaps(aStart, aDuration, bStart, bDuration){
  const a1 = timeToMinutes(aStart), a2 = a1 + aDuration;
  const b1 = timeToMinutes(bStart), b2 = b1 + bDuration;
  return Math.max(a1, b1) < Math.min(a2, b2);
}

// Prices and offers (fixed)
function getPriceForDuration(dur){
  const base = { 60: 10, 90: 15, 120: 20 };
  const offers = { 90: 10, 120: 15 };
  if(offers[dur]) return offers[dur];
  return base[dur] || 0;
}

// API
app.get('/api/slots', async (req, res) => {
  const date = req.query.date; // YYYY-MM-DD
  if(!date) return res.status(400).json({error:'date required'});
  // generate slots every 30 minutes from 08:00 to 23:00 (exclusive of 23:30)
  const slots = [];
  for(let h=8; h<=23; h++){
    slots.push(`${String(h).padStart(2,'0')}:00`);
    slots.push(`${String(h).padStart(2,'0')}:30`);
  }
  // add midnight slot (00:00) as the last slot of the day
  slots.push('00:00');
  // fetch bookings for the day
  const bookings = await allSql(`SELECT time, duration FROM bookings WHERE date = ?`, [date]);
  // mark availability
  const out = slots.map(s => ({ time:s, available:true }));
  for(const b of bookings){
    out.forEach(o => { if(overlaps(b.time, b.duration, o.time, 30)) o.available = false; });
  }
  res.json(out);
});

app.get('/api/bookings', async (req, res) => {
  const from = req.query.from;
  const to = req.query.to;
  // admin only
  if(!req.session || !req.session.isAdmin) return res.status(401).json({error:'unauthorized'});
  let rows;
  if(from && to){
    rows = await allSql(`SELECT * FROM bookings WHERE date BETWEEN ? AND ? ORDER BY date, time`, [from, to]);
  } else {
    rows = await allSql(`SELECT * FROM bookings ORDER BY date DESC LIMIT 500`);
  }
  res.json(rows);
});

app.post('/api/bookings', async (req, res) => {
  const { name, phone, date, time, duration } = req.body;
  if(!name || !phone || !date || !time || !duration) return res.status(400).json({error:'missing fields'});
  const dur = Number(duration);
  // check conflicts
  const sameDay = await allSql(`SELECT * FROM bookings WHERE date = ?`, [date]);
  for(const b of sameDay){ if(overlaps(b.time, b.duration, time, dur)) return res.status(409).json({error:'conflict'}); }
  const priceToUse = getPriceForDuration(dur);
  const r = await runSql(`INSERT INTO bookings (name, phone, date, time, duration, price) VALUES (?,?,?,?,?,?)`, [name, phone, date, time, dur, priceToUse]);
  const id = r.lastID;
  const row = await getSql(`SELECT * FROM bookings WHERE id = ?`, [id]);
  // broadcast to SSE clients
  if(global.sendSSEEvent) global.sendSSEEvent('booking-created', row);
  res.json(row);
});

app.delete('/api/bookings/:id', async (req, res) => {
  if(!req.session || !req.session.isAdmin) return res.status(401).json({error:'unauthorized'});
  const id = req.params.id;
  const row = await getSql(`SELECT * FROM bookings WHERE id = ?`, [id]);
  await runSql(`DELETE FROM bookings WHERE id = ?`, [id]);
  res.json({ok:true});
  if(row && global.sendSSEEvent) global.sendSSEEvent('booking-deleted', { id: id, date: row.date });
});

app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  if(!password) return res.status(400).json({error:'password required'});
  const row = await getSql(`SELECT value FROM settings WHERE key='admin_password'`);
  const hash = row && row.value;
  const ok = hash && await bcrypt.compare(password, hash);
  if(!ok) return res.status(401).json({error:'invalid'});
  req.session.isAdmin = true;
  res.json({ok:true});
});

app.post('/api/admin/logout', (req,res)=>{ req.session.destroy(()=>res.json({ok:true})); });

app.post('/api/admin/change-password', async (req, res) => {
  if(!req.session || !req.session.isAdmin) return res.status(401).json({error:'unauthorized'});
  const { oldPassword, newPassword } = req.body;
  if(!oldPassword || !newPassword) return res.status(400).json({error:'missing'});
  const row = await getSql(`SELECT value FROM settings WHERE key='admin_password'`);
  const ok = row && await bcrypt.compare(oldPassword, row.value);
  if(!ok) return res.status(401).json({error:'invalid-old'});
  const newHash = await bcrypt.hash(newPassword, 10);
  await runSql(`REPLACE INTO settings (key, value) VALUES ('admin_password', ?)`, [newHash]);
  res.json({ok:true});
});



// SSE: server-sent events to notify admin UI in real-time
const sseClients = new Set();
function sendSSEEventLocal(event, data){
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for(const res of sseClients){ try{ res.write(payload); }catch(e){ /* ignore write error */ } }
}
// expose helper for other handlers
global.sendSSEEvent = sendSSEEventLocal;

app.get('/api/events', (req, res) => {
  if(!req.session || !req.session.isAdmin) return res.status(401).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write(': connected\n\n');
  sseClients.add(res);
  req.on('close', ()=>{ sseClients.delete(res); });
});

app.get('/api/reports', async (req, res) => {
  if(!req.session || !req.session.isAdmin) return res.status(401).json({error:'unauthorized'});
  const from = req.query.from; const to = req.query.to;
  if(!from || !to) return res.status(400).json({error:'from/to required'});
  const rows = await allSql(`SELECT date, SUM(price) as revenue, COUNT(*) as bookings FROM bookings WHERE date BETWEEN ? AND ? GROUP BY date ORDER BY date`, [from, to]);
  const total = rows.reduce((s,r)=>s + (r.revenue||0), 0);
  res.json({rows, total});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log('Server started on', PORT));
