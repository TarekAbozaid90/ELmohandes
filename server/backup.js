'use strict';

const { UPLOAD_PATH, validateBackupImage } = require('./storage');
const { validateContact } = require('./contact');
const { normalizeStock } = require('./stock');
const MAX_BACKUP_BYTES = 32 * 1024 * 1024;
const s = (v, n) => String(v ?? '').trim().slice(0, n);
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const timestamp = (value, fallback) => !value || Number.isNaN(Date.parse(value)) ? fallback : new Date(value).toISOString();

function parseImages(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(value) ? value : [];
}
function referencedUploads(backup) {
  const paths = new Set();
  function add(url) { if (typeof url === 'string' && UPLOAD_PATH.test(url)) paths.add(url); }
  for (const row of backup.products || []) add(row?.image);
  for (const row of backup.orders || []) add(row?.product_image ?? row?.productImage);
  for (const row of backup.maintenanceRequests || backup.maintenance || []) {
    for (const image of parseImages(row?.fault_images ?? row?.faultImages)) add(image);
  }
  return paths;
}

async function createBackup(db, uploads, getContact, scope) {
  return db.transaction(async tx => {
    const backup = { version: 3, exportedAt: new Date().toISOString(), scope, products: await tx.all('SELECT * FROM products ORDER BY id') };
    if (scope === 'full') {
      Object.assign(backup, {
        orders: await tx.all('SELECT * FROM orders ORDER BY id'),
        maintenance: await tx.all('SELECT * FROM maintenance ORDER BY id'),
        visits: await tx.all('SELECT * FROM visits ORDER BY day'),
        visitorLogs: await tx.all('SELECT * FROM visitor_logs ORDER BY id'),
        contact: await getContact(tx),
      });
    }
    const files = {};
    const missingUploads = [];
    let size = Buffer.byteLength(JSON.stringify(backup));
    if (size >= MAX_BACKUP_BYTES - 4096) return null;
    for (const url of referencedUploads(backup)) {
      const info = await uploads.read(url, tx);
      if (!info) { missingUploads.push(url); continue; }
      size += Math.ceil(info.size / 3) * 4 + 120;
      if (size > MAX_BACKUP_BYTES - 4096) return null;
      files[url] = `data:${info.type};base64,${info.body.toString('base64')}`;
    }
    Object.assign(backup, { files, missingUploads });
    return Buffer.byteLength(JSON.stringify(backup)) < MAX_BACKUP_BYTES - 1024 ? backup : null;
  }, { snapshot: true });
}

function validateBackup(raw) {
  const backup = object(raw?.data) && raw.ok === true ? raw.data : raw;
  const lists = ['products', 'orders', 'maintenance', 'maintenanceRequests', 'visits', 'visitorLogs'];
  if (!object(backup) || !(lists.some(key => Array.isArray(backup[key])) || object(backup.contact)) ||
      lists.some(key => backup[key] !== undefined && !Array.isArray(backup[key]))) {
    throw new Error('الملف ليس نسخة احتياطية صالحة من لوحة التحكم.');
  }
  if (backup.files !== undefined && !object(backup.files)) throw new Error('قسم الصور في النسخة غير صالح.');
  const records = [];
  if (backup.files) {
    const used = referencedUploads(backup);
    for (const [url, data] of Object.entries(backup.files)) {
      const image = validateBackupImage(url, data);
      if (!used.has(url) || !image) throw new Error('توجد صورة غير صالحة في النسخة الاحتياطية.');
      records.push(image);
    }
  }
  for (const row of backup.products || []) normalizeStock(row?.stock_quantity ?? row?.stockQuantity);
  const contact = backup.contact === undefined ? null : validateContact(backup.contact);
  return { backup, records, contact };
}

