ALTER TABLE turn_credential ADD COLUMN realm text;
ALTER TABLE turn_credential ADD COLUMN authentication_key text;
ALTER TABLE turn_credential ADD COLUMN revoked_at timestamptz;
ALTER TABLE turn_credential ADD CONSTRAINT turn_credential_managed_key_check
 CHECK ((realm IS NULL) = (authentication_key IS NULL) AND
 (authentication_key IS NULL OR authentication_key ~ '^[0-9a-f]{32}$'));
CREATE INDEX turn_credential_project_scope_idx ON turn_credential (project_id) WHERE revoked_at IS NULL;
CREATE INDEX turn_credential_environment_scope_idx ON turn_credential (environment_id) WHERE revoked_at IS NULL;
CREATE INDEX turn_credential_session_scope_idx ON turn_credential (session_id) WHERE revoked_at IS NULL;

CREATE FUNCTION retire_owned_turn_credentials() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retired boolean;
BEGIN
 IF TG_OP = 'DELETE' THEN
  retired := true;
 ELSIF TG_TABLE_NAME = 'room' THEN
  retired := NEW.status <> 'active' OR NEW.ended_at IS NOT NULL;
 ELSIF TG_TABLE_NAME IN ('organization', 'project', 'environment') THEN
  retired := NEW.status <> 'active';
 ELSIF TG_TABLE_NAME = 'participant' THEN
  retired := NEW.left_at IS NOT NULL OR NEW.removed_at IS NOT NULL;
 ELSE
  retired := NEW.connection_state NOT IN ('connected', 'reconnecting');
 END IF;
 IF retired THEN
  UPDATE turn_credential c SET revoked_at = clock_timestamp()
  WHERE c.revoked_at IS NULL AND CASE TG_TABLE_NAME
   WHEN 'organization' THEN c.organization_id = OLD.id
   WHEN 'project' THEN c.project_id = OLD.id
   WHEN 'environment' THEN c.environment_id = OLD.id
   WHEN 'room' THEN c.room_id = OLD.id
   WHEN 'participant' THEN c.participant_id = OLD.id
   ELSE c.session_id = OLD.id END;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;

CREATE TRIGGER retire_organization_turn_credentials AFTER UPDATE OF status OR DELETE ON organization
 FOR EACH ROW EXECUTE FUNCTION retire_owned_turn_credentials();
CREATE TRIGGER retire_project_turn_credentials AFTER UPDATE OF status OR DELETE ON project
 FOR EACH ROW EXECUTE FUNCTION retire_owned_turn_credentials();
CREATE TRIGGER retire_environment_turn_credentials AFTER UPDATE OF status OR DELETE ON environment
 FOR EACH ROW EXECUTE FUNCTION retire_owned_turn_credentials();
CREATE TRIGGER retire_room_turn_credentials AFTER UPDATE OF status, ended_at OR DELETE ON room
 FOR EACH ROW EXECUTE FUNCTION retire_owned_turn_credentials();
CREATE TRIGGER retire_participant_turn_credentials AFTER UPDATE OF left_at, removed_at OR DELETE ON participant
 FOR EACH ROW EXECUTE FUNCTION retire_owned_turn_credentials();
CREATE TRIGGER retire_session_turn_credentials AFTER UPDATE OF connection_state OR DELETE ON participant_session
 FOR EACH ROW EXECUTE FUNCTION retire_owned_turn_credentials();

ALTER TABLE turn_allocation ADD COLUMN generation_offset bigint NOT NULL DEFAULT 0;
ALTER TABLE turn_allocation ADD COLUMN retirement_checked_at timestamptz;
ALTER TABLE turn_allocation DROP CONSTRAINT turn_allocation_source_id_native_id_key;
ALTER TABLE turn_allocation ADD CONSTRAINT turn_allocation_source_generation_key
 UNIQUE (source_id, native_id, generation_offset);

CREATE VIEW turn_credential_authority AS
 SELECT c.username FROM turn_credential c
 JOIN project pr ON pr.id = c.project_id AND pr.organization_id = c.organization_id
 JOIN environment e ON e.id = c.environment_id AND e.project_id = pr.id
 JOIN organization o ON o.id = c.organization_id
 WHERE c.revoked_at IS NULL AND c.expires_at > now() AND c.issued_at <= now()
 AND pr.status = 'active' AND e.status = 'active' AND o.status = 'active'
 AND (c.room_id IS NULL OR EXISTS (
  SELECT 1 FROM room r JOIN participant p ON p.room_id = r.id
  JOIN participant_session s ON s.participant_id = p.id
  WHERE r.id = c.room_id AND r.project_id = c.project_id AND r.environment_id = c.environment_id
  AND r.status = 'active' AND r.ended_at IS NULL
  AND s.id = c.session_id AND p.id = c.participant_id AND p.left_at IS NULL AND p.removed_at IS NULL
  AND s.connection_state IN ('connected', 'reconnecting')
  AND (s.signaling_instance_id IS NULL OR EXISTS (
   SELECT 1 FROM signaling_node_lease l WHERE l.node_id = s.signaling_node_id
   AND l.instance_id = s.signaling_instance_id AND l.expires_at > now()
  ))
 ));

CREATE VIEW turnusers_lt AS
 SELECT c.username AS name, c.realm, c.authentication_key AS hmackey
 FROM turn_credential c JOIN turn_credential_authority a ON a.username = c.username
 WHERE c.realm IS NOT NULL AND c.authentication_key IS NOT NULL;
