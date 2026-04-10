// server.js (Fixed + Persistent SQLite using better-sqlite3) — Updated (no past_booking_not_allowed)

const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');
const Database = require('better-sqlite3');

const app = express();

// =====================
// Config
// =====================
const DEFAULT_ADMIN_PWD = 'admin123';

// لو على Render Disk: خلي DB_PATH=/var/data/data.db
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwwpp4I1ln9szkC-bS41s2rVvbMf7nIeGL9LGto9w2xxwC9baHF2zdJ7pEhCLVMI4v-/exec';


// =====================
// DB init
// =====================
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    date TEXT NOT NULL,   -- YYYY-MM-DD
    time TEXT NOT NULL,   -- HH:MM
    duration INTEGER NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    g_event_id TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_date_time ON bookings(date, time);
  CREATE INDEX IF NOT EXISTS idx_bookings_phone ON bookings(phone);
`);

// Ensure admin password exists
function ensureAdminPassword() {
  const row = db.prepare(`SELECT value FROM settings WHERE key='admin_password'`).get();
  if (!row) {
    const hash = bcrypt.hashSync(DEFAULT_ADMIN_PWD, 10);
    db.prepare(`INSERT INTO settings (key, value) VALUES ('admin_password', ?)`).run(hash);
    console.log('Admin password set to default ->', DEFAULT_ADMIN_PWD);
  }
}
ensureAdminPassword();

// (اختياري) حذف الحجوزات الماضية عند التشغيل
function purgePastBookings() {
  try {
    const r = db.prepare(`DELETE FROM bookings WHERE date < date('now','localtime')`).run();
    console.log('Purged past bookings on startup, rows:', r.changes);
  } catch (e) {
    console.error('Purge past bookings failed', e);
  }
}
// (اختياري) معطل بناءً على طلبك لعدم حذف الحجوزات
// purgePastBookings();


// =====================
// Middlewares
// =====================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change_this_secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
  })
);

// Static
app.use('/', express.static(path.join(__dirname)));

// Health endpoint
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// =====================
// Helpers
// =====================
function requireAdmin(req, res) {
  if (!req.session || !req.session.isAdmin) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function overlaps(aStart, aDuration, bStart, bDuration) {
  const a1 = timeToMinutes(aStart), a2 = a1 + aDuration;
  const b1 = timeToMinutes(bStart), b2 = b1 + bDuration;
  return Math.max(a1, b1) < Math.min(a2, b2);
}

function dateTimeIsInFuture(dateStr, timeStr) {
  // يستخدم وقت السيرفر، مفيد فقط للتحقق في الإلغاء
  const dt = new Date(`${dateStr}T${timeStr}:00`);
  return dt.getTime() > Date.now();
}

// الأسعار (عدّلها براحتك)
function getPriceForDuration(dur) {
  const base = { 60: 10, 90: 15, 120: 20 };
  return base[dur] || 0;
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function syncToGoogleCalendar(booking) {
  if (!GOOGLE_SCRIPT_URL || GOOGLE_SCRIPT_URL.includes('YOUR_GOOGLE_SCRIPT')) return;
  try {
    const res = await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(booking)
    });
    const data = await res.json();
    if (data.status === 'success' && data.eventId) {
      db.prepare(`UPDATE bookings SET g_event_id = ? WHERE id = ?`).run(data.eventId, booking.id);
      console.log('✅ Synced & ID Saved:', data.eventId);
    }
  } catch (err) {
    console.error('❌ Google Calendar Sync Failed:', err.message);
  }
}

async function deleteFromGoogleCalendar(eventId) {
  if (!GOOGLE_SCRIPT_URL || !eventId) return;
  try {
    const res = await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', eventId: eventId })
    });
    const data = await res.json();
    console.log('🗑️ Google Calendar Response:', data);
  } catch (err) {
    console.error('❌ Failed to delete from Google Calendar:', err.message);
  }
}

// =====================
// SSE (Real-time admin updates)
// =====================
const sseClients = new Set();

function sendSSEEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) {}
  }
}

app.get('/api/events', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// =====================
// API: Slots
// =====================
app.get('/api/slots', (req, res) => {
  const date = req.query.date; // YYYY-MM-DD
  if (!date) return res.status(400).json({ error: 'date required' });

  // توقيت البحرين الحالي
  const now = new Date();
  const bahrainTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bahrain' }));
  const todayStr = bahrainTime.toISOString().split('T')[0];
  const nowHM = bahrainTime.getHours().toString().padStart(2, '0') + ":" + bahrainTime.getMinutes().toString().padStart(2, '0');

  const slots = [];
  for (let h = 8; h <= 23; h++) {
    slots.push(`${String(h).padStart(2, '0')}:00`);
    slots.push(`${String(h).padStart(2, '0')}:30`);
  }
  slots.push('00:00');

  const bookings = db
    .prepare(`SELECT time, duration FROM bookings WHERE date = ?`)
    .all(date);

  const out = slots.map((s) => {
    let available = true;
    // منع الأوقات المحجوزة مسبقاً
    for (const b of bookings) {
      if (overlaps(b.time, Number(b.duration), s, 30)) {
        available = false;
        break;
      }
    }
    // منع الأوقات التي مضت اليوم
    if (date === todayStr && s <= nowHM && s !== '00:00') {
      available = false;
    }
    return { time: s, available };
  });

  res.json(out);
});

// =====================
// API: Bookings (Admin list + filter)
// =====================
app.get('/api/bookings', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const from = req.query.from;
  const to = req.query.to;

  let rows;
  if (from && to) {
    rows = db
      .prepare(`SELECT * FROM bookings WHERE date >= ? AND date <= ? ORDER BY date, time`)
      .all(from, to);
  } else {
    rows = db
      .prepare(`SELECT * FROM bookings ORDER BY date DESC, time DESC LIMIT 500`)
      .all();
  }

  res.json(rows);
});

// User-facing: list bookings by phone (no auth)
app.get('/api/bookings/user', (req, res) => {
  const phone = (req.query.phone || '').trim();
  if (!phone) return res.status(400).json({ error: 'phone required' });

  const rows = db
    .prepare(`SELECT * FROM bookings WHERE phone = ? ORDER BY date, time`)
    .all(phone);

  res.json(rows);
});

// Create booking (Open for users, protected price for admin)
app.post('/api/bookings', (req, res) => {
  const isAdmin = req.session && req.session.isAdmin;

  const name = (req.body.name || '').trim();
  const phone = (req.body.phone || '').trim();
  const date = (req.body.date || '').trim();
  const time = (req.body.time || '').trim();
  const duration = Number(req.body.duration);

  if (!name || !phone || !date || !time || !duration) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  // Conflict check (نفس اليوم)
  const sameDay = db.prepare(`SELECT time, duration FROM bookings WHERE date = ?`).all(date);
  for (const b of sameDay) {
    if (overlaps(b.time, Number(b.duration), time, duration)) {
      return res.status(409).json({ error: 'conflict' });
    }
  }

  const price =
    (isAdmin && req.body.price !== undefined && req.body.price !== null && String(req.body.price).trim() !== '')
      ? Number(req.body.price)
      : getPriceForDuration(duration);

  const finalPrice = Number(price || 0);
  const finalDuration = Number(duration || 0);

  try {
    // نترك الـ id فارغ ليقوم SQLite بإنشائه تلقائياً كـ Integer
    const info = db.prepare(`
      INSERT INTO bookings (name, phone, date, time, duration, price)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(String(name), String(phone), String(date), String(time), finalDuration, finalPrice);
    
    const newId = info.lastInsertRowid;
    const row = db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(newId);

    // broadcast to admin SSE
    sendSSEEvent('booking-created', row);

    // Sync with Google Calendar background
    syncToGoogleCalendar(row);

    res.json(row);
  } catch (dbErr) {
    console.error('❌ Database Insert Failed:', dbErr.message);
    return res.status(500).json({ error: 'database_error' });
  }
});

