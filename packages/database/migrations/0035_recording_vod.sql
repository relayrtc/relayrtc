CREATE TABLE stream_recording_policy (
 stream_id text PRIMARY KEY REFERENCES streaming_stream(id), policy jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE recording (
 id text PRIMARY KEY, stream_id text NOT NULL REFERENCES streaming_stream(id), broadcast_id text NOT NULL REFERENCES broadcast_run(id),
 asset_id text NOT NULL UNIQUE, organization_id text NOT NULL, project_id text NOT NULL, environment_id text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','recording','finalizing','ready','failed','deleting','deleted')),
 policy jsonb NOT NULL, partial boolean NOT NULL DEFAULT false, last_error text,
 stop_requested boolean NOT NULL DEFAULT false, fence integer NOT NULL DEFAULT 0 CHECK(fence>=0),
 lease_token text, leased_until timestamptz, worker_id text, attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(), heartbeat_at timestamptz,
 source_session_id text, source_generation integer, source_sequence bigint,
 duration_seconds double precision NOT NULL DEFAULT 0 CHECK(duration_seconds>=0),
 processing_seconds double precision NOT NULL DEFAULT 0 CHECK(processing_seconds>=0),
 stored_bytes bigint NOT NULL DEFAULT 0 CHECK(stored_bytes>=0), storage_byte_seconds double precision NOT NULL DEFAULT 0 CHECK(storage_byte_seconds>=0),
 segment_count integer NOT NULL DEFAULT 0 CHECK(segment_count>=0), grant_epoch integer NOT NULL DEFAULT 1 CHECK(grant_epoch>0), event_sequence integer NOT NULL DEFAULT 0 CHECK(event_sequence>=0),
 codecs jsonb NOT NULL DEFAULT '[]', export_fence integer, mp4_parts integer NOT NULL DEFAULT 0 CHECK(mp4_parts BETWEEN 0 AND 128), has_thumbnail boolean NOT NULL DEFAULT false,
 cleanup_after timestamptz, cleanup_completed boolean NOT NULL DEFAULT false, deletion_requested_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, ended_at timestamptz, expires_at timestamptz,
 UNIQUE(id,stream_id), UNIQUE(asset_id,id),
 CHECK((lease_token IS NULL)=(leased_until IS NULL))
);
CREATE INDEX recording_scope_idx ON recording(project_id,environment_id,id);
CREATE INDEX recording_due_idx ON recording(state,next_attempt_at,leased_until);
CREATE UNIQUE INDEX recording_active_run_idx ON recording(broadcast_id) WHERE state IN ('queued','recording','finalizing');
CREATE FUNCTION validate_recording_parent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND (NEW.stream_id<>OLD.stream_id OR NEW.broadcast_id<>OLD.broadcast_id OR NEW.asset_id<>OLD.asset_id OR NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id OR NEW.environment_id<>OLD.environment_id OR NEW.policy IS DISTINCT FROM OLD.policy) THEN RAISE EXCEPTION 'Recording identity and policy are immutable'; END IF;
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM broadcast_run b JOIN streaming_stream s ON s.id=b.stream_id WHERE b.id=NEW.broadcast_id AND s.id=NEW.stream_id AND s.organization_id=NEW.organization_id AND s.project_id=NEW.project_id AND s.environment_id=NEW.environment_id AND s.status='active' FOR SHARE OF s,b) THEN RAISE EXCEPTION 'Invalid recording ownership'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER recording_parent_guard BEFORE INSERT OR UPDATE ON recording FOR EACH ROW EXECUTE FUNCTION validate_recording_parent();
CREATE TABLE recording_object (
 recording_id text NOT NULL REFERENCES recording(id), name text NOT NULL,
 object_key text NOT NULL UNIQUE, sha256 text NOT NULL CHECK(length(sha256)=64),
 size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 0 AND 16777216), fence integer NOT NULL,
 committed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), metered_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(recording_id,name)
);
CREATE TABLE recording_segment (
 recording_id text NOT NULL REFERENCES recording(id), position integer NOT NULL CHECK(position>=0),
 session_id text NOT NULL, generation integer NOT NULL, sequence bigint NOT NULL,
 name text NOT NULL, init_name text NOT NULL, audio_name text, audio_init_name text, audio_duration_seconds double precision, duration_seconds double precision NOT NULL CHECK(duration_seconds>0 AND duration_seconds<=30),
 program_date_time timestamptz, discontinuity boolean NOT NULL DEFAULT false,
 committed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(recording_id,position),
 UNIQUE(recording_id,session_id,generation,sequence),
 FOREIGN KEY(recording_id,name) REFERENCES recording_object(recording_id,name),
 FOREIGN KEY(recording_id,init_name) REFERENCES recording_object(recording_id,name),
 FOREIGN KEY(recording_id,audio_name) REFERENCES recording_object(recording_id,name),
 FOREIGN KEY(recording_id,audio_init_name) REFERENCES recording_object(recording_id,name),
 CHECK((audio_name IS NULL)=(audio_init_name IS NULL)), CHECK(audio_duration_seconds IS NULL OR audio_duration_seconds>0)
);
CREATE TABLE recording_access_grant (
 id text PRIMARY KEY, recording_id text NOT NULL REFERENCES recording(id), token_hash text NOT NULL,
 action text NOT NULL CHECK(action IN ('playback','download')), epoch integer NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX recording_grant_expiry_idx ON recording_access_grant(expires_at);
CREATE FUNCTION retire_recordings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.status<>'active' AND OLD.status='active' THEN
 UPDATE recording SET state='deleting',deletion_requested_at=now(),stop_requested=true,grant_epoch=grant_epoch+1 WHERE stream_id=NEW.id AND state NOT IN ('deleting','deleted');
 UPDATE recording_access_grant SET revoked_at=now() WHERE recording_id IN (SELECT id FROM recording WHERE stream_id=NEW.id) AND revoked_at IS NULL;
 END IF; RETURN NEW; END $$;
CREATE TRIGGER recording_owner_retirement AFTER UPDATE OF status ON streaming_stream FOR EACH ROW EXECUTE FUNCTION retire_recordings();

ALTER TABLE webhook_event DROP CONSTRAINT webhook_event_type_check;
ALTER TABLE webhook_event ADD CONSTRAINT webhook_event_type_check CHECK(event_type IN ('room.created', 'room.started', 'room.ended', 'participant.joined', 'participant.left', 'participant.reconnected', 'track.published', 'track.unpublished', 'connection.degraded', 'connection.recovered', 'stream.created', 'stream.starting', 'stream.live', 'stream.reconnecting', 'stream.ended', 'stream.failed', 'broadcast.created', 'broadcast.starting', 'broadcast.live', 'broadcast.reconnecting', 'broadcast.output_degraded', 'broadcast.stopped', 'broadcast.failed', 'destination.created', 'destination.connected', 'destination.disconnected', 'destination.retrying', 'destination.failed', 'recording.started', 'recording.segment_committed', 'recording.finalizing', 'recording.ready', 'recording.failed', 'recording.deleted'));
ALTER TABLE webhook_endpoint DROP CONSTRAINT webhook_endpoint_event_types_check;
ALTER TABLE webhook_endpoint ADD CONSTRAINT webhook_endpoint_event_types_check CHECK(cardinality(event_types) BETWEEN 1 AND 34 AND array_position(event_types,NULL) IS NULL AND event_types <@ ARRAY['room.created', 'room.started', 'room.ended', 'participant.joined', 'participant.left', 'participant.reconnected', 'track.published', 'track.unpublished', 'connection.degraded', 'connection.recovered', 'stream.created', 'stream.starting', 'stream.live', 'stream.reconnecting', 'stream.ended', 'stream.failed', 'broadcast.created', 'broadcast.starting', 'broadcast.live', 'broadcast.reconnecting', 'broadcast.output_degraded', 'broadcast.stopped', 'broadcast.failed', 'destination.created', 'destination.connected', 'destination.disconnected', 'destination.retrying', 'destination.failed', 'recording.started', 'recording.segment_committed', 'recording.finalizing', 'recording.ready', 'recording.failed', 'recording.deleted']::text[]);

ALTER TABLE recording ADD COLUMN storage_metered_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX recording_retention_idx ON recording(expires_at) WHERE state NOT IN ('deleted','deleting');
CREATE INDEX recording_cleanup_idx ON recording(cleanup_after) WHERE cleanup_completed=false AND state IN ('ready','failed');
