CREATE TABLE room_lifecycle (
  room_id text PRIMARY KEY REFERENCES room(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  locked boolean NOT NULL DEFAULT false,
  ends_at timestamptz,
  settled_at timestamptz
);
CREATE INDEX room_lifecycle_deadline_idx ON room_lifecycle(ends_at) WHERE ends_at IS NOT NULL AND settled_at IS NULL;
INSERT INTO room_lifecycle(room_id,settled_at) SELECT id,CASE WHEN status IN ('ending','ended','failed') THEN now() ELSE NULL END FROM room;
CREATE FUNCTION initialize_room_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO room_lifecycle(room_id,settled_at) VALUES (NEW.id,CASE WHEN NEW.status IN ('ending','ended','failed') THEN now() ELSE NULL END);
  RETURN NEW;
END $$;
CREATE TRIGGER room_lifecycle_initialize AFTER INSERT ON room FOR EACH ROW EXECUTE FUNCTION initialize_room_lifecycle();

CREATE FUNCTION read_room_lifecycle(room_id_value text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('roomId',room_id,'version',version,'locked',locked,'endsAt',
    CASE WHEN ends_at IS NULL THEN NULL ELSE to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'warning',ends_at IS NOT NULL AND ends_at <= now()+interval '60 seconds',
    'serverTime',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM room_lifecycle WHERE room_id=room_id_value;
$$;

CREATE FUNCTION update_room_lifecycle(room_id_value text, expected_version integer, next_locked boolean,
  next_ends_at timestamptz, actor_participant_id text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE target room; policy room_lifecycle;
BEGIN
  SELECT * INTO target FROM room WHERE id=room_id_value FOR UPDATE;
  IF target.id IS NULL THEN RAISE EXCEPTION 'ROOM_NOT_FOUND'; END IF;
  SELECT * INTO policy FROM room_lifecycle WHERE room_id=room_id_value FOR UPDATE;
  IF target.status NOT IN ('created','active') OR (policy.ends_at IS NOT NULL AND policy.ends_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'ROOM_NOT_JOINABLE';
  END IF;
  IF actor_participant_id IS NOT NULL THEN
    PERFORM 1 FROM participant WHERE id=actor_participant_id AND room_id=room_id_value
      AND removed_at IS NULL AND left_at IS NULL AND role IN ('host','moderator') AND left(id,7)<>'guestp_' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ROOM_LIFECYCLE_FORBIDDEN'; END IF;
  END IF;
  IF policy.version <> expected_version THEN RAISE EXCEPTION 'ROOM_LIFECYCLE_CONFLICT'; END IF;
  IF next_locked IS NULL OR (next_ends_at IS NOT NULL AND (next_ends_at <= clock_timestamp() OR next_ends_at > clock_timestamp()+interval '7 days')) THEN
    RAISE EXCEPTION 'ROOM_DEADLINE_INVALID';
  END IF;
  UPDATE room_lifecycle SET locked=next_locked,ends_at=next_ends_at,version=version+1 WHERE room_id=room_id_value;
  RETURN read_room_lifecycle(room_id_value);
END $$;

CREATE TABLE room_invitation (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  secret_hash text NOT NULL,
  identity text,
  permissions text[] NOT NULL CHECK (permissions <@ ARRAY['room:join','audio:publish','video:publish','screen:publish','messages:send','metadata:update']::text[]
    AND 'room:join'=ANY(permissions) AND cardinality(permissions) BETWEEN 1 AND 6 AND array_position(permissions,NULL) IS NULL),
  max_uses integer NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= max_uses),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX room_invitation_secret_idx ON room_invitation(secret_hash);
CREATE INDEX room_invitation_room_idx ON room_invitation(room_id,id);
CREATE TABLE room_invitation_redemption (
  participant_id text PRIMARY KEY,
  invitation_id text NOT NULL REFERENCES room_invitation(id) ON DELETE CASCADE,
  redemption_id text NOT NULL,
  identity text NOT NULL,
  claims jsonb NOT NULL
);
CREATE UNIQUE INDEX room_invitation_redemption_key_idx ON room_invitation_redemption(invitation_id,redemption_id);

CREATE FUNCTION enforce_room_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target room; policy room_lifecycle; grant_row room_invitation_redemption; invite room_invitation;
BEGIN
  SELECT * INTO target FROM room WHERE id=NEW.room_id FOR UPDATE;
  SELECT * INTO policy FROM room_lifecycle WHERE room_id=NEW.room_id;
  IF target.status NOT IN ('created','active') OR (policy.ends_at IS NOT NULL AND policy.ends_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'ROOM_NOT_JOINABLE';
  END IF;
  IF policy.locked THEN RAISE EXCEPTION 'ROOM_LOCKED'; END IF;
  IF (SELECT count(*) FROM participant WHERE room_id=NEW.room_id AND left_at IS NULL AND removed_at IS NULL)>=target.max_participants THEN
    RAISE EXCEPTION 'ROOM_FULL';
  END IF;
  SELECT * INTO grant_row FROM room_invitation_redemption WHERE participant_id=NEW.id;
  IF grant_row.participant_id IS NOT NULL THEN
    SELECT * INTO invite FROM room_invitation WHERE id=grant_row.invitation_id;
    IF invite.room_id<>NEW.room_id OR invite.revoked_at IS NOT NULL OR invite.expires_at<=clock_timestamp()
      OR (grant_row.claims->>'expiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'ROOM_INVITATION_UNAVAILABLE'; END IF;
    NEW.allowed_permissions=invite.permissions;
    NEW.external_id=grant_row.identity;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER participant_admission_guard BEFORE INSERT ON participant FOR EACH ROW EXECUTE FUNCTION enforce_room_admission();

CREATE FUNCTION audit_room_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE room_key text; resource_key text; event_name text; tenant text;
BEGIN
  room_key=NEW.room_id;
  IF TG_TABLE_NAME='room_lifecycle' THEN
    IF NEW.locked IS NOT DISTINCT FROM OLD.locked AND NEW.ends_at IS NOT DISTINCT FROM OLD.ends_at THEN RETURN NEW; END IF;
    resource_key=room_key;
    event_name='room.lifecycle_updated';
  ELSE
    IF TG_OP='UPDATE' AND NEW.uses IS NOT DISTINCT FROM OLD.uses AND NEW.revoked_at IS NOT DISTINCT FROM OLD.revoked_at THEN RETURN NEW; END IF;
    resource_key=NEW.id;
    event_name=CASE WHEN TG_OP='INSERT' THEN 'room.invitation_created' WHEN NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN 'room.invitation_revoked' ELSE 'room.invitation_redeemed' END;
  END IF;
  SELECT p.organization_id INTO tenant FROM room r JOIN project p ON p.id=r.project_id WHERE r.id=room_key;
  INSERT INTO audit_event(id,actor_type,actor_id,actor_name,organization_id,room_id,resource_type,resource_id,action,outcome,correlation_id,metadata)
    VALUES(gen_random_uuid()::text,coalesce(nullif(current_setting('relayrtc.audit_actor_type',true),''),'SYSTEM'),
      nullif(current_setting('relayrtc.audit_actor_id',true),''),coalesce(nullif(current_setting('relayrtc.audit_actor_name',true),''),'Room lifecycle'),
      tenant,room_key,TG_TABLE_NAME,resource_key,event_name,'SUCCESS',nullif(current_setting('relayrtc.audit_correlation_id',true),''),'{}'::jsonb);
  RETURN NEW;
END $$;
CREATE TRIGGER room_lifecycle_audit AFTER UPDATE ON room_lifecycle FOR EACH ROW EXECUTE FUNCTION audit_room_lifecycle();
CREATE TRIGGER room_invitation_audit AFTER INSERT OR UPDATE ON room_invitation FOR EACH ROW EXECUTE FUNCTION audit_room_lifecycle();

CREATE FUNCTION audit_room_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='ended' AND OLD.status IN ('created','active')
    AND EXISTS(SELECT 1 FROM room_lifecycle WHERE room_id=NEW.id AND ends_at<=clock_timestamp()) THEN
    INSERT INTO audit_event(id,actor_type,actor_name,organization_id,room_id,resource_type,resource_id,action,outcome,metadata)
      SELECT gen_random_uuid()::text,'SYSTEM','Room deadline',p.organization_id,NEW.id,'room',NEW.id,'room.deadline_reached','SUCCESS','{}'::jsonb
      FROM project p WHERE p.id=NEW.project_id;
  END IF;
  IF NEW.status IN ('ending','ended','failed') AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE room_lifecycle SET settled_at=coalesce(settled_at,clock_timestamp()) WHERE room_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER room_deadline_audit AFTER UPDATE OF status ON room FOR EACH ROW EXECUTE FUNCTION audit_room_deadline();