// Cancel booking by phone (user cancellation)
app.post('/api/bookings/:id/cancel', (req, res) => {
  const id = req.params.id;
  const phone = (req.body.phone || '').trim();
  if (!phone) return res.status(400).json({ error: 'phone required' });

  const row = db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.phone !== phone) return res.status(403).json({ error: 'phone mismatch' });

  // only allow cancellation for future bookings
  if (!dateTimeIsInFuture(row.date, row.time)) {
    return res.status(400).json({ error: 'cannot cancel past or started booking' });
  }

  db.prepare(`DELETE FROM bookings WHERE id = ?`).run(id);
  
  // Delete from Google Calendar if exists
  if (row.g_event_id) deleteFromGoogleCalendar(row.g_event_id);

  sendSSEEvent('booking-deleted', { id, date: row.date });
  res.json({ ok: true });
});

// Admin: delete one booking
app.delete('/api/bookings/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const id = req.params.id;
  const row = db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(id);
  db.prepare(`DELETE FROM bookings WHERE id = ?`).run(id);

  if (row) {
    if (row.g_event_id) deleteFromGoogleCalendar(row.g_event_id);
    sendSSEEvent('booking-deleted', { id, date: row.date });
  }
  res.json({ ok: true });
});

// Admin: delete all bookings
app.delete('/api/bookings/all', (req, res) => {
  if (!requireAdmin(req, res)) return;

  db.prepare(`DELETE FROM bookings`).run();
  sendSSEEvent('bookings-cleared', {});
  res.json({ ok: true });
});

