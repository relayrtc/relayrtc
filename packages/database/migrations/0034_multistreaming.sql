CREATE TABLE stream_destination (
 id text PRIMARY KEY, stream_id text NOT NULL REFERENCES streaming_stream(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120), host text NOT NULL,
 protocol text NOT NULL CHECK(protocol IN ('rtmp','rtmps')), port integer NOT NULL CHECK(port IN (1935,1936,443)),
 profile text NOT NULL CHECK(profile IN ('remux','720p','1080p')), enabled boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), credential_version integer NOT NULL DEFAULT 1 CHECK(credential_version>0),
 encrypted_secret text, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,stream_id), CHECK(deleted_at IS NOT NULL OR encrypted_secret IS NOT NULL)
);
CREATE FUNCTION validate_stream_destination() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND NEW.stream_id<>OLD.stream_id THEN RAISE EXCEPTION 'Destination stream is immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM streaming_stream WHERE id=NEW.stream_id AND status='active' FOR SHARE) THEN RAISE EXCEPTION 'Destination stream is unavailable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER destination_parent_guard BEFORE INSERT OR UPDATE OF stream_id ON stream_destination FOR EACH ROW EXECUTE FUNCTION validate_stream_destination();
CREATE INDEX stream_destination_scope_idx ON stream_destination(stream_id,id);
ALTER TABLE broadcast_output DROP CONSTRAINT broadcast_output_kind_check;
ALTER TABLE broadcast_output ADD CONSTRAINT broadcast_output_kind_check CHECK(kind IN ('hls','rtmp'));
ALTER TABLE broadcast_job DROP CONSTRAINT broadcast_job_kind_check;
ALTER TABLE broadcast_job ADD CONSTRAINT broadcast_job_kind_check CHECK(kind IN ('hls','rtmp'));
ALTER TABLE broadcast_output ADD COLUMN destination_id text REFERENCES stream_destination(id), ADD COLUMN credential_version integer, ADD COLUMN encrypted_secret text;
ALTER TABLE broadcast_output ADD CONSTRAINT broadcast_output_destination_check CHECK((kind='rtmp')=(destination_id IS NOT NULL));
CREATE UNIQUE INDEX broadcast_output_destination_unique ON broadcast_output(broadcast_id,destination_id) WHERE destination_id IS NOT NULL;
CREATE FUNCTION validate_destination_output() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.kind='rtmp' AND (NEW.encrypted_secret IS NULL OR NEW.credential_version IS NULL) THEN RAISE EXCEPTION 'Missing destination credential snapshot'; END IF;
 IF TG_OP='UPDATE' AND NEW.encrypted_secret IS DISTINCT FROM OLD.encrypted_secret AND NOT (NEW.encrypted_secret IS NULL AND EXISTS(SELECT 1 FROM broadcast_run WHERE id=NEW.broadcast_id AND state IN ('stopped','failed'))) THEN RAISE EXCEPTION 'Output credentials are immutable until terminal cleanup'; END IF;
 IF NEW.destination_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM stream_destination d JOIN broadcast_run b ON b.stream_id=d.stream_id WHERE d.id=NEW.destination_id AND b.id=NEW.broadcast_id) THEN RAISE EXCEPTION 'Invalid destination scope'; END IF;
 IF TG_OP='UPDATE' AND (NEW.configuration IS DISTINCT FROM OLD.configuration OR NEW.destination_id IS DISTINCT FROM OLD.destination_id OR NEW.credential_version IS DISTINCT FROM OLD.credential_version OR NEW.broadcast_id<>OLD.broadcast_id OR NEW.kind<>OLD.kind) THEN RAISE EXCEPTION 'Output snapshot is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER destination_output_guard BEFORE INSERT OR UPDATE ON broadcast_output FOR EACH ROW EXECUTE FUNCTION validate_destination_output();
