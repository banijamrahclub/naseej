// server.js (Fixed + Persistent SQLite using better-sqlite3) — Updated (no past_booking_not_allowed)

const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');
const Database = require('better-sqlite3');
const webpush = require('web-push');

const app = express();

// =====================
// Config
// =====================
const DEFAULT_ADMIN_PWD = 'admin123';

// لو على Render Disk: خلي DB_PATH=/var/data/data.db
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');


// =====================
// DB init
// =====================
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    duration INTEGER NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    g_event_id TEXT,
    remind_sent INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT, -- empty for admin
    is_admin INTEGER DEFAULT 0,
    subscription_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
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

// Setup VAPID Keys
function setupVapid() {
  let pub = db.prepare(`SELECT value FROM settings WHERE key='vapid_public'`).get();
  let priv = db.prepare(`SELECT value FROM settings WHERE key='vapid_private'`).get();
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    db.prepare(`REPLACE INTO settings (key, value) VALUES ('vapid_public', ?)`).run(keys.publicKey);
    db.prepare(`REPLACE INTO settings (key, value) VALUES ('vapid_private', ?)`).run(keys.privateKey);
    pub = { value: keys.publicKey };
    priv = { value: keys.privateKey };
  }
  webpush.setVapidDetails(
    'mailto:admin@example.com',
    pub.value,
    priv.value
  );
  return pub.value;
}
ensureAdminPassword();
const VAPID_PUBLIC_KEY = setupVapid();

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
  // يفترض أن التوقيت هو توقيت البحرين (GMT+3)
  const dt = new Date(`${dateStr}T${timeStr}:00+03:00`);
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
    const info = db.prepare(`
      INSERT INTO bookings (name, phone, date, time, duration, price)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(String(name), String(phone), String(date), String(time), finalDuration, finalPrice);
    
    const newId = info.lastInsertRowid;
    const row = db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(newId);

    if (!row) {
      console.error('❌ Failed to retrieve newly created booking');
      return res.status(500).json({ error: 'retrieval_failed' });
    }

    // broadcast to admin SSE
    sendSSEEvent('booking-created', row);

    res.json(row);
  } catch (dbErr) {
    console.error('❌ Database Insert Failed:', dbErr.message);
    return res.status(500).json({ error: 'database_error: ' + dbErr.message });
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
// Web Push API
// =====================
app.get('/api/push/key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', (req, res) => {
  const { subscription, phone, isAdmin } = req.body;
  if (!subscription) return res.status(400).json({ error: 'subscription required' });
  
  const subJson = JSON.stringify(subscription);
  const is_admin = isAdmin ? 1 : 0;
  
  // نستخدم REPLACE لمنع تكرار نفس الجهاز لنفس الشخص
  db.prepare(`
    REPLACE INTO push_subscriptions (phone, is_admin, subscription_json)
    VALUES (?, ?, ?)
  `).run(phone || null, is_admin, subJson);
  
  res.json({ ok: true });
});

// وظيفة إرسال الإشعار
async function sendPushNotification(subscription, title, body) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title, body }));
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      // اشتراك منتهي أو محذوف، نزيله من الداتابيز
      db.prepare(`DELETE FROM push_subscriptions WHERE subscription_json = ?`).run(JSON.stringify(subscription));
    }
    console.error('Push Error:', err.message);
  }
}

// فاحص المواعيد (كل دقيقة)
setInterval(async () => {
  try {
    // جلب المواعيد التي ستبدأ بعد 25-30 دقيقة ولم يرسل لها تنبيه
    const upcoming = db.prepare(`
      SELECT * FROM bookings 
      WHERE remind_sent = 0 
      AND datetime(date || ' ' || time) <= datetime('now', '+32 minutes', 'localtime')
      AND datetime(date || ' ' || time) >= datetime('now', '+25 minutes', 'localtime')
    `).all();

    for (const booking of upcoming) {
      const msg = `تذكير: موعدك ${booking.time} بعد 30 دقيقة`;
      
      // 1. إرسال للزبون (بناءً على رقم هاتفه)
      const customerSubs = db.prepare(`SELECT subscription_json FROM push_subscriptions WHERE phone = ?`).all(booking.phone);
      for (const s of customerSubs) {
        await sendPushNotification(JSON.parse(s.subscription_json), "تذكير بموعدك ⚽", msg);
      }
      
      // 2. إرسال للأدمن
      const adminSubs = db.prepare(`SELECT subscription_json FROM push_subscriptions WHERE is_admin = 1`).all();
      for (const s of adminSubs) {
        await sendPushNotification(JSON.parse(s.subscription_json), "حجز قادم 🔔", `حجز باسم: ${booking.name} في تمام ${booking.time}`);
      }

      // تحديث أنه تم الإرسال
      db.prepare(`UPDATE bookings SET remind_sent = 1 WHERE id = ?`).run(booking.id);
    }
  } catch (e) {
    console.error('Reminder Checker Error:', e);
  }
}, 60000);

// =====================
// Start
// =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server started on', PORT, 'DB:', DB_PATH));
