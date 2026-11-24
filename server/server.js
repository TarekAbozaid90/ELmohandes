#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { configureDatabase } = require('./database');
const { ensureSchema } = require('./schema');
const { normalizeStock } = require('./stock');
const { safeImageReference } = require('./storage');
const { normalizeEgyptianMobile, validateContact, readContact, renderContact } = require('./contact');
const { MAX_BACKUP_BYTES, createBackup, validateBackup, mergeBackup } = require('./backup');
const catalog = require('./catalog.json');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const BOOT_PASSWORD = process.env.ADMIN_PASSWORD || 'admin12345';
const PRODUCTION = process.env.RENDER === 'true' || process.env.NODE_ENV === 'production' || Boolean(process.env.PERSISTENT_DISK_PATH);
const SEED_DEMO = process.env.SEED_DEMO === '1';
const BODY_LIMIT = 5 * 1024 * 1024;
let storage, db, uploads;

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

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const length = Number(req.headers['content-length']);
    if (length > limit) { req.resume(); reject(new Error('payload too large')); return; }
    let size = 0, tooLarge = false;
    const chunks = [];
    req.on('data', chunk => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) { tooLarge = true; chunks.length = 0; reject(new Error('payload too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!chunks.length) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch { reject(new Error('invalid JSON')); }
    });
    req.on('aborted', () => reject(new Error('request aborted')));
    req.on('error', reject);
  });
}

function parsePrice(text) {
  const m = String(text || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).match(/\d+/);
  return m ? Number(m[0]) : 0;
}

