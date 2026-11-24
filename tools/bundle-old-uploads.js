#!/usr/bin/env node
'use strict';

// Run before replacing the old service: its dashboard JSON stored image URLs only.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { referencedUploads, MAX_BACKUP_BYTES } = require('../server/backup');
const { IMAGE_LIMIT, validateBackupImage } = require('../server/storage');
const { QR_TARGET } = require('../server/contact');

async function run() {
  const [input, output, site = new URL(QR_TARGET).origin] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node tools/bundle-old-uploads.js old-backup.json backup-with-images.json [https://your-shop.example]');
  if (fs.existsSync(output)) throw new Error('Choose a new output filename. The original backup will not be overwritten.');
  const base = new URL(site);
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('Use the HTTPS URL of the old website without any credentials.');
  if (fs.statSync(input).size > MAX_BACKUP_BYTES) throw new Error('The input exceeds the dashboard import size. Keep it and see the disk migration instructions.');
  const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
  const backup = raw.ok === true ? raw.data : raw;
  backup.files ||= {};
  const missing = [];
  let bytes = Buffer.byteLength(JSON.stringify(backup));
  for (const url of referencedUploads(backup)) {
    if (validateBackupImage(url, backup.files[url])) continue;
    delete backup.files[url];
    try {
      const response = await fetch(new URL(url, base.origin), { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok || !response.body || !/^image\/(jpeg|png|webp|gif)(?:;|$)/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel();
        throw new Error('The old site no longer serves this image.');
      }
      let length = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > IMAGE_LIMIT) throw new Error('Image is too large');
        chunks.push(chunk);
      }
      const content = Buffer.concat(chunks);
      const ext = url.split('.').at(-1);
      const type = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      const data = `data:${type};base64,${content.toString('base64')}`;
      if (!validateBackupImage(url, data)) {
        const digest = crypto.createHash('sha1').update(content).digest('hex').slice(0, 20);
        throw new Error(`Image content does not match the original name (received ${digest})`);
      }
      if (bytes + Buffer.byteLength(data) + 120 > MAX_BACKUP_BYTES - 4096) throw new Error('Dashboard size limit reached');
      backup.files[url] = data;
      bytes += Buffer.byteLength(data) + 120;
    } catch (error) {
      missing.push(url);
      console.warn(`Image not bundled: ${url} (${error.message})`);
    }
  }
  backup.missingUploads = missing;
  fs.writeFileSync(output, JSON.stringify(backup), { flag: 'wx', mode: 0o600 });
  console.log(`Saved ${output}: ${Object.keys(backup.files).length} image(s) included, ${missing.length} not included.`);
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
