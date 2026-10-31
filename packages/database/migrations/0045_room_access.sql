ALTER TABLE participant ADD COLUMN access_version integer NOT NULL DEFAULT 1;
ALTER TABLE participant ADD COLUMN allowed_permissions text[];
ALTER TABLE participant ADD CONSTRAINT participant_access_version_check CHECK (access_version > 0);
ALTER TABLE participant ADD CONSTRAINT participant_allowed_permissions_check CHECK (
  allowed_permissions IS NULL OR (allowed_permissions <@ ARRAY['room:join','audio:publish','video:publish','screen:publish','messages:send','metadata:update']::text[]
  AND 'room:join' = ANY(allowed_permissions) AND cardinality(allowed_permissions) <= 6 AND array_position(allowed_permissions,NULL) IS NULL)
);
CREATE UNIQUE INDEX participant_room_host_idx ON participant(room_id) WHERE role = 'host' AND removed_at IS NULL;
ALTER TABLE audit_event ADD COLUMN room_id text;
ALTER TABLE audit_event DROP CONSTRAINT audit_event_actor_type_check;
ALTER TABLE audit_event ADD CONSTRAINT audit_event_actor_type_check CHECK (actor_type IN ('USER','SYSTEM','API_KEY','ANONYMOUS','PARTICIPANT'));
CREATE INDEX audit_room_idx ON audit_event(room_id, occurred_at, id);
CREATE INDEX audit_resource_idx ON audit_event(resource_type, resource_id, occurred_at, id);

CREATE FUNCTION room_participant_access(target participant) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('roomId', (target).room_id, 'participantId', (target).id,
    'role', CASE WHEN (target).role IN ('host','moderator') THEN (target).role ELSE 'participant' END,
    'version', (target).access_version, 'allowedPermissions', to_jsonb((target).allowed_permissions));
$$;

CREATE FUNCTION update_room_participant_access(room_id_value text, target_id text, expected_version integer,
  next_role text, next_permissions text[], actor_participant_id text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE target participant; actor participant; current_host participant; room_state text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(room_id_value, 732));
  SELECT status INTO room_state FROM room WHERE id = room_id_value FOR UPDATE;
  IF room_state IS NULL THEN RAISE EXCEPTION 'ROOM_NOT_FOUND'; END IF;
  IF room_state NOT IN ('created','active') THEN RAISE EXCEPTION 'ROOM_NOT_JOINABLE'; END IF;
  SELECT * INTO target FROM participant WHERE id = target_id AND room_id = room_id_value AND removed_at IS NULL FOR UPDATE;
  IF target.id IS NULL THEN RAISE EXCEPTION 'PARTICIPANT_NOT_FOUND'; END IF;
  IF left(target.id,7) = 'guestp_' THEN RAISE EXCEPTION 'ROOM_ACCESS_FORBIDDEN'; END IF;
  IF target.access_version <> expected_version THEN RAISE EXCEPTION 'ROOM_ACCESS_CONFLICT'; END IF;
  IF next_role NOT IN ('host','moderator','participant') OR next_role IS NULL THEN RAISE EXCEPTION 'ROOM_ACCESS_INVALID'; END IF;
  IF actor_participant_id IS NOT NULL THEN
    SELECT * INTO actor FROM participant WHERE id = actor_participant_id AND room_id = room_id_value
      AND left_at IS NULL AND removed_at IS NULL FOR UPDATE;
    IF actor.id IS NULL OR actor.role NOT IN ('host','moderator') OR left(actor.id,7) = 'guestp_' THEN RAISE EXCEPTION 'ROOM_ACCESS_FORBIDDEN'; END IF;
    IF actor.role = 'moderator' AND (target.role <> 'participant' OR next_role <> 'participant'
      OR target.id = actor.id OR next_permissions IS NULL
      OR NOT next_permissions <@ coalesce(target.allowed_permissions, ARRAY['room:join','audio:publish','video:publish','screen:publish','messages:send','metadata:update']::text[])) THEN
      RAISE EXCEPTION 'ROOM_ACCESS_FORBIDDEN';
    END IF;
  END IF;
  IF target.role = 'host' AND next_role <> 'host' THEN RAISE EXCEPTION 'ROOM_HOST_TRANSFER_REQUIRED'; END IF;
  IF next_role = 'host' AND target.left_at IS NOT NULL THEN RAISE EXCEPTION 'ROOM_HOST_MUST_BE_PRESENT'; END IF;
  IF next_role = 'host' THEN
    SELECT * INTO current_host FROM participant WHERE room_id = room_id_value AND role = 'host' AND removed_at IS NULL AND id <> target_id FOR UPDATE;
    IF current_host.id IS NOT NULL THEN
      UPDATE participant SET role = 'participant', access_version = access_version + 1 WHERE id = current_host.id;
    END IF;
  END IF;
  IF target.role = next_role AND target.allowed_permissions IS NOT DISTINCT FROM next_permissions THEN
    RETURN room_participant_access(target);
  END IF;
  UPDATE participant SET role = next_role, allowed_permissions = next_permissions, access_version = access_version + 1
    WHERE id = target_id RETURNING * INTO target;
  RETURN room_participant_access(target);
END $$;

CREATE FUNCTION audit_room_participant_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant text;
BEGIN
  IF NEW.role IS NOT DISTINCT FROM OLD.role AND NEW.allowed_permissions IS NOT DISTINCT FROM OLD.allowed_permissions
    AND NEW.removed_at IS NOT DISTINCT FROM OLD.removed_at THEN RETURN NEW; END IF;
  SELECT p.organization_id INTO tenant FROM room r JOIN project p ON p.id = r.project_id WHERE r.id = NEW.room_id;
  INSERT INTO audit_event(id, actor_type, actor_id, actor_name, organization_id, room_id, resource_type, resource_id, action, outcome, correlation_id, metadata)
    VALUES (gen_random_uuid()::text, coalesce(nullif(current_setting('relayrtc.audit_actor_type',true),''),'SYSTEM'),
      nullif(current_setting('relayrtc.audit_actor_id',true),''), coalesce(nullif(current_setting('relayrtc.audit_actor_name',true),''),'Room lifecycle'),
      tenant, NEW.room_id, 'participant', NEW.id,
      CASE WHEN NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN 'room.participant_removed' ELSE 'room.participant_access_updated' END,
      'SUCCESS', nullif(current_setting('relayrtc.audit_correlation_id',true),''),
      jsonb_build_object('previousRole', OLD.role, 'role', NEW.role, 'version', NEW.access_version,
        'permissionsRestricted', NEW.allowed_permissions IS NOT NULL,
        'previousPermissions', array_to_string(OLD.allowed_permissions,','), 'allowedPermissions', array_to_string(NEW.allowed_permissions,',')));
  RETURN NEW;
END $$;
CREATE TRIGGER room_participant_access_audit AFTER UPDATE ON participant FOR EACH ROW EXECUTE FUNCTION audit_room_participant_access();