ALTER TABLE broadcast_run ADD COLUMN run_seconds double precision NOT NULL DEFAULT 0 CHECK(run_seconds>=0), ADD COLUMN egress_bytes double precision NOT NULL DEFAULT 0 CHECK(egress_bytes>=0), ADD COLUMN transcode_seconds double precision NOT NULL DEFAULT 0 CHECK(transcode_seconds>=0);
UPDATE broadcast_run SET run_seconds=output_seconds;
ALTER TABLE broadcast_job ADD COLUMN egress_bytes double precision NOT NULL DEFAULT 0 CHECK(egress_bytes>=0), ADD COLUMN observed_bytes double precision NOT NULL DEFAULT 0 CHECK(observed_bytes>=0), ADD COLUMN bitrate double precision NOT NULL DEFAULT 0 CHECK(bitrate>=0), ADD COLUMN dropped_frames double precision NOT NULL DEFAULT 0 CHECK(dropped_frames>=0), ADD COLUMN observed_dropped double precision NOT NULL DEFAULT 0 CHECK(observed_dropped>=0), ADD COLUMN output_seconds double precision NOT NULL DEFAULT 0 CHECK(output_seconds>=0), ADD COLUMN transcode_seconds double precision NOT NULL DEFAULT 0 CHECK(transcode_seconds>=0);
ALTER TABLE broadcast_usage_sample ADD COLUMN egress_bytes double precision NOT NULL DEFAULT 0 CHECK(egress_bytes>=0), ADD COLUMN transcode_seconds double precision NOT NULL DEFAULT 0 CHECK(transcode_seconds>=0);
-- A stopped run no longer needs recoverable platform credentials; accounting remains.
CREATE FUNCTION purge_destination_run_secrets() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state IN ('stopped','failed') THEN UPDATE broadcast_output SET encrypted_secret=NULL WHERE broadcast_id=NEW.id; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER destination_run_secret_cleanup AFTER UPDATE OF state ON broadcast_run FOR EACH ROW EXECUTE FUNCTION purge_destination_run_secrets();
CREATE FUNCTION retire_stream_destinations() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.status<>'active' THEN UPDATE stream_destination SET deleted_at=coalesce(deleted_at,now()),enabled=false,encrypted_secret=NULL WHERE stream_id=NEW.id; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER destination_stream_cleanup AFTER UPDATE OF status ON streaming_stream FOR EACH ROW EXECUTE FUNCTION retire_stream_destinations();

ALTER TABLE webhook_event DROP CONSTRAINT webhook_event_type_check;
ALTER TABLE webhook_event ADD CONSTRAINT webhook_event_type_check CHECK(event_type IN ('room.created', 'room.started', 'room.ended', 'participant.joined', 'participant.left', 'participant.reconnected', 'track.published', 'track.unpublished', 'connection.degraded', 'connection.recovered', 'stream.created', 'stream.starting', 'stream.live', 'stream.reconnecting', 'stream.ended', 'stream.failed', 'broadcast.created', 'broadcast.starting', 'broadcast.live', 'broadcast.reconnecting', 'broadcast.output_degraded', 'broadcast.stopped', 'broadcast.failed', 'destination.created', 'destination.connected', 'destination.disconnected', 'destination.retrying', 'destination.failed'));
ALTER TABLE webhook_endpoint DROP CONSTRAINT webhook_endpoint_event_types_check;
ALTER TABLE webhook_endpoint ADD CONSTRAINT webhook_endpoint_event_types_check CHECK(cardinality(event_types) BETWEEN 1 AND 28 AND array_position(event_types,NULL) IS NULL AND event_types <@ ARRAY['room.created', 'room.started', 'room.ended', 'participant.joined', 'participant.left', 'participant.reconnected', 'track.published', 'track.unpublished', 'connection.degraded', 'connection.recovered', 'stream.created', 'stream.starting', 'stream.live', 'stream.reconnecting', 'stream.ended', 'stream.failed', 'broadcast.created', 'broadcast.starting', 'broadcast.live', 'broadcast.reconnecting', 'broadcast.output_degraded', 'broadcast.stopped', 'broadcast.failed', 'destination.created', 'destination.connected', 'destination.disconnected', 'destination.retrying', 'destination.failed']::text[]);
ALTER TABLE broadcast_job ADD COLUMN manual_retries integer NOT NULL DEFAULT 0 CHECK(manual_retries BETWEEN 0 AND 5);
ALTER TABLE streaming_operation ADD COLUMN output_id text REFERENCES broadcast_output(id);
ALTER TABLE streaming_operation DROP CONSTRAINT streaming_operation_kind_check;
ALTER TABLE streaming_operation DROP CONSTRAINT streaming_operation_broadcast_kind_check;
ALTER TABLE streaming_operation ADD CONSTRAINT streaming_operation_kind_check CHECK(kind IN ('start','stop','delete','broadcast.start','broadcast.stop','broadcast.output.retry'));
ALTER TABLE streaming_operation ADD CONSTRAINT streaming_operation_broadcast_kind_check CHECK((broadcast_id IS NOT NULL)=(kind IN ('broadcast.start','broadcast.stop','broadcast.output.retry')));
ALTER TABLE streaming_operation ADD CONSTRAINT streaming_operation_output_check CHECK((output_id IS NOT NULL)=(kind='broadcast.output.retry'));
ALTER TABLE streaming_operation ADD CONSTRAINT streaming_operation_output_fk FOREIGN KEY(output_id,broadcast_id) REFERENCES broadcast_output(id,broadcast_id);
