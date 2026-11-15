-- مخطط قاعدة البيانات — مركز المهندس الشامل
-- مرجع للتحويل إلى PostgreSQL مستقبلاً (SQLite الحالي يستخدم نفس الأسماء تقريباً)
-- للتحويل: استبدل INTEGER PRIMARY KEY AUTOINCREMENT بـ BIGSERIAL PRIMARY KEY
-- و TEXT DEFAULT (strftime...) بـ TIMESTAMPTZ DEFAULT now()

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ref           TEXT UNIQUE,                    -- رقم الطلب مثل ORD-20261112-001
  legacy_id     TEXT,                           -- معرّف النظام القديم (لمنع التكرار)
  customer_name TEXT NOT NULL,
  phone         TEXT NOT NULL,
  address       TEXT,
  product_title TEXT NOT NULL,
  product_image TEXT,
  price         TEXT,
  service_type  TEXT DEFAULT 'شراء',
  device        TEXT,
  status        TEXT DEFAULT 'جديد',            -- جديد/قيد المراجعة/تم التواصل/تم التأكيد/تم الشحن/مكتمل/ملغي
  note          TEXT,                           -- ملاحظة داخلية
  source        TEXT DEFAULT 'site',            -- site|demo|legacy|import
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_updated ON orders(updated_at DESC);

CREATE TABLE IF NOT EXISTS maintenance (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ref           TEXT UNIQUE,                    -- MNT-20261112-001
  legacy_id     TEXT,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL,
  device        TEXT,
  description   TEXT,
  fault_images  TEXT DEFAULT '[]',              -- JSON array of image URLs
  address       TEXT,
  status        TEXT DEFAULT 'جديد',            -- جديد/قيد المراجعة/قيد الصيانة/جاهز/تم التسليم/ملغي
  note          TEXT,
  source        TEXT DEFAULT 'site',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_maint_status  ON maintenance(status);
CREATE INDEX IF NOT EXISTS idx_maint_created ON maintenance(created_at DESC);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  legacy_id   TEXT,
  title       TEXT NOT NULL,
  price       TEXT,
  category    TEXT,
  image       TEXT,                             -- /uploads/img_xxx.jpg أو data URL
  description TEXT,
  active      INTEGER DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS visits (
  day   TEXT PRIMARY KEY,                       -- YYYY-MM-DD
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,                       -- admin_hash, admin_salt, auth_secret, crud_migrated
  value TEXT NOT NULL
);