async function mergeBackup(db, uploads, validated, options) {
  const { backup, records, contact } = validated;
  let imported = 0, skipped = 0;
  let contactRestored = false;
  const now = new Date().toISOString();
  const source = row => ['site', 'legacy', 'demo', 'import'].includes(row.source) ? row.source : 'import';
  const legacy = row => s(row.legacy_id ?? row._id ?? row.id, 80) || null;
  const safeStatus = (status, values) => values.includes(status) ? status : 'جديد';
  const dateFields = row => {
    const created = timestamp(row.created_at || row._createdAt || row.date, now);
    return [created, timestamp(row.updated_at, created)];
  };
  const account = result => { if (result.changes) imported++; else skipped++; };

  return db.transaction(async tx => {
    // PostgreSQL writes image bytes atomically with the associated rows. On a local disk
    // they're content-addressed and published first so rows never point at half-written files.
    if (db.dialect === 'postgres') await tx.get('SELECT pg_advisory_xact_lock(41803723)');
    for (const { name, bytes } of records) await uploads.write(name, bytes, tx);
    for (const row of backup.products || []) {
      if (!object(row) || !s(row.title, 300)) { skipped++; continue; }
      const values = [s(row.title, 300), s(row.price, 80), s(row.old_price ?? row.oldPrice, 80),
        Math.floor(Math.max(0, Math.min(100, Number(row.discount_percent ?? row.discountPercent) || 0))), s(row.category, 100),
        await uploads.store(row.image, tx), s(row.description, 2000), [0, false, '0'].includes(row.active) ? 0 : 1];
      const stock = normalizeStock(row.stock_quantity ?? row.stockQuantity);
      const same = await tx.get(`SELECT id, stock_quantity FROM products WHERE title = ? AND COALESCE(price,'') = ? AND COALESCE(old_price,'') = ?
        AND COALESCE(discount_percent,0) = ? AND COALESCE(category,'') = ? AND COALESCE(image,'') = ? AND COALESCE(description,'') = ?
        AND COALESCE(active,1) = ? ORDER BY id LIMIT 1`, ...values);
      if (same) {
        // A backup may fill an unknown count, never replace quantities an admin has already set.
        if (same.stock_quantity === null && stock !== null) {
          account(await tx.run('UPDATE products SET stock_quantity = ?, updated_at = ? WHERE id = ? AND stock_quantity IS NULL', stock, now, same.id));
        } else skipped++;
        continue;
      }
      account(await tx.run(`INSERT INTO products
        (legacy_id, title, price, old_price, discount_percent, category, image, description, active, stock_quantity, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, s(row.legacy_id ?? row._id, 80) || null, ...values, stock, ...dateFields(row)));
    }
    for (const row of backup.orders || []) {
      if (!object(row)) { skipped++; continue; }
      const name = s(row.customer_name ?? row.customerName, 120);
      const title = s(row.product_title ?? row.productTitle, 300);
      const ref = s(row.ref, 100), oldId = legacy(row);
      if (!name || !title || (!ref && oldId && await tx.get('SELECT 1 FROM orders WHERE legacy_id = ? AND customer_name = ? AND product_title = ? LIMIT 1', oldId, name, title))) { skipped++; continue; }
      account(await tx.run(`INSERT INTO orders
        (ref, legacy_id, customer_name, phone, address, product_title, product_image, price, service_type, device, status, note, source, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ref) DO NOTHING`, ref || await options.nextRef(tx, 'orders', 'ORD'), oldId, name,
        s(row.phone, 30), s(row.address, 300), title, await uploads.store(row.product_image ?? row.productImage, tx),
        s(row.price, 60), s(row.service_type ?? row.serviceType, 60) || 'شراء', s(row.device, 80),
        safeStatus(row.status, options.orderStatus), s(row.note, 500), source(row), ...dateFields(row)));
    }
    for (const row of backup.maintenanceRequests || backup.maintenance || []) {
      if (!object(row)) { skipped++; continue; }
      const name = s(row.name ?? row.customerName, 120), device = s(row.device, 80);
      const ref = s(row.ref, 100), oldId = legacy(row);
      if (!name || (!ref && oldId && await tx.get('SELECT 1 FROM maintenance WHERE legacy_id = ? AND name = ? AND device = ? LIMIT 1', oldId, name, device))) { skipped++; continue; }
      const images = [];
      for (const image of parseImages(row.fault_images ?? row.faultImages).slice(0, 2)) {
        const path = await uploads.store(image, tx);
        if (path) images.push(path);
      }
      account(await tx.run(`INSERT INTO maintenance
        (ref, legacy_id, name, phone, device, description, fault_images, address, status, note, source, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ref) DO NOTHING`, ref || await options.nextRef(tx, 'maintenance', 'MNT'), oldId, name,
        s(row.phone, 30), device, s(row.description ?? row.desc, 800), JSON.stringify(images), s(row.address, 300),
        safeStatus(row.status, options.maintStatus), s(row.note, 500), source(row), ...dateFields(row)));
    }
    for (const row of backup.visitorLogs || []) {
      if (!object(row) || !s(row.ip, 80)) { skipped++; continue; }
      const values = [s(row.ip, 80), s(row.page, 300) || '/', s(row.referrer, 500), s(row.user_agent, 500),
        s(row.device, 40), timestamp(row.created_at, now)];
      if (await tx.get(`SELECT 1 FROM visitor_logs WHERE ip = ? AND COALESCE(page,'/') = ?
        AND COALESCE(referrer,'') = ? AND COALESCE(user_agent,'') = ? AND COALESCE(device,'') = ? AND created_at = ? LIMIT 1`, ...values)) { skipped++; continue; }
      account(await tx.run('INSERT INTO visitor_logs (ip, page, referrer, user_agent, device, created_at) VALUES (?,?,?,?,?,?)', ...values));
    }
    for (const row of backup.visits || []) {
      if (!object(row) || !/^\d{4}-\d{2}-\d{2}$/.test(row.day)) { skipped++; continue; }
      account(await tx.run(`INSERT INTO visits (day, count) VALUES (?,?)
        ON CONFLICT(day) DO UPDATE SET count = excluded.count WHERE excluded.count > visits.count`, row.day,
        Math.floor(Math.max(0, Math.min(Number(row.count) || 0, 100000000)))));
    }
    if (contact && await options.restoreContact(contact, tx)) contactRestored = true;
    const missingUploads = [];
    for (const url of referencedUploads(backup)) if (!await uploads.inspect(url, tx)) missingUploads.push(url);
    return { imported, skipped, contactRestored, missingUploads };
  });
}

module.exports = { MAX_BACKUP_BYTES, createBackup, validateBackup, mergeBackup, referencedUploads };
