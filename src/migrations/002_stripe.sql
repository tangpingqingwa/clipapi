ALTER TABLE keys ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE keys ADD COLUMN stripe_subscription_id TEXT;

CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  key_id TEXT,
  applied_at TEXT NOT NULL,
  FOREIGN KEY (key_id) REFERENCES keys(id)
);
