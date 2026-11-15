#!/usr/bin/env node
'use strict';
/* ==========================================================================
   مركز المهندس الشامل — Professional API Server
   ---------------------------------------------------------------
   • Zero dependencies (node:http + node:sqlite) — runs on any Node 22+
   • Real database (SQLite/WAL) — data lives on the SERVER, visible from
     every device (the old localStorage problem is gone for good)
   • REST API: orders / maintenance / products / stats / auth
   • Static hosting for the storefront + dashboard
   ========================================================================== */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

/* ---------------------------------- config ---------------------------------- */
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, 'mohandis.db');
const BOOT_PASSWORD = process.env.ADMIN_PASSWORD || 'admin12345';
const SEED_DEMO = process.env.SEED_DEMO !== '0';
const MIGRATE_CRUD = process.env.MIGRATE_CRUDCRUD !== '0';
const BODY_LIMIT = 5 * 1024 * 1024; // 5MB (base64 product images)
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/* ---------------------------------- db -------------------------------------- */
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ref           TEXT UNIQUE,
  legacy_id     TEXT,
  customer_name TEXT NOT NULL,
  phone         TEXT NOT NULL,
  address       TEXT,
  product_title TEXT NOT NULL,
  product_image TEXT,
  price         TEXT,
  service_type  TEXT DEFAULT 'شراء',
  device        TEXT,
  status        TEXT DEFAULT 'جديد',
  note          TEXT,
  source        TEXT DEFAULT 'site',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status    ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created   ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_updated   ON orders(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_legacy    ON orders(legacy_id);

CREATE TABLE IF NOT EXISTS maintenance (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ref           TEXT UNIQUE,
  legacy_id     TEXT,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL,
  device        TEXT,
  description   TEXT,
  fault_images  TEXT DEFAULT '[]',
  address       TEXT,
  status        TEXT DEFAULT 'جديد',
  note          TEXT,
  source        TEXT DEFAULT 'site',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_maint_status  ON maintenance(status);
CREATE INDEX IF NOT EXISTS idx_maint_created ON maintenance(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_maint_legacy  ON maintenance(legacy_id);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  legacy_id   TEXT,
  title       TEXT NOT NULL,
  price       TEXT,
  category    TEXT,
  image       TEXT,
  description TEXT,
  active      INTEGER DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_products_legacy ON products(legacy_id);

CREATE TABLE IF NOT EXISTS visits (
  day   TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/* ------------------------------ tiny helpers ------------------------------- */
const nowISO = () => new Date().toISOString();
const esc = (s) => String(s ?? '').trim();
const j = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
};
const ok = (res, data, code = 200) => j(res, code, { ok: true, data });
const fail = (res, code, error) => j(res, code, { ok: false, error });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function parsePrice(text) {
  const m = String(text || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).match(/\d+/);
  return m ? Number(m[0]) : 0;
}

/* ------------------------------- auth layer -------------------------------- */
function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}
function ensureAuthSecret() {
  let secret = getSetting('auth_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting('auth_secret', secret);
  }
  return secret;
}
function ensureAdminPassword() {
  if (!getSetting('admin_hash')) {
    const salt = crypto.randomBytes(16).toString('hex');
    setSetting('admin_salt', salt);
    setSetting('admin_hash', hashPassword(BOOT_PASSWORD, salt));
  }
}
ensureAdminPassword();
let AUTH_SECRET = ensureAuthSecret();

function issueToken(ttlMs = 30 * 24 * 3600 * 1000) {
  const exp = Date.now() + ttlMs;
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(`admin:${exp}`).digest('hex');
  return `mhs.${exp}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'mhs') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expect = crypto.createHmac('sha256', AUTH_SECRET).update(`admin:${exp}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(parts[2], 'hex'), Buffer.from(expect, 'hex')); }
  catch { return false; }
}
function getToken(req) {
  const h = req.headers['authorization'];
  if (h && h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}
function requireAuth(req, res) {
  if (verifyToken(getToken(req))) return true;
  fail(res, 401, 'انتهت الجلسة — سجّل الدخول مرة أخرى');
  return false;
}

/* ------------------------------ rate limiting ------------------------------ */
const buckets = new Map();
function rateLimit(res, ip, key, limit, windowMs) {
  const now = Date.now();
  const k = `${ip}:${key}`;
  let b = buckets.get(k);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(k, b); }
  b.n++;
  if (b.n > limit) {
    j(res, 429, { ok: false, error: 'محاولات كثيرة — انتظر قليلاً ثم أعد المحاولة' });
    return false;
  }
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60000).unref();

