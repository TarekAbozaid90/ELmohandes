'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { configureStorage, createUploadStore, createPostgresUploadStore } = require('./storage');

function createSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(file);
  const conn = {
    all: (sql, ...args) => raw.prepare(sql).all(...args),
    get: (sql, ...args) => raw.prepare(sql).get(...args),
    run: (sql, ...args) => raw.prepare(sql).run(...args),
    exec: sql => raw.exec(sql),
  };
  // One shared connection: no other request can interleave its writes with a transaction.
  let tail = Promise.resolve();
  function schedule(fn) {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  }
  return {
    dialect: 'sqlite',
    all: (...args) => schedule(() => conn.all(...args)),
    get: (...args) => schedule(() => conn.get(...args)),
    run: (...args) => schedule(() => conn.run(...args)),
    exec: (...args) => schedule(() => conn.exec(...args)),
    transaction: fn => schedule(async () => {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(conn);
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    }),
    close: () => schedule(() => raw.close()),
  };
}

function postgresURL(value, onRender) {
  let url;
  try { url = new URL(value); } catch { throw new Error('DATABASE_URL is not a valid PostgreSQL connection string.'); }
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !url.hostname || url.pathname.length <= 1) {
    throw new Error('DATABASE_URL must be the PostgreSQL connection string for this database.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  // Plain connections are for local testing only. Force certificate and hostname checking on hosted databases.
  if (onRender || !local || !['disable', null].includes(url.searchParams.get('sslmode'))) {
    for (const key of ['ssl', 'sslnegotiation', 'uselibpqcompat', 'sslrootcert', 'sslcert', 'sslkey']) url.searchParams.delete(key);
    url.searchParams.set('sslmode', 'verify-full');
  } else url.searchParams.set('sslmode', 'disable');
  return url.toString();
}

// Only SQL owned by the server is passed here; user data is always bound separately.
// Portable statements use ? placeholders, never literal question marks inside SQL strings.
const asPostgres = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + ++i); };
function createPostgres(connectionString, onRender) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: postgresURL(connectionString, onRender),
    enableChannelBinding: true,
    max: 5,
    connectionTimeoutMillis: 12_000,
    idleTimeoutMillis: 10_000,
  });
  pool.on('error', err => console.warn(`Postgres idle connection closed (${err.code || 'connection error'}).`));
  function connection(client) {
    const query = (sql, args) => client.query(asPostgres(sql), args);
    return {
      all: async (sql, ...args) => (await query(sql, args)).rows,
      get: async (sql, ...args) => (await query(sql, args)).rows[0],
      run: async (sql, ...args) => ({ changes: (await query(sql, args)).rowCount }),
      exec: sql => client.query(sql),
    };
  }
  return {
    ...connection(pool),
    dialect: 'postgres',
    async transaction(fn, { snapshot = false } = {}) {
      const client = await pool.connect();
      let discard;
      try {
        await client.query(snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
        const result = await fn(connection(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch (rollbackError) { discard = rollbackError; }
        throw err;
      } finally { client.release(discard); }
    },
    close: () => pool.end(),
  };
}

function configureDatabase(root, env = process.env) {
  const databaseURL = env.DATABASE_URL?.trim();
  const onRender = env.RENDER === 'true';
  if (databaseURL) {
    const db = createPostgres(databaseURL, onRender);
    const uploads = createPostgresUploadStore(db);
    let size = null, checkedAt = 0;
    return {
      mode: 'postgres', db, uploads,
      async status() {
        if (Date.now() - checkedAt > 120_000) {
          checkedAt = Date.now();
          try { size = Number((await db.get('SELECT pg_database_size(current_database()) AS bytes')).bytes); } catch {}
        }
        return { mode: 'postgres', bytes: size };
      },
    };
  }
  if (env.REQUIRE_POSTGRES === '1' || (onRender && !env.PERSISTENT_DISK_PATH)) {
    throw new Error('DATABASE_URL is required for Render Free. Set the external PostgreSQL connection string in Environment; no temporary database will be created.');
  }
  const storage = configureStorage(root, env);
  const db = createSqlite(storage.dbPath);
  const uploads = createUploadStore(storage.uploadsDir);
  const moved = uploads.migrateLegacyDirectory(path.join(root, 'public', 'uploads'));
  if (moved) console.log(`Copied ${moved} old upload(s) to the data directory.`);
  return {
    mode: storage.mode, db, uploads,
    async status() {
      const bytes = [storage.dbPath, storage.dbPath + '-wal'].reduce((sum, f) => sum + (fs.statSync(f, { throwIfNoEntry: false })?.size || 0), 0);
      return { mode: storage.mode, bytes };
    },
  };
}
module.exports = { configureDatabase, postgresURL };
