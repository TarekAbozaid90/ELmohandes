'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_CONTACT, QR_TARGET, normalizeEgyptianMobile } = require('../server/contact');
const { isDiskMounted, configureStorage, createUploadStore } = require('../server/storage');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'server.js');
const PASSWORD = 'local-test-only-qr-22';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xj3cAAAAASUVORK5CYII=';
const TEST_HOST = '127.0.0.1';

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mohandis-tests-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function envFor(dataDir, overrides = {}) {
  const env = { ...process.env };
  for (const name of ['RENDER', 'DATABASE_PATH', 'DATABASE_URL', 'REQUIRE_POSTGRES', 'PERSISTENT_DISK_PATH', 'NODE_ENV']) delete env[name];
  return { ...env, DATA_DIR: dataDir, HOST: TEST_HOST, PORT: '0', ADMIN_PASSWORD: PASSWORD,
    SEED_DEMO: '0', SEED_CATALOG: '0', ...overrides };
}
async function start(dataDir, overrides) {
  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env: envFor(dataDir, overrides), stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await exit;
  };
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { void stop(); reject(new Error('Server timed out')); }, 8000);
    let out = '';
    child.stdout.on('data', chunk => {
      out += chunk;
      const m = out.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.stderr.on('data', chunk => { out += chunk; if (process.env.TEST_SERVER_LOGS) process.stderr.write(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited: ' + out)); });
  });
  const url = `http://${TEST_HOST}:${port}`;
  async function request(endpoint, { method = 'GET', token, body } = {}) {
    const response = await fetch(url + endpoint, {
      method,
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const content = await response.json();
    return { code: response.status, ...content };
  }
  const login = async () => {
    const response = await request('/api/auth/login', { method: 'POST', body: { password: PASSWORD } });
    assert.equal(response.code, 200);
    return response.data.token;
  };
  return { stop, url, request, login };
}

test('Render requires a writable disk mount; an existing ordinary directory is not sufficient', t => {
  const dir = temp(t);
  const mount = path.join(dir, 'disk');
  fs.mkdirSync(mount);
  const settings = envFor(mount, { RENDER: 'true', PERSISTENT_DISK_PATH: mount });
  const proc = spawnSync(process.execPath, [SERVER], { cwd: ROOT, env: settings, encoding: 'utf8', timeout: 6000 });
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /Persistent storage is not mounted/);
  assert.deepEqual(fs.readdirSync(mount), []);
  assert.equal(isDiskMounted('/var/data', '157 122 8:1 /dir /var/data rw,relatime - ext4 /dev/disk rw\n'), true);
  assert.equal(isDiskMounted('/var/data', '157 122 8:1 /dir /var/data ro - ext4 /dev/disk ro\n'), false);
  assert.equal(isDiskMounted('/var/data', '157 122 0:9 / /var/data rw - tmpfs tmpfs rw\n'), false);
  assert.equal(isDiskMounted('/var/data', '157 122 8:1 /dir /var/data2 rw - ext4 /dev/disk rw\n'), false);
  const local = configureStorage(dir, {});
  assert.equal(local.mode, 'local');
  assert.equal(local.dbPath, path.join(dir, 'data', 'mohandis.db'));
});

test('migrates old upload folder to a persistent path without changing the public image URL', t => {
  const dir = temp(t);
  const oldDir = path.join(dir, 'old-public-uploads');
  const newDir = path.join(dir, 'disk-uploads');
  fs.mkdirSync(oldDir); fs.mkdirSync(newDir);
  const url = createUploadStore(oldDir).store(PNG);
  const uploads = createUploadStore(newDir);
  fs.writeFileSync(path.join(oldDir, 'discard-me.html'), 'old file');
  assert.equal(uploads.migrateLegacyDirectory(oldDir), 1);
  assert.equal(uploads.migrateLegacyDirectory(oldDir), 0);
  assert.equal(fs.readFileSync(uploads.inspect(url).file).toString('base64'), PNG.split(',')[1]);
  assert.equal(fs.readdirSync(newDir).length, 1);
});

test('products, photos, requests, visits and contact edits survive restart and a full or product-only restore', async t => {
  const dir = temp(t);
  let server = await start(path.join(dir, 'store'));
  t.after(() => server.stop());
  const { request, url } = server;
  const token = await server.login();
  const auth = { token };
  assert.equal((await request('/api/health')).data.status, 'up');
  assert.equal((await request('/api/stats', auth)).data.kpi.visitsToday, 0);
  assert.deepEqual((await request('/api/products?active=1')).data, []);
  assert.equal((await fetch(url + '/QR.html', { redirect: 'manual' })).headers.get('location'), '/qr');
  assert.equal((await fetch(url + '/qr/', { redirect: 'manual' })).status, 301);
  assert.equal((await fetch(url + '/qr', { method: 'HEAD' })).status, 200);
  const response = await fetch(url + '/qr');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const page = await response.text();
  assert.equal((page.match(/data-channel=/g) || []).length, 6);
  for (const target of Object.values(DEFAULT_CONTACT)) assert.ok(page.includes(target), target);
  assert.match(page, /href="https:\/\/wa\.me\/201007889396"/);
  assert.equal(new URL(QR_TARGET).pathname, '/qr');
  assert.equal(normalizeEgyptianMobile('٠١٠٠٧٨٨٩٣٩٦'), '01007889396');
  assert.equal(normalizeEgyptianMobile('+٢٠ ١٠٠٧٨٨٩٣٩٦'), '01007889396');
  assert.equal((await request('/api/contact', { method: 'PUT', body: DEFAULT_CONTACT })).code, 401);
  assert.equal((await request('/api/backup')).code, 401);
  const contact = { ...DEFAULT_CONTACT, tagline: 'أهلاً بكم <بدون وسم> & مرحبًا', websiteUrl: 'https://example.com/help?lang=ar&from=qr', whatsappNumber: '+20 100 788 9396' };
  const bad = await request('/api/contact', { method: 'PUT', token, body: { ...contact, mapsUrl: 'not a URL' } });
  assert.equal(bad.code, 400);
  const saved = await request('/api/contact', { method: 'PUT', token, body: contact });
  assert.equal(saved.code, 200);
  assert.equal(saved.data.whatsappNumber, '01007889396');
  const afterEdit = await (await fetch(url + '/qr')).text();
  assert.ok(afterEdit.includes('&lt;بدون وسم&gt; &amp;'));
  assert.ok(afterEdit.includes('https://example.com/help?lang=ar&amp;from=qr'));

  const prod = await request('/api/products', { method: 'POST', token, body: {
    title: 'منتج اختبار', price: '320 جنيه', oldPrice: '400 جنيه', discountPercent: 20,
    category: 'أخرى', description: 'وصف', image: PNG,
  } });
  assert.equal(prod.code, 201);
  const { id, image } = prod.data;
  assert.match(image, /^\/uploads\/img_.+\.png$/);
  assert.equal(fs.existsSync(path.join(dir, 'store', image)), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'public', image)), false);
  const product = await request(`/api/products/${id}`, { method: 'PUT', token, body: { price: '300 جنيه', discountPercent: 25 } });
  assert.equal(product.data.price, '300 جنيه');
  assert.equal(product.data.image, image);
  await request('/api/products', { method: 'POST', token, body: { title: 'منتج غير منشور', active: false } });
  assert.equal((await request('/api/products?active=1')).data.length, 1);
  const o = await request('/api/orders', { method: 'POST', body: { customerName: 'عميل اختباري', phone: '01001234567', productTitle: 'منتج اختبار', productImage: image } });
  assert.equal(o.code, 201);
  const m = await request('/api/maintenance', { method: 'POST', body: { name: 'طلب اختباري', phone: '01201234567', description: 'وصف', address: 'عنوان', faultImages: [PNG] } });
  assert.equal(m.code, 201);
  assert.deepEqual(JSON.parse(m.data.fault_images), [image]);
  assert.equal((await request('/api/visits/track', { method: 'POST', body: { page: '/' } })).code, 200);
  await server.stop();

  // Relaunch against the same mounted-data analogue, not the same server process or JS memory.
  server = await start(path.join(dir, 'store'), { SEED_CATALOG: '1' });
  assert.equal((await server.request('/api/stats', auth)).data.kpi.visitsTotal, 1);
  assert.equal((await server.request('/api/visitors', auth)).data.total, 1);
  assert.equal((await server.request('/api/orders', auth)).data.items[0].ref, o.data.ref);
  assert.equal((await server.request('/api/maintenance', auth)).data.items[0].address, 'عنوان');
  assert.equal((await server.request('/api/products?active=1')).data[0].price, '300 جنيه');
  assert.equal((await server.request('/api/contact')).data.tagline, contact.tagline);
  const imageResponse = await fetch(server.url + image);
  assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await imageResponse.arrayBuffer()).toString('base64'), PNG.split(',')[1]);
  assert.equal((await fetch(server.url + '/uploads/invalid.png')).status, 404);
  const full = (await server.request('/api/backup', auth)).data;
  const catalog = (await server.request('/api/backup?scope=products', auth)).data;
  assert.equal(full.files[image], PNG);
  assert.equal(catalog.files[image], PNG);
  assert.equal(catalog.orders, undefined);
  assert.equal(catalog.visitorLogs, undefined);

  const target = await start(path.join(dir, 'restored'));
  t.after(() => target.stop());
  const targetToken = await target.login();
  const restore = await target.request('/api/import', { method: 'POST', body: full, token: targetToken });
  assert.equal(restore.code, 200);
  assert.equal(restore.data.imported, 6);
  assert.equal(restore.data.contactRestored, true);
  assert.deepEqual(restore.data.missingUploads, []);
  assert.equal((await target.request('/api/stats', { token: targetToken })).data.kpi.visitsTotal, 1);
  assert.equal((await target.request('/api/contact')).data.tagline, contact.tagline);
  const restored = await target.request('/api/products?active=1');
  assert.equal(restored.data[0].old_price, '400 جنيه');
  assert.equal(restored.data[0].discount_percent, 25);
  assert.equal((await target.request('/api/admin/products', { token: targetToken })).data.filter(p => p.active === 0).length, 1);
  assert.equal((await fetch(target.url + image)).status, 200);
  const reused = await target.request('/api/import', { method: 'POST', body: full, token: targetToken });
  assert.equal(reused.data.imported, 0);

  const only = await start(path.join(dir, 'products-only'));
  t.after(() => only.stop());
  const onlyToken = await only.login();
  const onlyResult = await only.request('/api/import', { method: 'POST', body: catalog, token: onlyToken });
  assert.equal(onlyResult.data.imported, 2);
  assert.equal((await only.request('/api/stats', { token: onlyToken })).data.kpi.ordersTotal, 0);
  assert.equal((await fetch(only.url + image)).status, 200);
});

