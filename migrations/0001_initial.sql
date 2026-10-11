PRAGMA foreign_keys = ON;
CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  owner_token_hash TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','revoked')),
  cleanup_status TEXT NOT NULL DEFAULT 'pending' CHECK(cleanup_status IN ('pending','cleaning','cleaned')),
  cleaned_at INTEGER
);
CREATE INDEX shares_expiry_cleanup ON shares(expires_at, cleanup_status);
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mime TEXT NOT NULL,
  last_modified INTEGER NOT NULL,
  sha256 TEXT,
  r2_key TEXT,
  upload_status TEXT NOT NULL DEFAULT 'none'
);
CREATE INDEX files_share ON files(share_id);
CREATE TABLE upload_attempts (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  owner_session_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('put','multipart')),
  r2_key TEXT NOT NULL UNIQUE,
  upload_id TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  signed_until INTEGER NOT NULL DEFAULT 0,
  recheck_until INTEGER NOT NULL DEFAULT 0,
  paused_until INTEGER,
  reservation_id TEXT NOT NULL
);
CREATE INDEX uploads_file ON upload_attempts(file_id);
CREATE INDEX uploads_cleanup ON upload_attempts(status, recheck_until);
CREATE TABLE cleanup_tasks (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_key TEXT NOT NULL,
  upload_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX cleanup_retry ON cleanup_tasks(next_retry_at);
