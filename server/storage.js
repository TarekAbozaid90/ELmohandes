'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const IMAGE_NAME = /^img_[a-f0-9]{20}\.(png|jpg|webp|gif)$/;
const UPLOAD_PATH = /^\/uploads\/(img_[a-f0-9]{20}\.(?:png|jpg|webp|gif))$/;
const IMAGE_LIMIT = 4 * 1024 * 1024;
const types = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const inside = (root, candidate) => root === candidate || candidate.startsWith(root + path.sep);
const mountName = text => text.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n, 8)));

function isDiskMounted(dir, mountInfo) {
  return mountInfo.split('\n').some(line => {
    const [meta, details] = line.split(' - ', 2);
    const fields = meta.split(' ');
    const type = details?.split(' ')[0];
    return fields.length >= 6 && mountName(fields[4]) === dir &&
      type && !['tmpfs', 'ramfs', 'overlay'].includes(type) && fields[5].split(',').includes('rw');
  });
}

function configureStorage(root, env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(root, 'data'));
  const dbPath = path.resolve(env.DATABASE_PATH || path.join(dataDir, 'mohandis.db'));
  const uploadsDir = path.join(dataDir, 'uploads');
  const expected = env.PERSISTENT_DISK_PATH || (env.RENDER === 'true' ? '/var/data' : '');
  let mount = null;
  if (expected) {
    const requested = path.resolve(expected);
    const msg = `Persistent storage is not mounted at ${requested}. Attach a writable disk before deploying; the server will not create a temporary database.`;
    try {
      mount = fs.realpathSync(requested);
      if (mount === '/' || !isDiskMounted(mount, fs.readFileSync('/proc/self/mountinfo', 'utf8'))) throw new Error(msg);
    } catch { throw new Error(msg); }
    if (![dataDir, dbPath, uploadsDir].every(p => inside(requested, p))) {
      throw new Error(`DATA_DIR and DATABASE_PATH must both be inside the persistent disk (${requested}).`);
    }
  }
  for (const dir of new Set([dataDir, path.dirname(dbPath), uploadsDir])) {
    fs.mkdirSync(dir, { recursive: true });
    if (mount && !inside(mount, fs.realpathSync(dir))) throw new Error(`Storage directory resolves outside the persistent disk: ${dir}`);
  }
  if (mount && fs.existsSync(dbPath) && !inside(mount, fs.realpathSync(dbPath))) {
    throw new Error('DATABASE_PATH resolves outside the persistent disk.');
  }
  return { dataDir, dbPath, uploadsDir, mode: mount ? 'mounted' : 'local' };
}

function isImage(bytes, ext) {
  if (ext === 'png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (ext === 'jpg') return bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  if (ext === 'webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (ext === 'gif') return ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
  return false;
}
const imageName = (bytes, ext) => `img_${crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 20)}.${ext}`;

function decodeImage(data) {
  if (typeof data !== 'string' || data.length > Math.ceil(IMAGE_LIMIT / 3) * 4 + 32) return null;
  const match = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(data);
  if (!match) return null;
  const ext = match[1].toLowerCase().replace('jpeg', 'jpg');
  const bytes = Buffer.from(match[2], 'base64');
  return bytes.length <= IMAGE_LIMIT && isImage(bytes, ext) ? { ext, bytes } : null;
}

function safeImageReference(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (/^data:/i.test(text)) return decodeImage(text) ? text : '';
  if (!text || text.length > 2048 || /[\s\\]/u.test(text)) return '';
  if (/^\/?(?:assets|images_opt)\/[\w.-]+$/.test(text)) return '/' + text.replace(/^\//, '');
  if (UPLOAD_PATH.test('/' + text.replace(/^\//, ''))) return '/' + text.replace(/^\//, '');
  try {
    const url = new URL(text);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return text;
  } catch {}
  return '';
}

function validateBackupImage(url, data) {
  const parsed = decodeImage(data);
  if (!parsed || url !== `/uploads/${imageName(parsed.bytes, parsed.ext)}`) return null;
  return { name: imageName(parsed.bytes, parsed.ext), bytes: parsed.bytes };
}

function createUploadStore(uploadsDir) {
  function write(name, bytes) {
    const target = path.join(uploadsDir, name);
    if (fs.existsSync(target)) return;
    const tmp = path.join(uploadsDir, `.upload-${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, bytes, { flag: 'wx', flush: true, mode: 0o600 });
      fs.renameSync(tmp, target);
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  function store(value) {
    if (!/^data:/i.test(String(value ?? ''))) return safeImageReference(value);
    const parsed = decodeImage(value);
    if (!parsed) return '';
    const name = imageName(parsed.bytes, parsed.ext);
    write(name, parsed.bytes);
    return `/uploads/${name}`;
  }
  function inspect(url) {
    const m = UPLOAD_PATH.exec(url);
    if (!m) return null;
    const name = m[1];
    const file = path.join(uploadsDir, name);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    return stat?.isFile() ? { name, file, size: stat.size, type: types[path.extname(name).slice(1)] } : null;
  }
  function read(url, _tx, head = false) {
    const info = inspect(url);
    if (!info) return null;
    return { ...info, body: head ? undefined : fs.readFileSync(info.file) };
  }
  function migrateLegacyDirectory(dir) {
    if (!fs.existsSync(dir) || fs.realpathSync(dir) === fs.realpathSync(uploadsDir)) return 0;
    let copied = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const m = IMAGE_NAME.exec(entry.name);
      if (!entry.isFile() || !m || inspect(`/uploads/${entry.name}`)) continue;
      const file = path.join(dir, entry.name);
      if (fs.statSync(file).size > IMAGE_LIMIT) continue;
      const bytes = fs.readFileSync(file);
      if (!isImage(bytes, m[1]) || imageName(bytes, m[1]) !== entry.name) continue;
      write(entry.name, bytes);
      copied++;
    }
    return copied;
  }
  return { store, inspect, read, write, migrateLegacyDirectory };
}

function createPostgresUploadStore(db) {
  async function write(name, bytes, conn = db) {
    const ext = IMAGE_NAME.exec(name)?.[1];
    if (!ext) throw new Error('Invalid upload name');
    await conn.run('INSERT INTO uploaded_images (name, content_type, contents) VALUES (?,?,?) ON CONFLICT (name) DO NOTHING', name, types[ext], bytes);
  }
  async function store(value, conn = db) {
    if (!/^data:/i.test(String(value ?? ''))) return safeImageReference(value);
    const parsed = decodeImage(value);
    if (!parsed) return '';
    const name = imageName(parsed.bytes, parsed.ext);
    await write(name, parsed.bytes, conn);
    return `/uploads/${name}`;
  }
  async function read(url, conn = db, head = false) {
    const name = UPLOAD_PATH.exec(url)?.[1];
    if (!name) return null;
    const selection = head ? 'content_type, octet_length(contents) AS size' : 'content_type, contents';
    const result = await conn.get(`SELECT ${selection} FROM uploaded_images WHERE name = ?`, name);
    if (!result) return null;
    return { name, type: result.content_type, size: head ? result.size : result.contents.length, body: result.contents };
  }
  const inspect = (url, conn) => read(url, conn, true);
  return { store, read, inspect, write };
}

module.exports = { configureStorage, isDiskMounted, createUploadStore, createPostgresUploadStore, UPLOAD_PATH, safeImageReference, validateBackupImage, IMAGE_LIMIT };