/* ------------------------------ image storage ------------------------------ */
function storeImage(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return esc(dataUrl).slice(0, 500);
  const m = dataUrl.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i);
  if (!m) return '';
  const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return '';
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20);
  const name = `img_${hash}.${ext}`;
  const fp = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, buf);
  return `/uploads/${name}`;
}

/* -------------------------------- refs ------------------------------------- */
function nextRef(table, prefix) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const n = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ref LIKE ?`).get(`${prefix}-${today}-%`).c + 1;
  return `${prefix}-${today}-${String(n).padStart(3, '0')}`;
}

/* ------------------------------ status lists ------------------------------- */
const ORDER_STATUS = ['جديد', 'قيد المراجعة', 'تم التواصل', 'تم التأكيد', 'تم الشحن', 'مكتمل', 'ملغي'];
const MAINT_STATUS = ['جديد', 'قيد المراجعة', 'قيد الصيانة', 'جاهز', 'تم التسليم', 'ملغي'];

/* ------------------------------ API handlers ------------------------------- */
const routes = [];

function route(method, pattern, handler, opts = {}) {
  // pattern: '/api/orders' or '/api/orders/:id'
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler, opts });
}

/* ---- auth ---- */
route('POST', '/api/auth/login', async (req, res, m, ctx) => {
  if (!rateLimit(res, ctx.ip, 'login', 12, 60000)) return;
  const { password } = ctx.body;
  if (!password) return fail(res, 400, 'أدخل كلمة المرور');
  const salt = getSetting('admin_salt');
  const hash = getSetting('admin_hash');
  const tryHash = hashPassword(password, salt);
  const valid = crypto.timingSafeEqual(Buffer.from(tryHash), Buffer.from(hash));
  if (!valid) return fail(res, 401, 'كلمة المرور غير صحيحة');
  ok(res, { token: issueToken(), expiresAt: new Date(Date.now() + 30 * 864e5).toISOString() });
});

route('POST', '/api/auth/change-password', (req, res, m, ctx) => {
  if (!requireAuth(req, res)) return;
  const { currentPassword, newPassword } = ctx.body;
  if (!currentPassword || !newPassword || String(newPassword).length < 6)
    return fail(res, 400, 'كلمة المرور الجديدة يجب ألا تقل عن 6 أحرف');
  const salt = getSetting('admin_salt');
  const valid = crypto.timingSafeEqual(Buffer.from(hashPassword(currentPassword, salt)), Buffer.from(getSetting('admin_hash')));
  if (!valid) return fail(res, 401, 'كلمة المرور الحالية غير صحيحة');
  const newSalt = crypto.randomBytes(16).toString('hex');
  setSetting('admin_salt', newSalt);
  setSetting('admin_hash', hashPassword(newPassword, newSalt));
  AUTH_SECRET = ensureAuthSecret(); // rotate → other sessions logged out
  setSetting('auth_secret', crypto.randomBytes(32).toString('hex'));
  AUTH_SECRET = getSetting('auth_secret');
  ok(res, { message: 'تم تغيير كلمة المرور — سجّل الدخول من جديد' });
}, { auth: true });

/* ---- orders ---- */
route('GET', '/api/orders', (req, res, m, ctx) => {
  if (!requireAuth(req, res)) return;
  const q = ctx.query;
  const where = [];
  const args = [];
  if (q.status && q.status !== 'الكل') { where.push('status = ?'); args.push(q.status); }
  if (q.search) {
    where.push('(customer_name LIKE ? OR phone LIKE ? OR product_title LIKE ? OR ref LIKE ? OR address LIKE ?)');
    const s = `%${q.search}%`; args.push(s, s, s, s, s);
  }
  if (q.since) { where.push('updated_at > ?'); args.push(q.since); }
  const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500);
  const page = Math.max(Number(q.page) || 1, 1);
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM orders ${whereSQL}`).get(...args).c;
  const items = db.prepare(
    `SELECT * FROM orders ${whereSQL} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
  ).all(...args, limit, (page - 1) * limit);
  ok(res, { items, total, page, limit });
});

route('POST', '/api/orders', async (req, res, m, ctx) => {
  if (!rateLimit(res, ctx.ip, 'order', 30, 60000)) return;
  const b = ctx.body;
  const customerName = esc(b.customerName), phone = esc(b.phone), productTitle = esc(b.productTitle);
  if (customerName.length < 2) return fail(res, 400, 'اسم العميل مطلوب');
  if (!/^(\+?20)?01[0-9]{8,9}$/.test(phone.replace(/\s|-/g, '')))
    return fail(res, 400, 'رقم هاتف مصري صحيح مطلوب (مثال: 01001234567)');
  if (!productTitle) return fail(res, 400, 'المنتج مطلوب');
  const ref = nextRef('orders', 'ORD');
  const info = db.prepare(`
    INSERT INTO orders (ref, customer_name, phone, address, product_title, product_image, price, service_type, device, status, note, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'جديد', ?, 'site')
  `).run(
    ref, customerName, phone, esc(b.address).slice(0, 300), productTitle.slice(0, 300),
    esc(b.productImage).slice(0, 400), esc(b.price).slice(0, 60), esc(b.serviceType) || 'شراء',
    esc(b.device).slice(0, 80), esc(b.note).slice(0, 500)
  );
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
  ok(res, row, 201);
});

route('PATCH', '/api/orders/:id', (req, res, m, ctx) => {
  if (!requireAuth(req, res)) return;
  const id = Number(m[1]);
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!row) return fail(res, 404, 'الطلب غير موجود');
  const b = ctx.body;
  const status = b.status !== undefined ? esc(b.status) : row.status;
  if (!ORDER_STATUS.includes(status)) return fail(res, 400, 'حالة غير صالحة');
  db.prepare('UPDATE orders SET status = ?, note = ?, updated_at = ? WHERE id = ?')
    .run(status, b.note !== undefined ? esc(b.note).slice(0, 500) : row.note, nowISO(), id);
  ok(res, db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
});

route('DELETE', '/api/orders/:id', (req, res, m) => {
  if (!requireAuth(req, res)) return;
  const info = db.prepare('DELETE FROM orders WHERE id = ?').run(Number(m[1]));
  if (!info.changes) return fail(res, 404, 'الطلب غير موجود');
  ok(res, { deleted: true });
});

/* ---- maintenance ---- */
route('GET', '/api/maintenance', (req, res, m, ctx) => {
  if (!requireAuth(req, res)) return;
  const q = ctx.query;
  const where = []; const args = [];
  if (q.status && q.status !== 'الكل') { where.push('status = ?'); args.push(q.status); }
  if (q.search) {
    where.push('(name LIKE ? OR phone LIKE ? OR device LIKE ? OR description LIKE ? OR ref LIKE ?)');
    const s = `%${q.search}%`; args.push(s, s, s, s, s);
  }
  if (q.since) { where.push('updated_at > ?'); args.push(q.since); }
  const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500);
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM maintenance ${whereSQL}`).get(...args).c;
  const items = db.prepare(`SELECT * FROM maintenance ${whereSQL} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, limit);
  ok(res, { items, total });
});

route('POST', '/api/maintenance', async (req, res, m, ctx) => {
  if (!rateLimit(res, ctx.ip, 'maint', 30, 60000)) return;
  const b = ctx.body;
  const name = esc(b.name), phone = esc(b.phone);
  if (name.length < 2) return fail(res, 400, 'اسم العميل مطلوب');
  if (!/^(\+?20)?01[0-9]{8,9}$/.test(phone.replace(/\s|-/g, '')))
    return fail(res, 400, 'رقم هاتف مصري صحيح مطلوب');
  if (!esc(b.device) && !esc(b.description)) return fail(res, 400, 'اكتب نوع الجهاز ووصف العطل');
  let images = [];
  if (Array.isArray(b.faultImages)) {
    images = b.faultImages.slice(0, 2).map(storeImage).filter(Boolean);
  }
  const ref = nextRef('maintenance', 'MNT');
  const info = db.prepare(`
    INSERT INTO maintenance (ref, name, phone, device, description, fault_images, address, status, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'جديد', 'site')
  `).run(ref, name, phone, esc(b.device).slice(0, 80), esc(b.description).slice(0, 800),
         JSON.stringify(images), esc(b.address).slice(0, 300));
  ok(res, db.prepare('SELECT * FROM maintenance WHERE id = ?').get(info.lastInsertRowid), 201);
});

route('PATCH', '/api/maintenance/:id', (req, res, m, ctx) => {
  if (!requireAuth(req, res)) return;
  const id = Number(m[1]);
  const row = db.prepare('SELECT * FROM maintenance WHERE id = ?').get(id);
  if (!row) return fail(res, 404, 'الطلب غير موجود');
  const b = ctx.body;
  const status = b.status !== undefined ? esc(b.status) : row.status;
  if (!MAINT_STATUS.includes(status)) return fail(res, 400, 'حالة غير صالحة');
  db.prepare('UPDATE maintenance SET status = ?, note = ?, updated_at = ? WHERE id = ?')
    .run(status, b.note !== undefined ? esc(b.note).slice(0, 500) : row.note, nowISO(), id);
  ok(res, db.prepare('SELECT * FROM maintenance WHERE id = ?').get(id));
});

route('DELETE', '/api/maintenance/:id', (req, res, m) => {
  if (!requireAuth(req, res)) return;
  const info = db.prepare('DELETE FROM maintenance WHERE id = ?').run(Number(m[1]));
  if (!info.changes) return fail(res, 404, 'الطلب غير موجود');
  ok(res, { deleted: true });
});

/* ---- products ---- */
route('GET', '/api/products', (req, res, m, ctx) => {
  // public: catalog is public on the storefront anyway
  const q = ctx.query;
  let sql = 'SELECT * FROM products';
  if (q.active === '1') sql += ' WHERE active = 1';
  sql += ' ORDER BY id DESC';
  ok(res, db.prepare(sql).all());
});

route('POST', '/api/products', async (req, res, m, ctx) => {
  if (!requireAuth(req, res)) return;
  const b = ctx.body;
  const title = esc(b.title);
  if (title.length < 2) return fail(res, 400, 'اسم المنتج مطلوب');
  const image = storeImage(b.image);
  const info = db.prepare(`
    INSERT INTO products (title, price, category, image, description, active)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(title, esc(b.price).slice(0, 80), esc(b.category).slice(0, 60), image,
         esc(b.description).slice(0, 1000), b.active === false || b.active === 0 ? 0 : 1);
  ok(res, db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid), 201);
});