/* ------------------------------- auth layer -------------------------------- */
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 32).toString('hex');
const makeSecret = () => crypto.randomBytes(32).toString('hex');
const proof = (secret, exp) => crypto.createHmac('sha256', secret).update(`admin:${exp}`).digest('hex');
async function getSetting(key, conn = db) {
  return (await conn.get('SELECT value FROM settings WHERE key = ?', key))?.value ?? null;
}
const setSetting = (key, value, conn = db) => conn.run(`INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, String(value));
async function credentials(conn = db) {
  const rows = await conn.all("SELECT key, value FROM settings WHERE key IN ('admin_salt', 'admin_hash')");
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
function passMatches(password, { admin_salt: salt, admin_hash: hash }) {
  if (!salt || !/^[a-f0-9]{64}$/.test(hash)) return false;
  return crypto.timingSafeEqual(Buffer.from(hashPassword(password, salt), 'hex'), Buffer.from(hash, 'hex'));
}
function issueToken(secret) {
  const exp = Date.now() + 30 * 864e5;
  return { token: `mhs.${exp}.${proof(secret, exp)}`, expiresAt: new Date(exp).toISOString() };
}
async function requireAuth(req, res) {
  const raw = req.headers.authorization?.match(/^Bearer mhs\.(\d{1,16})\.([a-f0-9]{64})$/);
  const exp = raw ? Number(raw[1]) : 0;
  if (Number.isSafeInteger(exp) && exp > Date.now()) {
    const secret = await getSetting('auth_secret');
    if (secret && crypto.timingSafeEqual(Buffer.from(raw[2], 'hex'), Buffer.from(proof(secret, exp), 'hex'))) return true;
  }
  fail(res, 401, 'انتهت الجلسة — سجّل الدخول مرة أخرى');
  return false;
}

/* -------------------------------- refs ------------------------------------- */
async function nextRef(tx, table, prefix) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const start = `${prefix}-${day}-`;
  const prior = await tx.all(`SELECT ref FROM ${table} WHERE ref LIKE ?`, start + '%');
  let n = 1;
  for (const { ref } of prior) {
    const tail = ref.slice(start.length);
    if (/^\d{1,9}$/.test(tail)) n = Math.max(n, Number(tail) + 1);
  }
  // Atomic within the same transaction as the insert; concurrent orders cannot share a reference.
  const { value } = await tx.get(`INSERT INTO ref_counters (prefix, value) VALUES (?, ?)
    ON CONFLICT(prefix) DO UPDATE SET value = CASE WHEN excluded.value > ref_counters.value
      THEN excluded.value ELSE ref_counters.value + 1 END RETURNING value`, start, n);
  return start + String(value).padStart(3, '0');
}

const clampInteger = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
};
const safeId = value => /^\d{1,10}$/.test(value) && Number(value) > 0 && Number(value) <= 2147483647 ? Number(value) : 0;
const discount = value => Math.floor(Math.max(0, Math.min(100, Number(value) || 0)));
function imageInput(value) {
  if (value == null || value === '') return '';
  const image = safeImageReference(value);
  if (!image) throw new Error('الصورة غير صالحة أو حجمها أكبر من الحدّ المسموح.');
  return image;
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
  if (typeof password !== 'string' || !password || password.length > 256) return fail(res, 400, 'أدخل كلمة المرور');
  const result = await db.transaction(async tx => {
    const user = await credentials(tx);
    if (!passMatches(password, user)) return null;
    return issueToken(await getSetting('auth_secret', tx));
  }, { snapshot: true });
  if (!result) return fail(res, 401, 'كلمة المرور غير صحيحة');
  ok(res, result);
}, { bodyLimit: 4096 });

route('POST', '/api/auth/change-password', async (req, res, m, ctx) => {
  const { currentPassword, newPassword } = ctx.body;
  if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 256 ||
      typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 256)
    return fail(res, 400, 'كلمة المرور الجديدة لازم تكون بين ٦ و٢٥٦ حرفًا');
  const changed = await db.transaction(async tx => {
    if (db.dialect === 'postgres') await tx.get('SELECT pg_advisory_xact_lock(41803722)');
    if (!passMatches(currentPassword, await credentials(tx))) return false;
    const salt = crypto.randomBytes(16).toString('hex');
    await setSetting('admin_salt', salt, tx);
    await setSetting('admin_hash', hashPassword(newPassword, salt), tx);
    await setSetting('auth_secret', makeSecret(), tx);
    return true;
  });
  if (!changed) return fail(res, 401, 'كلمة المرور الحالية غير صحيحة');
  ok(res, { message: 'تم تغيير كلمة المرور — سجّل الدخول من جديد' });
}, { auth: true, bodyLimit: 4096 });

/* ---- orders and maintenance ---- */
function registerRequests(config) {
  const { path: routePath, table, prefix, statuses, searchable, notFound } = config;
  route('GET', routePath, async (req, res, m, ctx) => {
    const q = ctx.query, where = [], args = [];
    if (q.status && q.status !== 'الكل') { where.push('status = ?'); args.push(q.status); }
    if (q.search) {
      where.push('(' + searchable.map(field => `LOWER(${field}) LIKE LOWER(?)`).join(' OR ') + ')');
      args.push(...searchable.map(() => `%${q.search}%`));
    }
    if (q.since) { where.push('updated_at > ?'); args.push(q.since); }
    const limit = clampInteger(q.limit, 1, 500, 200);
    const page = clampInteger(q.page, 1, 1000000, 1);
    const filter = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [total, items] = await Promise.all([
      db.get(`SELECT COUNT(*) c FROM ${table} ${filter}`, ...args),
      db.all(`SELECT * FROM ${table} ${filter} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, ...args, limit, (page - 1) * limit),
    ]);
    ok(res, { items, total: Number(total.c), page, limit });
  }, { auth: true });

  route('POST', routePath, async (req, res, m, ctx) => {
    if (!rateLimit(res, ctx.ip, table, 30, 60000)) return;
    const b = ctx.body;
    const phone = normalizeEgyptianMobile(b.phone);
    const name = esc(table === 'orders' ? b.customerName : b.name).slice(0, 120);
    if (name.length < 2) return fail(res, 400, 'اسم العميل مطلوب');
    if (!phone) return fail(res, 400, 'رقم هاتف مصري صحيح مطلوب (مثال: 01001234567)');
    const address = esc(b.address).slice(0, 300), device = esc(b.device).slice(0, 80);
    if (table === 'orders') {
      const title = esc(b.productTitle).slice(0, 300);
      if (!title) return fail(res, 400, 'المنتج مطلوب');
      let image = safeImageReference(b.productImage);
      if (image.startsWith('data:')) image = '';  // Current storefront uses the canonical image URLs.
      const order = await db.transaction(async tx => tx.get(`INSERT INTO orders
        (ref, customer_name, phone, address, product_title, product_image, price, service_type, device, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        await nextRef(tx, table, prefix), name, phone, address, title, image,
        esc(b.price).slice(0, 60), esc(b.serviceType).slice(0, 30) || 'شراء', device, esc(b.note).slice(0, 500)));
      return ok(res, order, 201);
    }
    const description = esc(b.description).slice(0, 800);
    if (!device && !description) return fail(res, 400, 'اكتب نوع الجهاز ووصف العطل');
    let photos = [];
    try { if (Array.isArray(b.faultImages)) photos = b.faultImages.slice(0, 2).filter(Boolean).map(imageInput); }
    catch (error) { return fail(res, 400, error.message); }
    const request = await db.transaction(async tx => {
      const images = [];
      const ref = await nextRef(tx, table, prefix);
      for (const p of photos) images.push(await uploads.store(p, tx));
      return tx.get(`INSERT INTO maintenance (ref, name, phone, device, description, fault_images, address)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`, ref, name, phone, device, description, JSON.stringify(images), address);
    });
    ok(res, request, 201);
  });

  route('PATCH', routePath + '/:id', async (req, res, m, ctx) => {
    const b = ctx.body, id = safeId(m[1]);
    if (!id) return fail(res, 404, notFound);
    const status = b.status !== undefined ? esc(b.status) : null;
    if (status !== null && !statuses.includes(status)) return fail(res, 400, 'حالة غير صالحة');
    const row = await db.get(`UPDATE ${table} SET status = COALESCE(?, status), note = COALESCE(?, note), updated_at = ? WHERE id = ? RETURNING *`,
      status, b.note !== undefined ? esc(b.note).slice(0, 500) : null, nowISO(), id);
    if (!row) return fail(res, 404, notFound);
    ok(res, row);
  }, { auth: true });

  route('DELETE', routePath + '/:id', async (req, res, m) => {
    const id = safeId(m[1]);
    if (!id || !(await db.run(`DELETE FROM ${table} WHERE id = ?`, id)).changes) return fail(res, 404, notFound);
    ok(res, { deleted: true });
  }, { auth: true });
}
registerRequests({ path: '/api/orders', table: 'orders', prefix: 'ORD', statuses: ORDER_STATUS,
  searchable: ['customer_name', 'phone', 'product_title', 'ref', 'address'], notFound: 'الطلب غير موجود' });
registerRequests({ path: '/api/maintenance', table: 'maintenance', prefix: 'MNT', statuses: MAINT_STATUS,
  searchable: ['name', 'phone', 'device', 'description', 'ref'], notFound: 'طلب الصيانة غير موجود' });

/* ---- products / private inventory ---- */
route('GET', '/api/products', async (req, res) => {
  // Explicit column allowlist. This remains public even if the browser has a dashboard session.
  ok(res, await db.all(`SELECT id, title, price, old_price, discount_percent, category, image, description, active
    FROM products WHERE active = 1 ORDER BY id DESC`));
});
route('GET', '/api/admin/products', async (req, res) => {
  ok(res, await db.all('SELECT * FROM products ORDER BY id DESC'));
}, { auth: true });

const stockValue = body => normalizeStock(Object.hasOwn(body, 'stockQuantity') ? body.stockQuantity : body.stock_quantity);
route('POST', '/api/products', async (req, res, m, ctx) => {
  const b = ctx.body;
  const title = esc(b.title);
  if (title.length < 2) return fail(res, 400, 'اسم المنتج مطلوب');
  let image, stock;
  try { stock = stockValue(b); image = imageInput(b.image); }
  catch (error) { return fail(res, 400, error.message); }
  const row = await db.transaction(async tx => tx.get(`INSERT INTO products
    (title, price, old_price, discount_percent, category, image, description, active, stock_quantity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`, title.slice(0, 300), esc(b.price).slice(0, 80),
    esc(b.oldPrice ?? b.old_price).slice(0, 80), discount(b.discountPercent ?? b.discount_percent), esc(b.category).slice(0, 60),
    await uploads.store(image, tx), esc(b.description).slice(0, 1000), [false, 0, '0'].includes(b.active) ? 0 : 1, stock));
  ok(res, row, 201);
}, { auth: true });

route('PUT', '/api/products/:id', async (req, res, m, ctx) => {
  const id = safeId(m[1]);
  if (!id) return fail(res, 404, 'المنتج غير موجود');
  const b = ctx.body;
  const cols = [], values = [];
  const add = (col, value) => { cols.push(col + ' = ?'); values.push(value); };
  let image;
  try {
    if (Object.hasOwn(b, 'stockQuantity') || Object.hasOwn(b, 'stock_quantity')) add('stock_quantity', stockValue(b));
    if (Object.hasOwn(b, 'image')) image = imageInput(b.image);
  } catch (error) { return fail(res, 400, error.message); }
  if (Object.hasOwn(b, 'title') && esc(b.title).length < 2) return fail(res, 400, 'اسم المنتج مطلوب');
  for (const [field, len] of [['title', 300], ['price', 80], ['category', 60], ['description', 1000]]) {
    if (Object.hasOwn(b, field)) add(field, esc(b[field]).slice(0, len));
  }
  if (b.oldPrice !== undefined || b.old_price !== undefined) add('old_price', esc(b.oldPrice ?? b.old_price).slice(0, 80));
  if (b.discountPercent !== undefined || b.discount_percent !== undefined) add('discount_percent', discount(b.discountPercent ?? b.discount_percent));
  if (b.active !== undefined) add('active', [false, 0, '0'].includes(b.active) ? 0 : 1);
  const row = await db.transaction(async tx => {
    if (image !== undefined) {
      if (!await tx.get('SELECT id FROM products WHERE id = ?', id)) return null;
      add('image', await uploads.store(image, tx));
    }
    add('updated_at', nowISO());
    return tx.get(`UPDATE products SET ${cols.join(', ')} WHERE id = ? RETURNING *`, ...values, id);
  });
  if (!row) return fail(res, 404, 'المنتج غير موجود');
  ok(res, row);
}, { auth: true });

route('DELETE', '/api/products/:id', async (req, res, m) => {
  const id = safeId(m[1]);
  if (!id || !(await db.run('DELETE FROM products WHERE id = ?', id)).changes) return fail(res, 404, 'المنتج غير موجود');
  ok(res, { deleted: true });
}, { auth: true });

/* ---- visits ---- */
route('POST', '/api/visits/track', async (req, res, m, ctx) => {
  if (!rateLimit(res, ctx.ip, 'visit', 120, 60000)) return;
  const day = nowISO().slice(0, 10);
  const ua = esc(req.headers['user-agent']).slice(0, 500);
  const device = /mobile|android|iphone|ipad/i.test(ua) ? 'موبايل / تابلت' : 'كمبيوتر';
  await db.transaction(async tx => {
    await tx.run('INSERT INTO visits (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = visits.count + 1', day);
    await tx.run('INSERT INTO visitor_logs (ip, page, referrer, user_agent, device) VALUES (?, ?, ?, ?, ?)',
      String(ctx.ip || 'غير معروف').slice(0, 80), esc(ctx.body.page).slice(0, 300) || '/', esc(ctx.body.referrer).slice(0, 500), ua, device);
  });
  ok(res, { tracked: true });
}, { bodyLimit: 16384 });

route('GET', '/api/visitors', async (req, res, m, ctx) => {
  const limit = clampInteger(ctx.query.limit, 1, 1000, 200);
  const [items, counts] = await Promise.all([
    db.all('SELECT id, ip, page, referrer, user_agent, device, created_at FROM visitor_logs ORDER BY id DESC LIMIT ?', limit),
    db.get('SELECT COUNT(*) total, COUNT(DISTINCT ip) unique_ips FROM visitor_logs'),
  ]);
  ok(res, { items, total: Number(counts.total), uniqueIPs: Number(counts.unique_ips) });
}, { auth: true });

/* ---- stats ---- */
function rollup(rows, done, today, week) {
  const breakdown = Object.create(null), daily = Object.create(null);
  let total = 0, byWeek = 0, pending = 0;
  for (const row of rows) {
    const c = Number(row.c);
    total += c;
    if (row.day >= week && row.day <= today) byWeek += c;
    if (row.status && !done.includes(row.status)) pending += c;
    daily[row.day] = (daily[row.day] || 0) + c;
    breakdown[row.status] = (breakdown[row.status] || 0) + c;
  }
  return { breakdown, daily, total, byWeek, pending };
}
route('GET', '/api/stats', async (req, res) => {
  const time = Date.now();
  const dayAgo = n => new Date(time - n * 864e5).toISOString().slice(0, 10);
  const today = dayAgo(0), week = dayAgo(6), since14 = dayAgo(13);
  const grouped = table => db.all(`SELECT status, substr(created_at,1,10) AS day, COUNT(*) AS c FROM ${table} GROUP BY status, substr(created_at,1,10)`);
  const [orderGroups, maintGroups, counts, visitDays, sales, recentOrders, recentMaint, storageStatus] = await Promise.all([
    grouped('orders'), grouped('maintenance'), db.get(`SELECT (SELECT COUNT(*) FROM products) products,
       (SELECT COALESCE(SUM(count),0) FROM visits) visits`),
    db.all('SELECT day, count FROM visits WHERE day BETWEEN ? AND ?', since14, today),
    db.all("SELECT price FROM orders WHERE status <> 'ملغي'"),
    db.all('SELECT * FROM orders ORDER BY created_at DESC LIMIT 6'),
    db.all('SELECT * FROM maintenance ORDER BY created_at DESC LIMIT 6'), storage.status(),
  ]);
  const o = rollup(orderGroups, ['مكتمل', 'ملغي'], today, week), m = rollup(maintGroups, ['تم التسليم', 'ملغي'], today, week);
  const v = Object.fromEntries(visitDays.map(row => [row.day, row.count]));
  const visitsTotal = Number(counts.visits);
  const series = Array.from({ length: 14 }, (_, i) => {
    const day = dayAgo(13 - i);
    return { day, orders: o.daily[day] || 0, maintenance: m.daily[day] || 0, visits: v[day] || 0 };
  });
  ok(res, { kpi: {
    ordersTotal: o.total, ordersToday: o.daily[today] || 0, ordersWeek: o.byWeek, pendingOrders: o.pending,
    maintTotal: m.total, maintToday: m.daily[today] || 0, maintWeek: m.byWeek, pendingMaint: m.pending,
    productsTotal: Number(counts.products), visitsTotal, visitsToday: v[today] || 0,
    revenue: sales.reduce((sum, row) => sum + parsePrice(row.price), 0),
    conversion: visitsTotal ? Number((100 * o.total / visitsTotal).toFixed(1)) : 0,
  }, statusBreakdown: o.breakdown, maintBreakdown: m.breakdown, series, recentOrders, recentMaint,
  orderStatusList: ORDER_STATUS, maintStatusList: MAINT_STATUS, generatedAt: nowISO(), storage: storageStatus });
}, { auth: true });

/* ---- editable contact page ---- */
const CONTACT_KEY = 'contact_page_v1';
const getContact = async (conn = db) => readContact(await getSetting(CONTACT_KEY, conn));
const saveContact = (value, conn = db) => setSetting(CONTACT_KEY, JSON.stringify(value), conn);
async function restoreContact(value, conn) {
  return Boolean((await conn.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
    CONTACT_KEY, JSON.stringify(value))).changes);
}
route('GET', '/api/contact', async (req, res) => ok(res, await getContact()));
route('PUT', '/api/contact', async (req, res, m, ctx) => {
  let value;
  try { value = validateContact(ctx.body); }
  catch (error) { return fail(res, 400, error.message); }
  await saveContact(value);
  ok(res, value);
}, { auth: true, bodyLimit: 16 * 1024 });

async function serveContact(req, res, pathname) {
  if (pathname !== '/qr') {
    res.writeHead(301, { Location: '/qr', 'Cache-Control': 'no-cache' });
    return res.end();
  }
  const html = renderContact(await getContact());
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(html), 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'",
  });
  res.end(req.method === 'HEAD' ? undefined : html);
}

/* ---- backup / restore ---- */
route('GET', '/api/backup', async (req, res, m, ctx) => {
  const scope = ctx.query.scope === 'products' ? 'products' : 'full';
  const backup = await createBackup(db, uploads, getContact, scope);
  if (!backup) return fail(res, 413, scope === 'full'
    ? 'النسخة الكاملة أكبر من 32 ميجابايت. جرّب «نسخة المنتجات» أو راجع دليل النسخ من قاعدة البيانات.'
    : 'نسخة المنتجات أكبر من 32 ميجابايت. راجع دليل النسخ من قاعدة البيانات.');
  ok(res, backup);
}, { auth: true });
route('POST', '/api/import', async (req, res, m, ctx) => {
  let validated;
  try { validated = validateBackup(ctx.body); }
  catch (error) { return fail(res, 400, error.message); }
  ok(res, await mergeBackup(db, uploads, validated, { nextRef, orderStatus: ORDER_STATUS, maintStatus: MAINT_STATUS, restoreContact }));
}, { auth: true, bodyLimit: MAX_BACKUP_BYTES });
route('DELETE', '/api/demo', async (req, res) => {
  const response = await db.transaction(async tx => ({
    deletedOrders: (await tx.run("DELETE FROM orders WHERE source = 'demo'")).changes,
    deletedMaint: (await tx.run("DELETE FROM maintenance WHERE source = 'demo'")).changes,
  }));
  ok(res, response);
}, { auth: true });

// Liveness only: this must not keep the external database awake when the shop is idle.
route('GET', '/api/health', (req, res) => ok(res, { status: 'up', uptime: Math.round(process.uptime()), time: nowISO() }));

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

async function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p === '/' || p === '') p = '/index.html';
  if (p === '/admin' || p === '/admin/') p = '/admin.html';
  if (p === '/uploads' || p.startsWith('/uploads/')) {
    const head = req.method === 'HEAD';
    const info = await uploads.read(p, undefined, head);
    if (!info) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end(); }
    const etag = `"${info.name}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'public, max-age=86400, immutable' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': info.type, 'Content-Length': info.size, ETag: etag,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=86400, immutable' });
    return res.end(head ? undefined : info.body);
  }
  const fp = path.resolve(PUBLIC_DIR, '.' + p);
  if (!fp.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) {
      if (path.extname(p)) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end(); }
      // SPA-ish fallback for old navigation routes.
      const idx = path.join(PUBLIC_DIR, 'index.html');
      if (p.startsWith('/api')) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: false, error: 'Not found' })); }
      return fs.readFile(idx, (e2, buf) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : buf);
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
    const stream = fs.createReadStream(fp);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return fail(res, 400, 'عنوان الطلب غير صالح.'); }
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
      if (hit.route.opts.auth && !await requireAuth(req, res)) { req.resume(); return; }
      const ctx = { query: Object.fromEntries(url.searchParams), body: {}, ip };
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        try { ctx.body = await readBody(req, hit.route.opts.bodyLimit || BODY_LIMIT); }
        catch (e) {
          if (e.message === 'payload too large') return fail(res, 413, 'الملف أكبر من الحدّ المسموح.');
          return fail(res, 400, 'صيغة البيانات غير صالحة.');
        }
      }
      const finish = () => {
        console.log(`${req.method} ${pathname} → ${res.statusCode} (${Date.now() - started}ms)`);
      };
      res.on('finish', finish);
      return await hit.route.handler(req, res, hit.params, ctx);
    }
    if (['GET', 'HEAD'].includes(req.method)) {
      if (/^\/qr(?:\/|\.html)?$/i.test(pathname)) return await serveContact(req, res, pathname);
      return await serveStatic(req, res, pathname);
    }
    fail(res, 405, 'Method not allowed');
  } catch (err) {
    console.error('ERROR', req.method, pathname, err.code || err.name, PRODUCTION ? '' : err.message);
    if (res.headersSent) return res.end();
    const code = String(err.code || '');
    if (code === '53100' || code === 'SQLITE_FULL') return fail(res, 507, 'مساحة التخزين امتلأت. تواصل مع الإدارة.');
    if (db.dialect === 'postgres' && (/^(08|53|57P|ECON|ETIMEDOUT|EHOST|ENET|ENOTFOUND|EAI_)/.test(code) ||
        /connection terminated|timeout exceeded|compute time|quota/i.test(err.message))) {
      return fail(res, 503, 'قاعدة البيانات غير متاحة حاليًا. جرّب مرة تانية بعد قليل.');
    }
    fail(res, 500, 'خطأ داخلي في السيرفر');
  }
});

