CREATE TABLE streaming_stream (
 id text PRIMARY KEY, organization_id text NOT NULL, project_id text NOT NULL, environment_id text NOT NULL,
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120), source jsonb NOT NULL, profile jsonb NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleting','deleted')),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0), playback_epoch integer NOT NULL DEFAULT 1,
 max_duration_seconds integer NOT NULL CHECK (max_duration_seconds BETWEEN 60 AND 86400),
 retention_seconds integer NOT NULL CHECK (retention_seconds BETWEEN 60 AND 86400),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (source->>'kind' IN ('room','whip','rtmp')), CHECK (jsonb_typeof(profile) = 'object')
);
CREATE INDEX streaming_stream_scope_idx ON streaming_stream(project_id,environment_id,id);
CREATE TABLE streaming_ingest_credential (
 id text PRIMARY KEY, stream_id text NOT NULL REFERENCES streaming_stream(id), secret_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX streaming_ingest_stream_idx ON streaming_ingest_credential(stream_id);
CREATE TABLE streaming_session (
 id text PRIMARY KEY, stream_id text NOT NULL REFERENCES streaming_stream(id),
 state text NOT NULL DEFAULT 'starting' CHECK (state IN ('starting','live','reconnecting','stopping','ended','failed')),
 desired_state text NOT NULL DEFAULT 'running' CHECK (desired_state IN ('running','stopped')),
 generation integer NOT NULL DEFAULT 0, attempts integer NOT NULL DEFAULT 0,
 lease_token text, worker_id text, leased_until timestamptz, last_heartbeat_at timestamptz,
 ingress_id text, ingress_type text, ingress_credential_id text REFERENCES streaming_ingest_credential(id), whip_resource text,
 started_at timestamptz, ended_at timestamptz, last_error text,
 source_info jsonb NOT NULL DEFAULT '{"tracks":[]}'::jsonb, ingress_bitrate bigint NOT NULL DEFAULT 0, program_bitrate bigint NOT NULL DEFAULT 0,
 ingress_bytes bigint NOT NULL DEFAULT 0 CHECK (ingress_bytes >= 0), program_bytes bigint NOT NULL DEFAULT 0 CHECK (program_bytes >= 0),
 sample_sequence integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX streaming_session_active_idx ON streaming_session(stream_id) WHERE state NOT IN ('ended','failed');
CREATE INDEX streaming_session_claim_idx ON streaming_session(available_at,leased_until) WHERE state NOT IN ('ended','failed');
CREATE TABLE streaming_operation (
 id text PRIMARY KEY, stream_id text NOT NULL REFERENCES streaming_stream(id), session_id text REFERENCES streaming_session(id),
 kind text NOT NULL CHECK (kind IN ('start','stop','delete')), status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
 error_code text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE streaming_idempotency (
 scope_key text NOT NULL, key text NOT NULL, fingerprint text NOT NULL, response jsonb NOT NULL, status integer NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours', PRIMARY KEY(scope_key,key)
);
CREATE INDEX streaming_idempotency_expiry_idx ON streaming_idempotency(expires_at);
CREATE TABLE streaming_object (
 session_id text NOT NULL REFERENCES streaming_session(id), name text NOT NULL, object_key text NOT NULL UNIQUE,
 size_bytes bigint NOT NULL CHECK (size_bytes >= 0), sha256 text NOT NULL, content_type text NOT NULL,
 referenced_names text[] NOT NULL DEFAULT ARRAY[]::text[],
 committed_at timestamptz, expires_at timestamptz NOT NULL, PRIMARY KEY(session_id,name)
);
CREATE INDEX streaming_object_expiry_idx ON streaming_object(expires_at);
CREATE TABLE streaming_usage_sample (
 session_id text NOT NULL REFERENCES streaming_session(id), generation integer NOT NULL, sequence integer NOT NULL,
 stream_id text NOT NULL REFERENCES streaming_stream(id), organization_id text NOT NULL, project_id text NOT NULL, environment_id text NOT NULL,
 start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, source_seconds double precision NOT NULL CHECK (source_seconds >= 0),
 ingress_bytes bigint NOT NULL CHECK (ingress_bytes >= 0), program_bytes bigint NOT NULL CHECK (program_bytes >= 0),
 coverage text NOT NULL CHECK (coverage IN ('observed','partial')), PRIMARY KEY(session_id,generation,sequence), CHECK(end_at >= start_at)
);
CREATE INDEX streaming_usage_scope_idx ON streaming_usage_sample(project_id,environment_id,end_at);

CREATE FUNCTION validate_streaming_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM environment e JOIN project p ON p.id=e.project_id JOIN organization o ON o.id=p.organization_id
 WHERE e.id=NEW.environment_id AND p.id=NEW.project_id AND o.id=NEW.organization_id
 AND e.status='active' AND p.status='active' AND o.status='active') THEN
 RAISE EXCEPTION 'Streaming owner is unavailable'; END IF;
 IF NEW.source->>'kind'='room' AND NOT EXISTS (SELECT 1 FROM room WHERE id=NEW.source->>'roomId'
 AND project_id=NEW.project_id AND environment_id=NEW.environment_id AND status IN ('created','active')) THEN
 RAISE EXCEPTION 'Streaming room scope is invalid'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER streaming_validate_scope BEFORE INSERT OR UPDATE OF source,project_id,environment_id,organization_id
 ON streaming_stream FOR EACH ROW EXECUTE FUNCTION validate_streaming_scope();

CREATE FUNCTION stop_owned_streaming() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text := OLD.id;
BEGIN
 IF TG_OP='DELETE' OR (TG_TABLE_NAME='room' AND NEW.status IN ('ending','ended','failed'))
 OR (TG_TABLE_NAME<>'room' AND NEW.status<>'active') THEN
   UPDATE streaming_stream SET status=CASE WHEN TG_TABLE_NAME='room' THEN status ELSE 'deleting' END,
     playback_epoch=playback_epoch+1, version=version+1, updated_at=now()
   WHERE status<>'deleted' AND CASE TG_TABLE_NAME WHEN 'organization' THEN organization_id=owner_id
     WHEN 'project' THEN project_id=owner_id WHEN 'environment' THEN environment_id=owner_id
     WHEN 'room' THEN source->>'roomId'=owner_id ELSE false END;
   UPDATE streaming_session s SET desired_state='stopped', state='stopping', updated_at=now()
   FROM streaming_stream t WHERE s.stream_id=t.id AND s.state NOT IN ('ended','failed')
   AND CASE TG_TABLE_NAME WHEN 'organization' THEN t.organization_id=owner_id WHEN 'project' THEN t.project_id=owner_id
     WHEN 'environment' THEN t.environment_id=owner_id WHEN 'room' THEN t.source->>'roomId'=owner_id ELSE false END;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER streaming_organization_stop BEFORE DELETE OR UPDATE OF status ON organization FOR EACH ROW EXECUTE FUNCTION stop_owned_streaming();
CREATE TRIGGER streaming_project_stop BEFORE DELETE OR UPDATE OF status ON project FOR EACH ROW EXECUTE FUNCTION stop_owned_streaming();
CREATE TRIGGER streaming_environment_stop BEFORE DELETE OR UPDATE OF status ON environment FOR EACH ROW EXECUTE FUNCTION stop_owned_streaming();
CREATE TRIGGER streaming_room_stop BEFORE DELETE OR UPDATE OF status ON room FOR EACH ROW EXECUTE FUNCTION stop_owned_streaming();

DO $$ DECLARE item record;
BEGIN
 FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='webhook_endpoint'::regclass AND contype='c'
 AND (pg_get_constraintdef(oid) LIKE '%event_types%') LOOP
 EXECUTE format('ALTER TABLE webhook_endpoint DROP CONSTRAINT %I',item.conname); END LOOP;
 FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='webhook_event'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%event_type%' LOOP
 EXECUTE format('ALTER TABLE webhook_event DROP CONSTRAINT %I',item.conname); END LOOP;
END $$;
ALTER TABLE webhook_endpoint ADD CONSTRAINT webhook_endpoint_event_types_check CHECK (
 cardinality(event_types) BETWEEN 1 AND 16 AND array_position(event_types,NULL) IS NULL AND
 event_types <@ ARRAY['room.created','room.started','room.ended','participant.joined','participant.left','participant.reconnected','track.published','track.unpublished','connection.degraded','connection.recovered','stream.created','stream.starting','stream.live','stream.reconnecting','stream.ended','stream.failed']::text[]);
ALTER TABLE webhook_event ADD CONSTRAINT webhook_event_type_check CHECK (event_type IN ('room.created','room.started','room.ended','participant.joined','participant.left','participant.reconnected','track.published','track.unpublished','connection.degraded','connection.recovered','stream.created','stream.starting','stream.live','stream.reconnecting','stream.ended','stream.failed'));