route('PUT', '/api/products/:id', (req, res, m, ctx) => {
  if (!requireAuth(req, res)) return;
  const id = Number(m[1]);
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!row) return fail(res, 404, 'المنتج غير موجود');
  const b = ctx.body;
  const image = b.image !== undefined ? (String(b.image).startsWith('data:') ? storeImage(b.image) : esc(b.image)) : row.image;
  db.prepare(`
    UPDATE products SET title = ?, price = ?, category = ?, image = ?, description = ?, active = ?, updated_at = ?
    WHERE id = ?
  `).run(
    b.title !== undefined ? esc(b.title).slice(0, 300) : row.title,
    b.price !== undefined ? esc(b.price).slice(0, 80) : row.price,
    b.category !== undefined ? esc(b.category).slice(0, 60) : row.category,
    image,
    b.description !== undefined ? esc(b.description).slice(0, 1000) : row.description,
    b.active !== undefined ? (b.active ? 1 : 0) : row.active,
    nowISO(), id
  );
  ok(res, db.prepare('SELECT * FROM products WHERE id = ?').get(id));
});

route('DELETE', '/api/products/:id', (req, res, m) => {
  if (!requireAuth(req, res)) return;
  const info = db.prepare('DELETE FROM products WHERE id = ?').run(Number(m[1]));
  if (!info.changes) return fail(res, 404, 'المنتج غير موجود');
  ok(res, { deleted: true });
});

