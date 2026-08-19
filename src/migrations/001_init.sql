CREATE TABLE keys (
  id TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,          -- ck_live / ck_test
  hash TEXT NOT NULL UNIQUE,     -- sha256 of secret
  plan TEXT NOT NULL DEFAULT 'free',
  credits INTEGER NOT NULL,
  rpm INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL
);

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  route TEXT NOT NULL,
  credits INTEGER NOT NULL,
  cached INTEGER NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (key_id) REFERENCES keys(id)
);

CREATE TABLE cache_entries (
  cache_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- transcript | tombstone
  body TEXT,
  error_code TEXT,
  expires_at TEXT NOT NULL
);