async function seedDemo(tx) {
  if (!SEED_DEMO) return;
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
  const insO = `
    INSERT INTO orders (ref, customer_name, phone, address, product_title, price, status, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'demo', ?, ?)
  `;
  for (const [i, o] of demoOrders.entries()) {
    const ts = D(o[6], o[7], o[8]);
    await tx.run(insO, `ORD-DEMO-${String(i + 1).padStart(3, '0')}`, o[0], o[1], o[2], o[3], o[4], o[5], ts, ts);
  }

  const demoMaint = [
    ['محمود حسن عبد العزيز', '01007889396', 'غسالة أوتوماتيك', 'الغسالة لا تقوم بالعصر نهائياً وتُصدر صوت عالي', 'قيد الصيانة', 0, 9, 15],
    ['نورا سامي فتحي', '01234567891', 'تلاجة لاندو', 'التلاجة لا تبرد واللمبة الحمراء مضاءة', 'جديد', 1, 15, 30],
    ['عم رجب السيد', '01144556677', 'سخان كهرباء', 'يفصل بعد دقائق من التشغيل', 'جاهز', 3, 10, 0],
  ];
  const insM = `
    INSERT INTO maintenance (ref, name, phone, device, description, status, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'demo', ?, ?)
  `;
  for (const [i, r] of demoMaint.entries()) {
    const ts = D(r[5], r[6], r[7]);
    await tx.run(insM, `MNT-DEMO-${String(i + 1).padStart(3, '0')}`, r[0], r[1], r[2], r[3], r[4], ts, ts);
  }

  // visits history for the charts
  const insV = `INSERT INTO visits (day, count) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET count = visits.count + excluded.count`;
  const pattern = [12, 18, 9, 25, 31, 22, 17, 14, 28, 35, 19, 24, 30, 21];
  for (const [i, c] of pattern.entries()) {
    const day = new Date(Date.now() - (13 - i) * 864e5).toISOString().slice(0, 10);
    await tx.run(insV, day, c);
  }
  console.log('✓ Seeded demo data (orders/maintenance/visits) — delete from الإعدادات when ready.');
}

