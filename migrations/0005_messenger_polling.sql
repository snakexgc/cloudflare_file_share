ALTER TABLE messenger_users ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messenger_conversations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE messenger_avatars (
  user_id TEXT PRIMARY KEY REFERENCES messenger_users(id) ON DELETE CASCADE,
  image TEXT NOT NULL
);
CREATE TABLE messenger_directory (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  revision INTEGER NOT NULL
);
INSERT INTO messenger_directory VALUES (1, 0);

INSERT INTO messenger_avatars(user_id, image)
  SELECT id, avatar FROM messenger_users WHERE avatar LIKE 'data:image/%';
UPDATE messenger_users SET avatar = '/api/messenger/avatars/' || id || '/' || lower(hex(randomblob(32)))
  WHERE id IN (SELECT user_id FROM messenger_avatars);

-- Polling a quiet inbox only reads the account and its conversation revisions.
-- Presence heartbeats for continuously online users do not invalidate the roster.
CREATE TRIGGER messenger_user_added AFTER INSERT ON messenger_users BEGIN
  UPDATE messenger_directory SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER messenger_user_removed AFTER DELETE ON messenger_users BEGIN
  UPDATE messenger_directory SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER messenger_profile_changed AFTER UPDATE OF name, avatar, last_seen ON messenger_users
WHEN OLD.name <> NEW.name OR OLD.avatar <> NEW.avatar OR NEW.last_seen - OLD.last_seen >= 60000 BEGIN
  UPDATE messenger_directory SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER messenger_member_added AFTER INSERT ON messenger_members BEGIN
  UPDATE messenger_conversations SET revision = revision + 1 WHERE id = NEW.conversation_id;
END;
CREATE TRIGGER messenger_member_removed AFTER DELETE ON messenger_members BEGIN
  UPDATE messenger_conversations SET revision = revision + 1 WHERE id = OLD.conversation_id;
END;
CREATE TRIGGER messenger_message_added AFTER INSERT ON messenger_messages BEGIN
  UPDATE messenger_conversations SET revision = revision + 1 WHERE id = NEW.conversation_id;
END;
CREATE TRIGGER messenger_message_removed AFTER DELETE ON messenger_messages BEGIN
  UPDATE messenger_conversations SET revision = revision + 1 WHERE id = OLD.conversation_id;
END;
CREATE TRIGGER messenger_message_changed AFTER UPDATE OF file_id ON messenger_messages BEGIN
  UPDATE messenger_conversations SET revision = revision + 1 WHERE id = NEW.conversation_id;
END;
CREATE TRIGGER messenger_file_added AFTER INSERT ON messenger_files BEGIN
  UPDATE messenger_users SET revision = revision + 1 WHERE id = NEW.owner_id;
END;
CREATE TRIGGER messenger_file_removed AFTER DELETE ON messenger_files BEGIN
  UPDATE messenger_users SET revision = revision + 1 WHERE id = OLD.owner_id;
END;
CREATE TRIGGER messenger_transfer_added AFTER INSERT ON messenger_transfers BEGIN
  UPDATE messenger_users SET revision = revision + 1 WHERE id IN (NEW.owner_id, NEW.requester_id);
END;
CREATE TRIGGER messenger_transfer_changed AFTER UPDATE ON messenger_transfers BEGIN
  UPDATE messenger_users SET revision = revision + 1 WHERE id IN (NEW.owner_id, NEW.requester_id);
END;
CREATE TRIGGER messenger_transfer_removed AFTER DELETE ON messenger_transfers BEGIN
  UPDATE messenger_users SET revision = revision + 1 WHERE id IN (OLD.owner_id, OLD.requester_id);
END;
