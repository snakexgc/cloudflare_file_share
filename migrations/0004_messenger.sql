CREATE TABLE messenger_users (
  id TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX messenger_users_seen ON messenger_users(last_seen);

CREATE TABLE messenger_conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('dm', 'group')),
  dm_left TEXT REFERENCES messenger_users(id) ON DELETE CASCADE,
  dm_right TEXT REFERENCES messenger_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(dm_left, dm_right),
  CHECK((kind = 'group' AND dm_left IS NULL AND dm_right IS NULL)
     OR (kind = 'dm' AND dm_left IS NOT NULL AND dm_right IS NOT NULL AND dm_left < dm_right))
);
CREATE INDEX messenger_dm_right ON messenger_conversations(dm_right);
CREATE TABLE messenger_members (
  conversation_id TEXT NOT NULL REFERENCES messenger_conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES messenger_users(id) ON DELETE CASCADE,
  PRIMARY KEY(conversation_id, user_id)
);
CREATE INDEX messenger_members_by_user ON messenger_members(user_id, conversation_id);

CREATE TABLE messenger_files (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES messenger_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  last_modified INTEGER NOT NULL,
  transfer_mode TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX messenger_files_owner ON messenger_files(owner_id, created_at DESC);

CREATE TABLE messenger_messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES messenger_conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  text TEXT NOT NULL,
  file_id TEXT REFERENCES messenger_files(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(conversation_id, sender_id, nonce)
);
CREATE INDEX messenger_message_history ON messenger_messages(conversation_id, sequence DESC);
CREATE INDEX messenger_message_files ON messenger_messages(file_id, conversation_id);

CREATE TRIGGER messenger_delete_empty_file_messages BEFORE DELETE ON messenger_files
BEGIN
  DELETE FROM messenger_messages WHERE file_id = OLD.id AND text = '';
END;
CREATE TRIGGER messenger_delete_empty_groups AFTER DELETE ON messenger_members
WHEN NOT EXISTS (SELECT 1 FROM messenger_members WHERE conversation_id = OLD.conversation_id)
BEGIN
  DELETE FROM messenger_conversations WHERE id = OLD.conversation_id AND kind = 'group';
END;

CREATE TABLE messenger_transfers (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES messenger_files(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES messenger_conversations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES messenger_users(id) ON DELETE CASCADE,
  requester_id TEXT NOT NULL REFERENCES messenger_users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','ready','failed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  share_id TEXT UNIQUE,
  share_file_id TEXT,
  password TEXT,
  reason TEXT
);
CREATE INDEX messenger_transfers_owner ON messenger_transfers(owner_id, expires_at);
CREATE INDEX messenger_transfers_receiver ON messenger_transfers(requester_id, expires_at);
CREATE INDEX messenger_transfers_expiry ON messenger_transfers(expires_at);
CREATE INDEX messenger_transfers_file ON messenger_transfers(file_id);
CREATE INDEX messenger_transfers_conversation ON messenger_transfers(conversation_id);

-- Capture live transport rooms before cascades remove the associated ticket. This lets
-- file deletion and identity expiry revoke receiver sessions, including after a retry.
CREATE TABLE messenger_room_cleanup (
  share_id TEXT PRIMARY KEY REFERENCES shares(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL
);
CREATE INDEX messenger_cleanup_file ON messenger_room_cleanup(file_id);
CREATE TRIGGER messenger_revoke_room BEFORE DELETE ON messenger_transfers
WHEN OLD.status = 'ready'
BEGIN
  INSERT OR IGNORE INTO messenger_room_cleanup(share_id, file_id)
    SELECT id, OLD.file_id FROM shares WHERE id = OLD.share_id AND status = 'active';
END;