test('older dashboard JSON with snake_case columns restores; empty catalogs stay empty', async t => {
  const dir = temp(t);
  let server = await start(dir, { SEED_CATALOG: '1' });
  t.after(() => server.stop());
  const token = await server.login();
  const list = (await server.request('/api/products')).data;
  assert.equal(list.length, 9);
  assert.ok(list.some(p => p.old_price), 'Original catalog discounts are preserved on the first seed');
  for (const item of list) {
    assert.equal((await server.request('/api/products/' + item.id, { method: 'DELETE', token })).code, 200);
  }
  await server.stop();
  server = await start(dir, { SEED_DEMO: '1', SEED_CATALOG: '1' });
  assert.deepEqual((await server.request('/api/products?active=1')).data, []);
  assert.equal((await server.request('/api/stats', { token })).data.kpi.ordersTotal, 0);
  const restored = await server.request('/api/import', {
    method: 'POST', token, body: { exportedAt: '2026-11-24T00:00:00.000Z',
      products: [{ id: 13, title: 'منتج قديم', price: '100 جنيه', old_price: '120 جنيه', discount_percent: 17, image: PNG, active: 1 }],
      orders: [{ id: 3, ref: 'ORD-OLD', customer_name: 'طلب سابق', phone: '01001234567', product_title: 'منتج قديم' }],
      maintenance: [{ id: 2, ref: 'MNT-OLD', name: 'طلب صيانة سابق', address: 'القاهرة', fault_images: JSON.stringify([PNG]) }],
      visits: [{ day: '2026-11-23', count: 7 }],
    },
  });
  assert.equal(restored.data.imported, 4);
  assert.equal((await server.request('/api/products')).data[0].old_price, '120 جنيه');
  assert.equal((await server.request('/api/stats', { token })).data.kpi.visitsTotal, 7);
  assert.equal((await server.request('/api/orders', { token })).data.items[0].customer_name, 'طلب سابق');
  assert.equal((await server.request('/api/maintenance', { token })).data.items[0].address, 'القاهرة');
});