/* ---- visits ---- */
route('POST', '/api/visits/track', async (req, res, m, ctx) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(esc(ctx.body.day)) ? esc(ctx.body.day) : new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO visits (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1`).run(day);
  ok(res, { tracked: true });
});

/* ---- stats ---- */
route('GET', '/api/stats', (req, res) => {
  if (!requireAuth(req, res)) return;
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const since7 = daysAgo(6);
  const since14 = daysAgo(13);

  const count = (t, w = '', a = []) => db.prepare(`SELECT COUNT(*) c FROM ${t} ${w}`).get(...a).c;
  const ordersTotal = count('orders');
  const maintTotal = count('maintenance');
  const productsTotal = count('products');

  const ordersToday = count('orders', 'WHERE substr(created_at,1,10) = ?', [today]);
  const maintToday = count('maintenance', 'WHERE substr(created_at,1,10) = ?', [today]);
  const ordersWeek = count('orders', 'WHERE substr(created_at,1,10) >= ?', [since7]);
  const maintWeek = count('maintenance', 'WHERE substr(created_at,1,10) >= ?', [since7]);
  const pendingOrders = count('orders', `WHERE status NOT IN ('مكتمل','ملغي')`);
  const pendingMaint = count('maintenance', `WHERE status NOT IN ('تم التسليم','ملغي')`);

  const revenueRow = db.prepare(`SELECT price FROM orders WHERE status != 'ملغي'`).all();
  const revenue = revenueRow.reduce((s, r) => s + parsePrice(r.price), 0);

  const statusBreakdown = {};
  for (const r of db.prepare('SELECT status, COUNT(*) c FROM orders GROUP BY status').all())
    statusBreakdown[r.status] = r.c;
  const maintBreakdown = {};
  for (const r of db.prepare('SELECT status, COUNT(*) c FROM maintenance GROUP BY status').all())
    maintBreakdown[r.status] = r.c;

  const visitsTotal = db.prepare('SELECT COALESCE(SUM(count),0) c FROM visits').get().c;
  const visitsToday = db.prepare('SELECT COALESCE(count,0) c FROM visits WHERE day = ?').get(today).c;

  const series = [];
  for (let i = 13; i >= 0; i--) {
    const day = daysAgo(i);
    series.push({
      day,
      orders: count('orders', 'WHERE substr(created_at,1,10) = ?', [day]),
      maintenance: count('maintenance', 'WHERE substr(created_at,1,10) = ?', [day]),
      visits: db.prepare('SELECT COALESCE(count,0) c FROM visits WHERE day = ?').get(day).c,
    });
  }

  const recentOrders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 6').all();
  const recentMaint = db.prepare('SELECT * FROM maintenance ORDER BY created_at DESC LIMIT 6').all();

  ok(res, {
    kpi: {
      ordersTotal, ordersToday, ordersWeek, pendingOrders,
      maintTotal, maintToday, maintWeek, pendingMaint,
      productsTotal, visitsTotal, visitsToday, revenue,
      conversion: visitsTotal ? Number(((ordersTotal / visitsTotal) * 100).toFixed(1)) : 0,
    },
    statusBreakdown, maintBreakdown, series, recentOrders, recentMaint,
    orderStatusList: ORDER_STATUS, maintStatusList: MAINT_STATUS,
    generatedAt: nowISO(),
  });
});

/* ---- backup / restore ---- */
route('GET', '/api/backup', (req, res) => {
  if (!requireAuth(req, res)) return;
  ok(res, {
    exportedAt: nowISO(),
    orders: db.prepare('SELECT * FROM orders ORDER BY id').all(),
    maintenance: db.prepare('SELECT * FROM maintenance ORDER BY id').all(),
    products: db.prepare('SELECT * FROM products ORDER BY id').all(),
    visits: db.prepare('SELECT * FROM visits ORDER BY day').all(),
  });
});

route('POST', '/api/import', async (req, res, m, ctx) => {
  if (!requireAuth(req, res)) return;
  const b = ctx.body;
  let imported = 0;
  if (Array.isArray(b.orders)) {
    for (const o of b.orders) {
      if (!o || !o.customerName || !o.productTitle) continue;
      try {
        db.prepare(`
          INSERT INTO orders (ref, legacy_id, customer_name, phone, address, product_title, product_image, price, service_type, device, status, note, source, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?)
        `).run(
          o.ref || nextRef('orders', 'ORD'), o.id != null ? String(o.id) : null,
          String(o.customerName).slice(0, 120), String(o.phone || '').slice(0, 30),
          String(o.address || '').slice(0, 300), String(o.productTitle).slice(0, 300),
          String(o.productImage || '').slice(0, 400), String(o.price || '').slice(0, 60),
          String(o.serviceType || 'شراء').slice(0, 30), String(o.device || '').slice(0, 80),
          ORDER_STATUS.includes(o.status) ? o.status : 'جديد', String(o.note || '').slice(0, 500),
          o.date ? new Date(o.date).toISOString() : nowISO(), nowISO()
        );
        imported++;
      } catch { /* skip duplicates */ }
    }
  }
  if (Array.isArray(b.maintenanceRequests) || Array.isArray(b.maintenance)) {
    const list = b.maintenanceRequests || b.maintenance;
    for (const r of list) {
      if (!r || (!r.name && !r.customerName)) continue;
      try {
        db.prepare(`
          INSERT INTO maintenance (ref, legacy_id, name, phone, device, description, fault_images, status, note, source, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?)
        `).run(
          r.ref || nextRef('maintenance', 'MNT'), r.id != null ? String(r.id) : null,
          String(r.name || r.customerName).slice(0, 120), String(r.phone || '').slice(0, 30),
          String(r.device || '').slice(0, 80), String(r.desc || r.description || '').slice(0, 800),
          JSON.stringify(Array.isArray(r.faultImages) ? r.faultImages : []),
          MAINT_STATUS.includes(r.status) ? r.status : 'جديد', String(r.note || '').slice(0, 500),
          r.date ? new Date(r.date).toISOString() : nowISO(), nowISO()
        );
        imported++;
      } catch { /* skip */ }
    }
  }
  ok(res, { imported });
});

route('DELETE', '/api/demo', (req, res) => {
  if (!requireAuth(req, res)) return;
  const a = db.prepare(`DELETE FROM orders WHERE source = 'demo'`).run().changes;
  const b = db.prepare(`DELETE FROM maintenance WHERE source = 'demo'`).run().changes;
  ok(res, { deletedOrders: a, deletedMaint: b });
});

route('GET', '/api/health', (req, res) => {
  ok(res, { status: 'up', uptime: Math.round(process.uptime()), time: nowISO() });
});

/* ------------------------------ request server ----------------------------- */
function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.rx);
    if (m) return { route: r, params: m }; // full match: params[1] = first :id group
  }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
};

function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p === '/' || p === '') p = '/index.html';
  if (p === '/admin' || p === '/admin/') p = '/admin.html';
  const fp = path.normalize(path.join(PUBLIC_DIR, p));
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) {
      // SPA-ish fallback: unknown paths → store index (except /api)
      const idx = path.join(PUBLIC_DIR, 'index.html');
      if (p.startsWith('/api')) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: false, error: 'Not found' })); }
      return fs.readFile(idx, (e2, buf) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
    }
    const ext = path.extname(fp).toLowerCase();
    const isHTML = ext === '.html';
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': isHTML ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': st.size,
    };
    // /downloads/* → force browser download (direct download links)
    if (p.startsWith('/downloads/')) {
      headers['Content-Disposition'] = `attachment; filename="${path.basename(fp)}"`;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(fp).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  try {
    if (pathname.startsWith('/api/')) {
      // CORS (frontend may live on another host)
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      const hit = matchRoute(req.method, pathname);
      if (!hit) return fail(res, 404, 'Endpoint not found');
      const ctx = { query: Object.fromEntries(url.searchParams), body: {}, ip };
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        try { ctx.body = await readBody(req); }
        catch (e) { return fail(res, e.message === 'payload too large' ? 413 : 400, e.message); }
      }
      const finish = () => {
        console.log(`${req.method} ${pathname} → ${res.statusCode} (${Date.now() - started}ms)`);
      };
      res.on('finish', finish);
      return await hit.route.handler(req, res, hit.params, ctx);
    }
    if (['GET', 'HEAD'].includes(req.method)) return serveStatic(req, res, pathname);
    fail(res, 405, 'Method not allowed');
  } catch (err) {
    console.error('ERROR', req.method, pathname, err);
    if (!res.headersSent) fail(res, 500, 'خطأ داخلي في السيرفر');
    else res.end();
  }
});

/* --------------------------------- seeding --------------------------------- */
function seedProductsFromStore() {
  const existing = db.prepare('SELECT COUNT(*) c FROM products').get().c;
  if (existing > 0) return 0;
  try {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    const m = html.match(/const initialProducts\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) return 0;
    const list = eval(m[1]);
    const ins = db.prepare(
      'INSERT INTO products (title, price, category, image, description, active) VALUES (?, ?, ?, ?, ?, 1)'
    );
    let n = 0;
    for (const p of list) {
      try {
        ins.run(String(p.title || '').slice(0, 300), String(p.price || '').slice(0, 80),
                String(p.category || '').slice(0, 60), String(p.image || '').slice(0, 400000),
                String(p.description || p.title || '').slice(0, 1000));
        n++;
      } catch (e) { console.error('seed product failed:', e.message); }
    }
    return n;
  } catch (e) {
    console.error('seedProducts error:', e.message);
    return 0;
  }
}

function seedDemo() {
  if (!SEED_DEMO) return;
  if (db.prepare('SELECT COUNT(*) c FROM orders').get().c > 0) return;
  const D = (daysBack, h, min) => {
    const d = new Date(Date.now() - daysBack * 864e5);
    d.setHours(h, min, 0, 0);
    if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1); // never in the future
    return d.toISOString();
  };
  const demoOrders = [
    ['أحمد سمير عبد الرحمن', '01012345678', 'عين شمس الشرقية - شارع أحمد عصمت', 'عرض العروسة الاقتصادي - (خلاط ثلج + كبة 3 لتر)', '1650 جنيه', 'جديد', 0, 10, 30],
    ['منى عبد الله شعبان', '01122334455', 'مدينة نصر - شارع مصطفى النحاس', 'أباجورة كريستال ليد Creative Table Lamp', '320 جنيه', 'تم التواصل', 1, 12, 15],
    ['كريم فؤاد إبراهيم', '01234567890', 'المحلة الكبرى - شارع البحر', 'خلاط مطحون Silver Crest SC-1589 الأصلي', '850 جنيه', 'تم التأكيد', 2, 17, 45],
    ['سارة محمود زكي', '01098765432', 'المعادي - شارع 9', 'كوشنات مخدات بمناسبة رمضان', '50 جنيه', 'مكتمل', 4, 11, 5],
    ['مصطفى حسن الجندي', '01555667788', 'طنطا - شارع الجيش', 'واجهة عرض الخلاطات - Silver Crest + Braun + Kenwood', '550 جنيه', 'قيد المراجعة', 5, 14, 20],
    ['هبة رمضان السيد', '01011223345', 'الإسكندرية - سموحة', 'تشكيلة الكبات والخلاطات - كبة Food 3L', 'يبدأ من 270 جنيه', 'جديد', 0, 9, 10],
    ['عم جمال الدسوقي', '01277889900', 'شبرا الخيمة - شارع الترعة', 'عرض العروسة المتكامل الفاخر', '1850 جنيه', 'تم الشحن', 3, 16, 0],
    ['نيرة صالح مرسي', '01099887766', 'الجيزة - فيصل', 'كوشنات رمضان - الوش شنيط والظهر دك', '60 جنيه', 'ملغي', 6, 13, 40],
  ];
  const insO = db.prepare(`
    INSERT INTO orders (ref, customer_name, phone, address, product_title, price, status, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'demo', ?, ?)
  `);
  demoOrders.forEach((o, i) => {
    const ts = D(o[6], o[7], o[8]);
    insO.run(`ORD-DEMO-${String(i + 1).padStart(3, '0')}`, o[0], o[1], o[2], o[3], o[4], o[5], ts, ts);
  });

  const demoMaint = [
    ['محمود حسن عبد العزيز', '01007889396', 'غسالة أوتوماتيك', 'الغسالة لا تقوم بالعصر نهائياً وتُصدر صوت عالي', 'قيد الصيانة', 0, 9, 15],
    ['نورا سامي فتحي', '01234567891', 'تلاجة لاندو', 'التلاجة لا تبرد واللمبة الحمراء مضاءة', 'جديد', 1, 15, 30],
    ['عم رجب السيد', '01144556677', 'سخان كهرباء', 'يفصل بعد دقائق من التشغيل', 'جاهز', 3, 10, 0],
  ];
  const insM = db.prepare(`
    INSERT INTO maintenance (ref, name, phone, device, description, status, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'demo', ?, ?)
  `);
  demoMaint.forEach((r, i) => {
    const ts = D(r[5], r[6], r[7]);
    insM.run(`MNT-DEMO-${String(i + 1).padStart(3, '0')}`, r[0], r[1], r[2], r[3], r[4], ts, ts);
  });

  // visits history for the charts
  const insV = db.prepare(`INSERT INTO visits (day, count) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET count = count + excluded.count`);
  const pattern = [12, 18, 9, 25, 31, 22, 17, 14, 28, 35, 19, 24, 30, 21];
  pattern.forEach((c, i) => {
    const day = new Date(Date.now() - (13 - i) * 864e5).toISOString().slice(0, 10);
    insV.run(day, c);
  });
  console.log('✓ Seeded demo data (orders/maintenance/visits) — delete from الإعدادات when ready.');
}

/* -------------------- legacy CrudCrud migration (one-time) ------------------ */
const CRUD = 'https://crudcrud.com/api/022658cbdb3443a98f77ec6c6872ddf3';
const LEGACY_SKIP = new Set(['101', '201']); // old hardcoded demo rows

async function migrateCrudCrud() {
  if (!MIGRATE_CRUD) return;
  if (getSetting('crud_migrated') === '1') return;
  const targets = [
    ['mohandis_orders_v2', 'orders'],
    ['mohandis_maint_v2', 'maintenance'],
    ['mohandis_products_v3', 'products'],
  ];
  let total = 0;
  for (const [resource, table] of targets) {
    try {
      const ctrl = AbortSignal.timeout(8000);
      const r = await fetch(`${CRUD}/${resource}`, { signal: ctrl });
      if (!r.ok) continue;
      const list = await r.json();
      if (!Array.isArray(list) || !list.length) continue;
      for (const item of list) {
        const legacy = String(item._id || '');
        if (!legacy || LEGACY_SKIP.has(String(item.id))) continue;
        try {
          if (table === 'orders') {
            db.prepare(`INSERT OR IGNORE INTO orders (ref, legacy_id, customer_name, phone, address, product_title, product_image, price, service_type, device, status, source, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy', ?, ?)`).run(
              nextRef('orders', 'ORD'), legacy,
              String(item.customerName || '').slice(0, 120), String(item.phone || '').slice(0, 30),
              String(item.address || '').slice(0, 300), String(item.productTitle || '').slice(0, 300),
              String(item.productImage || '').slice(0, 400), String(item.price || '').slice(0, 60),
              String(item.serviceType || 'شراء').slice(0, 30), String(item.device || '').slice(0, 80),
              ORDER_STATUS.includes(item.status) ? item.status : 'جديد',
              item._createdAt || nowISO(), nowISO());
          } else if (table === 'maintenance') {
            db.prepare(`INSERT OR IGNORE INTO maintenance (ref, legacy_id, name, phone, device, description, fault_images, status, source, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'legacy', ?, ?)`).run(
              nextRef('maintenance', 'MNT'), legacy,
              String(item.name || '').slice(0, 120), String(item.phone || '').slice(0, 30),
              String(item.device || '').slice(0, 80), String(item.desc || item.description || '').slice(0, 800),
              JSON.stringify(Array.isArray(item.faultImages) ? item.faultImages : []),
              MAINT_STATUS.includes(item.status) ? item.status : 'جديد',
              item._createdAt || nowISO(), nowISO());
          } else {
            db.prepare(`INSERT OR IGNORE INTO products (legacy_id, title, price, category, image, description, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
              legacy, String(item.title || '').slice(0, 300), String(item.price || '').slice(0, 80),
              String(item.category || '').slice(0, 60), String(item.image || '').slice(0, 400000),
              String(item.description || '').slice(0, 1000), item._createdAt || nowISO(), nowISO());
          }
          total++;
        } catch { /* duplicate or invalid */ }
      }
    } catch (e) {
      console.log('CrudCrud migration skipped for', resource, '—', e.message);
    }
  }
  setSetting('crud_migrated', '1');
  if (total) console.log(`✓ Migrated ${total} records from the old CrudCrud cloud`);
}

/* ---------------------------------- boot ----------------------------------- */
seedProductsFromStore();
seedDemo();
migrateCrudCrud().catch(() => {});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║   مركز المهندس الشامل — Professional Server          ║');
  console.log('  ╠══════════════════════════════════════════════════════╣');
  console.log(`  ║   Storefront : http://localhost:${PORT}/                 ║`);
  console.log(`  ║   Dashboard  : http://localhost:${PORT}/admin              ║`);
  console.log(`  ║   API        : http://localhost:${PORT}/api                ║`);
  console.log(`  ║   Database   : ${path.basename(DB_PATH).padEnd(38)} ║`);
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { db.close(); } catch {} process.exit(0); });
}