/* ---------------------------------- boot ----------------------------------- */
async function boot() {
  storage = configureDatabase(ROOT);
  ({ db, uploads } = storage);
  await ensureSchema(db);
  await db.transaction(async tx => {
    if (db.dialect === 'postgres') await tx.get('SELECT pg_advisory_xact_lock(41803722)');
    const existing = Boolean(await getSetting('admin_hash', tx));
    if (!existing) {
      if (PRODUCTION && (BOOT_PASSWORD === 'admin12345' || BOOT_PASSWORD.trim().length < 12)) {
        throw new Error('Set a strong ADMIN_PASSWORD (at least 12 characters) before first deployment.');
      }
      const salt = crypto.randomBytes(16).toString('hex');
      await setSetting('admin_salt', salt, tx);
      await setSetting('admin_hash', hashPassword(BOOT_PASSWORD, salt), tx);
    }
    if (!await getSetting('auth_secret', tx)) await setSetting('auth_secret', makeSecret(), tx);
    if (await getSetting('catalog_initialized', tx) !== '1') {
      const { c } = await tx.get('SELECT COUNT(*) c FROM products');
      if (!existing && !Number(c) && process.env.SEED_CATALOG !== '0') {
        const insert = `INSERT INTO products (title, price, old_price, discount_percent, category, image, description)
          VALUES (?, ?, ?, ?, ?, ?, ?)`;
        for (const p of catalog) await tx.run(insert, p.title, p.price, p.oldPrice || '', p.discountPercent || 0, p.category, p.image, p.description || p.title);
      }
      await setSetting('catalog_initialized', '1', tx);
    }
    if (!existing) await seedDemo(tx);
  });
  server.listen(PORT, HOST, () => {
    console.log(`ElMohandes listening on ${HOST}:${server.address().port} — dashboard /admin · contact /qr`);
    console.log('Storage: ' + ({ postgres: 'external PostgreSQL (catalog, stock, settings and uploads)',
      mounted: 'persistent mounted disk', local: 'local filesystem (development)' })[storage.mode]);
  });
}
boot().catch(async error => {
  const msg = db?.dialect === 'postgres' && !/^Set a strong ADMIN_PASSWORD/.test(error.message)
    ? `PostgreSQL startup failed (${error.code || 'connection or schema error'}). Check DATABASE_URL, the database status and role permissions.` : error.message;
  console.error(msg);
  await db?.close().catch(() => {});
  process.exitCode = 1;
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    server.close(async () => { try { await db?.close(); } finally { process.exit(0); } });
    setTimeout(() => process.exit(1), 8000).unref();
  });
}