test('Render Free fails closed when DATABASE_URL is missing or invalid', t => {
  const dir = temp(t), unused = path.join(dir, 'must-not-exist');
  for (const [env, error] of [
    [{ RENDER: 'true' }, /DATABASE_URL is required for Render Free/],
    [{ RENDER: 'true', DATABASE_URL: 'not-postgres' }, /valid PostgreSQL connection string/],
  ]) {
    const result = spawnSync(process.execPath, [SERVER], { cwd: ROOT, env: envFor(unused, env), encoding: 'utf8', timeout: 7000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
    assert.equal(fs.existsSync(unused), false);
  }
  const { postgresURL } = require('../server/database');
  const url = new URL(postgresURL('postgresql://owner:example@db.example.com/neondb?sslmode=disable&channel_binding=require', true));
  assert.equal(url.searchParams.get('sslmode'), 'verify-full');
  assert.equal(url.searchParams.get('channel_binding'), 'require');
});

test('upgrades an existing SQLite catalog; validated stock is private, and zero does not unpublish a product', async t => {
  const dir = temp(t);
  const { DatabaseSync } = require('node:sqlite');
  const { schemaFor } = require('../server/schema');
  const old = new DatabaseSync(path.join(dir, 'mohandis.db'));
  old.exec(schemaFor('sqlite').replace(/^  stock_quantity .*\n/m, ''));
  const { lastInsertRowid } = old.prepare('INSERT INTO products (title, price) VALUES (?, ?)').run('منتج من النسخة القديمة', '230 جنيه');
  old.close();
  const server = await start(dir);
  t.after(() => server.stop());
  const token = await server.login();
  const { request } = server;
  const id = Number(lastInsertRowid);
  assert.equal((await request('/api/admin/products')).code, 401);
  assert.equal((await request(`/api/products/${id}`, { method: 'PUT', body: { stockQuantity: 500 } })).code, 401);
  const initial = (await request('/api/admin/products', { token })).data[0];
  assert.equal(initial.price, '230 جنيه');
  assert.equal(initial.stock_quantity, null);
  for (const value of [-1, 1.25, true, '2.3', '1e3', 1000000, []]) {
    const attempt = await request(`/api/products/${id}`, { method: 'PUT', token, body: { stockQuantity: value } });
    assert.equal(attempt.code, 400, JSON.stringify(value));
  }
  const update = body => request(`/api/products/${id}`, { method: 'PUT', token, body });
  assert.equal((await update({ stockQuantity: '٢١' })).data.stock_quantity, 21);
  assert.equal((await update({ price: '240 جنيه' })).data.stock_quantity, 21);
  assert.equal((await update({ stockQuantity: 0 })).data.stock_quantity, 0);
  for (const ep of ['/api/products', '/api/products?includeStock=1', '/api/products?active=1']) {
    for (const auth of [{}, { token }]) {
      const result = await request(ep, auth);
      assert.equal(result.data[0].id, id);
      assert.ok(!Object.hasOwn(result.data[0], 'stock_quantity'));
    }
  }
  const customer = await request('/api/orders', { method: 'POST', body: {
    customerName: 'عميل اختبار', phone: '01001234567', productTitle: initial.title,
  } });
  assert.equal(customer.code, 201);
  assert.equal((await request('/api/admin/products', { token })).data[0].stock_quantity, 0);
  assert.equal((await request('/api/backup?scope=products')).code, 401);
  assert.equal((await request('/api/backup?scope=products', { token })).data.products[0].stock_quantity, 0);
  assert.equal((await update({ stockQuantity: '' })).data.stock_quantity, null);
});

const pgTestURL = process.env.TEST_POSTGRES_URL;
test('real PostgreSQL: stock, photos, orders, visits, QR and login survive a fresh app filesystem and JSON restore',
  { skip: !pgTestURL, timeout: 45_000 }, async t => {
    const dir = temp(t);
    const base = new URL(pgTestURL);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use only a local PostgreSQL test server');
    const { randomUUID } = require('node:crypto');
    const { Client } = require('pg');
    const client = new Client({ connectionString: pgTestURL });
    await client.connect();
    const databases = [], running = [];
    try {
      async function database() {
        const name = 'mohandis_test_' + randomUUID().replaceAll('-', '');
        await client.query(`CREATE DATABASE ${name}`);
        databases.push(name);
        const address = new URL(base);
        address.pathname = '/' + name;
        return address.toString();
      }
      async function launch(url, folder) {
        const server = await start(folder, { DATABASE_URL: url, REQUIRE_POSTGRES: '1' });
        running.push(server);
        assert.ok(!fs.existsSync(folder), 'PostgreSQL must not create local database or upload directories');
        return server;
      }
      const address = await database();
      const source = await launch(address, path.join(dir, 'instance-1'));
      const token = await source.login();
      const auth = { token };
      const stats = await source.request('/api/stats', auth);
      assert.equal(stats.data.storage.mode, 'postgres');
      assert.ok(stats.data.storage.bytes > 0);
      const created = await source.request('/api/products', { method: 'POST', token, body: {
        title: 'منتج قاعدة دائمة', price: '700 جنيه', image: PNG, stockQuantity: 5,
      } });
      assert.equal(created.code, 201);
      assert.match(created.data.image, /^\/uploads\//);
      const { id, image } = created.data;
      assert.equal((await source.request(`/api/products/${id}`, { method: 'PUT', token, body: { stockQuantity: 2 } })).data.stock_quantity, 2);
      assert.equal((await source.request('/api/admin/products')).code, 401);
      assert.ok(!Object.hasOwn((await source.request('/api/products?active=1')).data[0], 'stock_quantity'));
      const submitted = await Promise.all(Array.from({ length: 8 }, (_, i) => source.request('/api/orders', { method: 'POST', body: {
        customerName: `عميل الاختبار ${i}`, phone: '01001234567', productTitle: 'منتج قاعدة دائمة', price: '700 جنيه',
      } })));
      assert.ok(submitted.every(r => r.code === 201), JSON.stringify(submitted));
      assert.equal(new Set(submitted.map(r => r.data.ref)).size, 8);
      assert.equal((await source.request('/api/orders?search=%D8%B9%D9%85%D9%8A%D9%84&limit=2&page=2', auth)).data.items.length, 2);
      const repair = await source.request('/api/maintenance', { method: 'POST', body: {
        name: 'مقدم الصيانة', phone: '٠١٠٠١٢٣٤٥٦٧', device: 'خلاط', address: 'عنوان الاختبار', faultImages: [PNG],
      } });
      assert.equal(repair.code, 201);
      assert.equal(JSON.parse(repair.data.fault_images)[0], image);
      assert.equal((await source.request(`/api/orders/${submitted[0].data.id}`, { method: 'PATCH', token, body: { status: 'تم التأكيد' } })).data.status, 'تم التأكيد');
      assert.equal((await source.request('/api/visits/track', { method: 'POST', body: { page: '/' } })).code, 200);
      const tagline = 'إعدادات تستمر بعد إعادة النشر';
      assert.equal((await source.request('/api/contact', { method: 'PUT', token, body: { ...DEFAULT_CONTACT, tagline } })).code, 200);
      await source.stop();
      const second = await launch(address, path.join(dir, 'instance-2'));
      assert.equal((await second.request('/api/admin/products', auth)).data[0].stock_quantity, 2);
      assert.equal((await second.request('/api/orders', auth)).data.total, 8);
      assert.equal((await second.request('/api/maintenance', auth)).data.items[0].address, 'عنوان الاختبار');
      assert.equal((await second.request('/api/visitors', auth)).data.total, 1);
      assert.match(await (await fetch(second.url + '/qr')).text(), new RegExp(tagline));
      const head = await fetch(second.url + image, { method: 'HEAD' });
      assert.equal(head.headers.get('content-type'), 'image/png');
      const get = await fetch(second.url + image);
      assert.equal(Buffer.from(await get.arrayBuffer()).toString('base64'), PNG.split(',')[1]);
      const backup = (await second.request('/api/backup', auth)).data;
      assert.equal(backup.products[0].stock_quantity, 2);
      assert.equal(backup.files[image], PNG);
      const target = await launch(await database(), path.join(dir, 'restored'));
      const targetToken = await target.login();
      const restore = await target.request('/api/import', { method: 'POST', token: targetToken, body: backup });
      assert.equal(restore.code, 200);
      assert.deepEqual(restore.data.missingUploads, []);
      assert.equal(restore.data.contactRestored, true);
      assert.equal((await target.request('/api/admin/products', { token: targetToken })).data[0].stock_quantity, 2);
      assert.equal((await fetch(target.url + image)).status, 200);
      assert.equal((await target.request('/api/import', { method: 'POST', token: targetToken, body: backup })).data.imported, 0);
    } finally {
      for (const server of running) await server.stop();
      for (const name of databases) await client.query(`DROP DATABASE ${name}`);
      await client.end();
    }
  });