// Admin: delete past bookings on demand
app.delete('/api/bookings/past', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const r = db.prepare(`DELETE FROM bookings WHERE date < date('now','localtime')`).run();
  sendSSEEvent('bookings-cleared', {});
  res.json({ ok: true, deleted: r.changes });
});

// =====================
// Admin auth
// =====================
app.post('/api/admin/login', async (req, res) => {
  const password = (req.body.password || '').trim();
  if (!password) return res.status(400).json({ error: 'password required' });

  const row = db.prepare(`SELECT value FROM settings WHERE key='admin_password'`).get();
  const hash = row && row.value;

  const ok = hash && (await bcrypt.compare(password, hash));
  if (!ok) return res.status(401).json({ error: 'invalid' });

  req.session.isAdmin = true;
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.post('/api/admin/change-password', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const oldPassword = (req.body.oldPassword || '').trim();
  const newPassword = (req.body.newPassword || '').trim();

  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'missing' });

  const row = db.prepare(`SELECT value FROM settings WHERE key='admin_password'`).get();
  const ok = row && (await bcrypt.compare(oldPassword, row.value));
  if (!ok) return res.status(401).json({ error: 'invalid-old' });

  const newHash = await bcrypt.hash(newPassword, 10);
  db.prepare(`REPLACE INTO settings (key, value) VALUES ('admin_password', ?)`).run(newHash);

  res.json({ ok: true });
});

// =====================
// Reports
// =====================
app.get('/api/reports', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const from = req.query.from;
  const to = req.query.to;
  if (!from || !to) return res.status(400).json({ error: 'from/to required' });

  const rows = db.prepare(`
    SELECT date, SUM(price) as revenue, COUNT(*) as bookings
    FROM bookings
    WHERE date BETWEEN ? AND ?
    GROUP BY date
    ORDER BY date
  `).all(from, to);

  const total = rows.reduce((s, r) => s + Number(r.revenue || 0), 0);
  res.json({ rows, total });
});

// =====================
// Start
// =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server started on', PORT, 'DB:', DB_PATH));
