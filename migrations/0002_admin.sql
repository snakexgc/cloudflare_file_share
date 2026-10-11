CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE presence (
  id TEXT PRIMARY KEY,
  page TEXT NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX presence_last_seen ON presence(last_seen);
ALTER TABLE files ADD COLUMN deleted_at INTEGER;
