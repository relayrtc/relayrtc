CREATE TABLE broadcast_schedule (
 id text PRIMARY KEY,stream_id text NOT NULL REFERENCES streaming_stream(id),broadcast_id text NOT NULL UNIQUE REFERENCES broadcast_run(id),operation_id text NOT NULL,
 organization_id text NOT NULL,project_id text NOT NULL,environment_id text NOT NULL,name text NOT NULL,
 creator_type text NOT NULL CHECK(creator_type IN ('key','user')),creator_id text NOT NULL,
 state text NOT NULL DEFAULT 'scheduled' CHECK(state IN ('scheduled','starting','running','ending','completed','missed','failed','cancelled')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),grant_epoch integer NOT NULL DEFAULT 1,event_sequence integer NOT NULL DEFAULT 0,
 source_deadline timestamptz,starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,time_zone text NOT NULL,
 source_wait_seconds integer NOT NULL CHECK(source_wait_seconds BETWEEN 10 AND 600),catch_up_seconds integer NOT NULL CHECK(catch_up_seconds BETWEEN 0 AND 3600),
 publisher_early_seconds integer NOT NULL CHECK(publisher_early_seconds BETWEEN 0 AND 3600),viewer_early_seconds integer NOT NULL CHECK(viewer_early_seconds BETWEEN 0 AND 86400),viewer_after_seconds integer NOT NULL CHECK(viewer_after_seconds BETWEEN 0 AND 3600),notify_before_seconds integer,
 fence integer NOT NULL DEFAULT 0,attempts integer NOT NULL DEFAULT 0,lease_token text,leased_until timestamptz,next_attempt_at timestamptz NOT NULL DEFAULT now(),last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,ended_at timestamptz,
 UNIQUE(id,stream_id),CHECK(ends_at>starts_at AND ends_at<=starts_at+interval '24 hours'),CHECK((lease_token IS NULL)=(leased_until IS NULL))
);
CREATE INDEX broadcast_schedule_due_idx ON broadcast_schedule(starts_at,next_attempt_at) WHERE state='scheduled';
CREATE INDEX broadcast_schedule_scope_idx ON broadcast_schedule(project_id,environment_id,id);
CREATE TABLE schedule_attempt (
 schedule_id text NOT NULL REFERENCES broadcast_schedule(id),fence integer NOT NULL,lease_token text NOT NULL,
 state text NOT NULL CHECK(state IN ('claimed','started','retry','missed','failed','cancelled','expired')),
 reason text,created_at timestamptz NOT NULL DEFAULT now(),ended_at timestamptz,PRIMARY KEY(schedule_id,fence)
);
CREATE TABLE schedule_operation (
 id text PRIMARY KEY,schedule_id text NOT NULL REFERENCES broadcast_schedule(id),broadcast_id text NOT NULL REFERENCES broadcast_run(id),broadcast_operation_id text REFERENCES streaming_operation(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','failed','cancelled')),error_code text,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz
);
ALTER TABLE broadcast_schedule ADD CONSTRAINT schedule_operation_fk FOREIGN KEY(operation_id) REFERENCES schedule_operation(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE schedule_viewer_grant (
 id text PRIMARY KEY,schedule_id text NOT NULL REFERENCES broadcast_schedule(id),token_hash text NOT NULL,epoch integer NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz
);
CREATE INDEX schedule_grant_expiry_idx ON schedule_viewer_grant(expires_at);
CREATE TABLE schedule_notification (
 id text PRIMARY KEY,schedule_id text NOT NULL REFERENCES broadcast_schedule(id),version integer NOT NULL,due_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','emitted','cancelled')),emitted_at timestamptz,
 UNIQUE(schedule_id,version)
);
CREATE INDEX schedule_notification_due_idx ON schedule_notification(due_at) WHERE state='pending';
ALTER TABLE streaming_ingest_credential ADD COLUMN schedule_id text REFERENCES broadcast_schedule(id),ADD COLUMN not_before timestamptz;
CREATE FUNCTION guard_schedule_parent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND (NEW.stream_id<>OLD.stream_id OR NEW.broadcast_id<>OLD.broadcast_id OR NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id OR NEW.environment_id<>OLD.environment_id OR NEW.creator_id<>OLD.creator_id OR NEW.creator_type<>OLD.creator_type) THEN RAISE EXCEPTION 'Schedule identity is immutable'; END IF;
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM broadcast_run b WHERE b.id=NEW.broadcast_id AND b.stream_id=NEW.stream_id AND b.organization_id=NEW.organization_id AND b.project_id=NEW.project_id AND b.environment_id=NEW.environment_id AND b.state='created') THEN RAISE EXCEPTION 'Invalid schedule parent'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER broadcast_schedule_parent_guard BEFORE INSERT OR UPDATE ON broadcast_schedule FOR EACH ROW EXECUTE FUNCTION guard_schedule_parent();
CREATE FUNCTION retire_owned_schedules() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.status<>'active' AND OLD.status='active' THEN
 UPDATE broadcast_schedule SET state='cancelled',version=version+1,grant_epoch=grant_epoch+1,lease_token=NULL,leased_until=NULL,ended_at=now(),last_error='OWNER_RETIRED' WHERE stream_id=NEW.id AND state IN ('scheduled','starting','running','ending');
 UPDATE streaming_ingest_credential SET revoked_at=now() WHERE schedule_id IN (SELECT id FROM broadcast_schedule WHERE stream_id=NEW.id) AND revoked_at IS NULL;
 UPDATE schedule_operation SET status='cancelled',completed_at=now(),error_code='OWNER_RETIRED' WHERE schedule_id IN (SELECT id FROM broadcast_schedule WHERE stream_id=NEW.id) AND status='pending';
 UPDATE schedule_notification SET state='cancelled' WHERE schedule_id IN (SELECT id FROM broadcast_schedule WHERE stream_id=NEW.id) AND state='pending';
 END IF;RETURN NEW; END $$;
CREATE TRIGGER streaming_schedule_retirement AFTER UPDATE OF status ON streaming_stream FOR EACH ROW EXECUTE FUNCTION retire_owned_schedules();

ALTER TABLE webhook_event DROP CONSTRAINT webhook_event_type_check;
ALTER TABLE webhook_event ADD CONSTRAINT webhook_event_type_check CHECK(event_type IN ('room.created', 'room.started', 'room.ended', 'participant.joined', 'participant.left', 'participant.reconnected', 'track.published', 'track.unpublished', 'connection.degraded', 'connection.recovered', 'stream.created', 'stream.starting', 'stream.live', 'stream.reconnecting', 'stream.ended', 'stream.failed', 'broadcast.created', 'broadcast.starting', 'broadcast.live', 'broadcast.reconnecting', 'broadcast.output_degraded', 'broadcast.stopped', 'broadcast.failed', 'destination.created', 'destination.connected', 'destination.disconnected', 'destination.retrying', 'destination.failed', 'recording.started', 'recording.segment_committed', 'recording.finalizing', 'recording.ready', 'recording.failed', 'recording.deleted', 'schedule.created','schedule.updated','schedule.starting','schedule.started','schedule.missed','schedule.cancelled','schedule.failed','schedule.completed','schedule.reminder'));
ALTER TABLE webhook_endpoint DROP CONSTRAINT webhook_endpoint_event_types_check;
ALTER TABLE webhook_endpoint ADD CONSTRAINT webhook_endpoint_event_types_check CHECK(cardinality(event_types) BETWEEN 1 AND 43 AND array_position(event_types,NULL) IS NULL AND event_types <@ ARRAY['room.created', 'room.started', 'room.ended', 'participant.joined', 'participant.left', 'participant.reconnected', 'track.published', 'track.unpublished', 'connection.degraded', 'connection.recovered', 'stream.created', 'stream.starting', 'stream.live', 'stream.reconnecting', 'stream.ended', 'stream.failed', 'broadcast.created', 'broadcast.starting', 'broadcast.live', 'broadcast.reconnecting', 'broadcast.output_degraded', 'broadcast.stopped', 'broadcast.failed', 'destination.created', 'destination.connected', 'destination.disconnected', 'destination.retrying', 'destination.failed', 'recording.started', 'recording.segment_committed', 'recording.finalizing', 'recording.ready', 'recording.failed', 'recording.deleted', 'schedule.created','schedule.updated','schedule.starting','schedule.started','schedule.missed','schedule.cancelled','schedule.failed','schedule.completed','schedule.reminder']::text[]);

