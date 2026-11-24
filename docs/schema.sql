-- SQLite schema, for reference. The server applies migrations at startup.
PRAGMA journal_mode = WAL;
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
  old_price   TEXT,
  discount_percent INTEGER DEFAULT 0,
  category    TEXT,
  image       TEXT,
  description TEXT,
  active      INTEGER DEFAULT 1,
  stock_quantity INTEGER CHECK (stock_quantity IS NULL OR (stock_quantity BETWEEN 0 AND 999999 AND stock_quantity = CAST(stock_quantity AS INTEGER))),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_products_legacy ON products(legacy_id);

CREATE TABLE IF NOT EXISTS visits (
  day   TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS visitor_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ip          TEXT NOT NULL,
  page        TEXT,
  referrer    TEXT,
  user_agent  TEXT,
  device      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_visitor_logs_created ON visitor_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_visitor_logs_ip ON visitor_logs(ip);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ref_counters (
  prefix TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

