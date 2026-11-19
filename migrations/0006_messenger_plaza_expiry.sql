-- One permanent group, including on upgraded deployments with existing identities.
INSERT INTO messenger_conversations (id, kind, created_at)
VALUES ('00000000000000000000000000000000', 'group', unixepoch() * 1000);
INSERT INTO messenger_members (conversation_id, user_id)
SELECT '00000000000000000000000000000000', id FROM messenger_users;

DROP TRIGGER messenger_delete_empty_groups;
CREATE TRIGGER messenger_delete_empty_groups AFTER DELETE ON messenger_members
WHEN OLD.conversation_id <> '00000000000000000000000000000000'
  AND NOT EXISTS (SELECT 1 FROM messenger_members WHERE conversation_id = OLD.conversation_id)
BEGIN
  DELETE FROM messenger_conversations WHERE id = OLD.conversation_id AND kind = 'group';
END;

-- The plaza contains every user, so its latest heartbeat is an indexed MAX.
CREATE VIEW messenger_room_presence AS
SELECT c.id, c.kind, COALESCE(CASE WHEN c.id = '00000000000000000000000000000000'
  THEN (SELECT MAX(last_seen) FROM messenger_users)
  ELSE (SELECT MAX(u.last_seen) FROM messenger_members mm JOIN messenger_users u ON u.id = mm.user_id
        WHERE mm.conversation_id = c.id)
  END, 0) AS last_seen
FROM messenger_conversations c;

-- Expire before extending a lease, in the very same write transaction. Regular
-- heartbeats never run these queries. The intervals include the 60s online lease.
CREATE TRIGGER messenger_return_after_inactivity BEFORE UPDATE OF last_seen ON messenger_users
WHEN NEW.last_seen - OLD.last_seen >= 660000
BEGIN
  DELETE FROM messenger_conversations WHERE id IN (
    SELECT p.id FROM messenger_members mm JOIN messenger_room_presence p ON p.id = mm.conversation_id
    WHERE mm.user_id = OLD.id AND p.kind = 'group' AND p.id <> '00000000000000000000000000000000'
      AND p.last_seen <= NEW.last_seen - 3660000
  );
  DELETE FROM messenger_messages WHERE conversation_id IN (
    SELECT p.id FROM messenger_members mm JOIN messenger_room_presence p ON p.id = mm.conversation_id
    WHERE mm.user_id = OLD.id AND p.last_seen <= NEW.last_seen - 660000
  );
END;

CREATE TRIGGER messenger_check_plaza_before_arrival BEFORE INSERT ON messenger_users
WHEN NOT EXISTS (SELECT 1 FROM messenger_users WHERE last_seen > NEW.last_seen - 660000)
BEGIN
  DELETE FROM messenger_messages WHERE conversation_id = '00000000000000000000000000000000';
END;
CREATE TRIGGER messenger_join_plaza AFTER INSERT ON messenger_users
BEGIN
  INSERT INTO messenger_members (conversation_id, user_id) VALUES ('00000000000000000000000000000000', NEW.id);
END;

-- A room-scoped download must not become valid again if the same file is shared
-- after its original chat history expired. Deleting tickets queues room revocation.
CREATE TRIGGER messenger_remove_file_grants AFTER DELETE ON messenger_messages
WHEN OLD.file_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM messenger_messages WHERE file_id = OLD.file_id AND conversation_id = OLD.conversation_id
)
BEGIN
  DELETE FROM messenger_transfers WHERE file_id = OLD.file_id AND conversation_id = OLD.conversation_id;
END;
