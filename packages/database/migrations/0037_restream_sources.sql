CREATE TABLE restream_source (
 id text PRIMARY KEY,stream_id text NOT NULL REFERENCES streaming_stream(id),project_id text NOT NULL,environment_id text NOT NULL,
 name text NOT NULL,protocol text NOT NULL CHECK(protocol IN ('hls_pull','rtmp_push','whip_push')),host text,encrypted_secret text,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),reconnect_budget integer NOT NULL DEFAULT 3 CHECK(reconnect_budget BETWEEN 0 AND 5),
 max_duration_seconds integer NOT NULL CHECK(max_duration_seconds BETWEEN 60 AND 86400),max_bytes bigint NOT NULL CHECK(max_bytes BETWEEN 1048576 AND 20000000000),
 state text NOT NULL DEFAULT 'created' CHECK(state IN ('created','probing','ready','connecting','live','recovering','stopped','failed')),last_error text,deleted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((protocol='hls_pull')=(encrypted_secret IS NOT NULL) OR deleted_at IS NOT NULL)
);
CREATE INDEX restream_source_scope_idx ON restream_source(project_id,environment_id,id);
CREATE TABLE restream_session (
 id text PRIMARY KEY,source_id text NOT NULL REFERENCES restream_source(id),stream_id text NOT NULL REFERENCES streaming_stream(id),kind text NOT NULL CHECK(kind IN ('probe','pull','push')),
 state text NOT NULL,desired_state text NOT NULL DEFAULT 'running' CHECK(desired_state IN ('running','stopped')),
 attempts integer NOT NULL DEFAULT 0,fence integer NOT NULL DEFAULT 0,lease_token text,leased_until timestamptz,credential_id text REFERENCES streaming_ingest_credential(id),
 available_at timestamptz NOT NULL DEFAULT now(),deadline timestamptz NOT NULL,sample_sequence integer NOT NULL DEFAULT 0,attempt_fetched_bytes bigint NOT NULL DEFAULT 0,attempt_processing_seconds double precision NOT NULL DEFAULT 0,fetched_bytes bigint NOT NULL DEFAULT 0 CHECK(fetched_bytes>=0),processing_seconds double precision NOT NULL DEFAULT 0 CHECK(processing_seconds>=0),last_error text,created_at timestamptz NOT NULL DEFAULT now(),ended_at timestamptz,
 CHECK((lease_token IS NULL)=(leased_until IS NULL))
);
CREATE UNIQUE INDEX restream_session_active_idx ON restream_session(source_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX restream_stream_active_idx ON restream_session(stream_id) WHERE ended_at IS NULL AND kind<>'probe';
CREATE INDEX restream_session_claim_idx ON restream_session(available_at,leased_until) WHERE ended_at IS NULL;
CREATE INDEX restream_session_lease_idx ON restream_session(lease_token) WHERE lease_token IS NOT NULL;
CREATE INDEX restream_session_history_idx ON restream_session(source_id,created_at DESC);
CREATE TABLE restream_health (id bigserial PRIMARY KEY,source_id text NOT NULL REFERENCES restream_source(id),session_id text REFERENCES restream_session(id),state text NOT NULL,reason text,occurred_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX restream_health_source_idx ON restream_health(source_id,id DESC);
CREATE TABLE restream_usage (session_id text NOT NULL REFERENCES restream_session(id),fence integer NOT NULL,sequence integer NOT NULL,fetched_bytes bigint NOT NULL CHECK(fetched_bytes>=0),processing_seconds double precision NOT NULL CHECK(processing_seconds>=0),occurred_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(session_id,fence,sequence));
CREATE FUNCTION guard_restream_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND (NEW.stream_id<>OLD.stream_id OR NEW.project_id<>OLD.project_id OR NEW.environment_id<>OLD.environment_id OR NEW.protocol<>OLD.protocol) THEN RAISE EXCEPTION 'immutable source attachment'; END IF;
 IF NOT EXISTS(SELECT 1 FROM streaming_stream s WHERE s.id=NEW.stream_id AND s.project_id=NEW.project_id AND s.environment_id=NEW.environment_id AND s.status='active' AND s.source->>'kind'=CASE WHEN NEW.protocol='whip_push' THEN 'whip' ELSE 'rtmp' END) AND NEW.deleted_at IS NULL THEN RAISE EXCEPTION 'invalid source attachment'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER restream_source_guard BEFORE INSERT OR UPDATE ON restream_source FOR EACH ROW EXECUTE FUNCTION guard_restream_source();
CREATE FUNCTION retire_restream_sources() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.status<>'active' THEN
  UPDATE restream_session SET desired_state='stopped' WHERE stream_id=NEW.id AND ended_at IS NULL;
  UPDATE streaming_ingest_credential SET revoked_at=now() WHERE id IN(SELECT credential_id FROM restream_session WHERE stream_id=NEW.id) AND revoked_at IS NULL;
  UPDATE restream_source SET deleted_at=coalesce(deleted_at,now()),encrypted_secret=NULL,state='stopped',updated_at=now() WHERE stream_id=NEW.id AND deleted_at IS NULL;
 END IF; RETURN NEW; END $$;
CREATE TRIGGER restream_owner_retirement AFTER UPDATE OF status ON streaming_stream FOR EACH ROW EXECUTE FUNCTION retire_restream_sources();

ALTER TABLE webhook_event DROP CONSTRAINT webhook_event_type_check;
ALTER TABLE webhook_event ADD CONSTRAINT webhook_event_type_check CHECK(event_type IN ('room.created', 'room.started', 'room.ended', 'participant.joined', 'participant.left', 'participant.reconnected', 'track.published', 'track.unpublished', 'connection.degraded', 'connection.recovered', 'stream.created', 'stream.starting', 'stream.live', 'stream.reconnecting', 'stream.ended', 'stream.failed', 'broadcast.created', 'broadcast.starting', 'broadcast.live', 'broadcast.reconnecting', 'broadcast.output_degraded', 'broadcast.stopped', 'broadcast.failed', 'destination.created', 'destination.connected', 'destination.disconnected', 'destination.retrying', 'destination.failed', 'recording.started', 'recording.segment_committed', 'recording.finalizing', 'recording.ready', 'recording.failed', 'recording.deleted', 'schedule.created','schedule.updated','schedule.starting','schedule.started','schedule.missed','schedule.cancelled','schedule.failed','schedule.completed','schedule.reminder','restream.probing','restream.source_connected','restream.source_lost','restream.recovering','restream.stopped','restream.failed'));
ALTER TABLE webhook_endpoint DROP CONSTRAINT webhook_endpoint_event_types_check;
ALTER TABLE webhook_endpoint ADD CONSTRAINT webhook_endpoint_event_types_check CHECK(cardinality(event_types) BETWEEN 1 AND 49 AND array_position(event_types,NULL) IS NULL AND event_types <@ ARRAY['room.created', 'room.started', 'room.ended', 'participant.joined', 'participant.left', 'participant.reconnected', 'track.published', 'track.unpublished', 'connection.degraded', 'connection.recovered', 'stream.created', 'stream.starting', 'stream.live', 'stream.reconnecting', 'stream.ended', 'stream.failed', 'broadcast.created', 'broadcast.starting', 'broadcast.live', 'broadcast.reconnecting', 'broadcast.output_degraded', 'broadcast.stopped', 'broadcast.failed', 'destination.created', 'destination.connected', 'destination.disconnected', 'destination.retrying', 'destination.failed', 'recording.started', 'recording.segment_committed', 'recording.finalizing', 'recording.ready', 'recording.failed', 'recording.deleted', 'schedule.created','schedule.updated','schedule.starting','schedule.started','schedule.missed','schedule.cancelled','schedule.failed','schedule.completed','schedule.reminder','restream.probing','restream.source_connected','restream.source_lost','restream.recovering','restream.stopped','restream.failed']::text[]);

