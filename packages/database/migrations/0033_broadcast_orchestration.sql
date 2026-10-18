CREATE TABLE broadcast_run (
 id text PRIMARY KEY, stream_id text NOT NULL REFERENCES streaming_stream(id),
 organization_id text NOT NULL, project_id text NOT NULL, environment_id text NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 state text NOT NULL DEFAULT 'created' CHECK(state IN ('created','waiting_for_source','starting','live','reconnecting','degraded','stopping','stopped','failed')),
 desired_state text NOT NULL DEFAULT 'idle' CHECK(desired_state IN ('idle','running','stopped')),
 terminal_state text NOT NULL DEFAULT 'stopped' CHECK(terminal_state IN ('stopped','failed')),
 output_seconds double precision NOT NULL DEFAULT 0 CHECK(output_seconds>=0), reservation_seconds double precision NOT NULL DEFAULT 0 CHECK(reservation_seconds>=0),
 usage_samples integer NOT NULL DEFAULT 0 CHECK(usage_samples>=0), partial_samples integer NOT NULL DEFAULT 0 CHECK(partial_samples>=0),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 source_session_id text REFERENCES streaming_session(id), source_generation integer CHECK(source_generation>=0),
 wait_timeout_seconds integer NOT NULL CHECK(wait_timeout_seconds BETWEEN 10 AND 600),
 max_duration_seconds integer NOT NULL CHECK(max_duration_seconds BETWEEN 60 AND 86400),
 last_error text, correlation_id text, created_at timestamptz NOT NULL DEFAULT now(),
 start_requested_at timestamptz, started_at timestamptz, source_lost_at timestamptz, ended_at timestamptz,
 CONSTRAINT broadcast_run_source_identity UNIQUE(id,stream_id), CHECK((source_session_id IS NULL)=(source_generation IS NULL))
);
CREATE INDEX broadcast_run_scope_idx ON broadcast_run(project_id,environment_id,id);
CREATE INDEX broadcast_run_active_idx ON broadcast_run(state) WHERE state NOT IN ('stopped','failed');
CREATE TABLE broadcast_output (
 id text PRIMARY KEY, broadcast_id text NOT NULL REFERENCES broadcast_run(id),
 kind text NOT NULL CHECK(kind='hls'), configuration jsonb NOT NULL CHECK(jsonb_typeof(configuration)='object'),
 UNIQUE(id,broadcast_id)
);
CREATE TABLE broadcast_job (
 id text PRIMARY KEY, broadcast_id text NOT NULL REFERENCES broadcast_run(id), output_id text NOT NULL UNIQUE,
 kind text NOT NULL CHECK(kind='hls'), state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','retry','stopping','completed','failed','cancelled')),
 desired_state text NOT NULL DEFAULT 'running' CHECK(desired_state IN ('running','restart','cancelled')),
 fence integer NOT NULL DEFAULT 0 CHECK(fence>=0), attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 worker_id text, lease_token text, leased_until timestamptz, available_at timestamptz NOT NULL DEFAULT now(),
 last_heartbeat_at timestamptz, sample_sequence integer NOT NULL DEFAULT 0, observed_live integer NOT NULL DEFAULT 0 CHECK(observed_live IN (0,1)),
 last_error text, source_session_id text REFERENCES streaming_session(id), source_generation integer CHECK(source_generation>=0),
 CHECK((source_session_id IS NULL)=(source_generation IS NULL)),
 FOREIGN KEY(output_id,broadcast_id) REFERENCES broadcast_output(id,broadcast_id)
);
CREATE INDEX broadcast_job_claim_idx ON broadcast_job(available_at,leased_until);
CREATE TABLE broadcast_attempt (
 job_id text NOT NULL REFERENCES broadcast_job(id), fence integer NOT NULL, worker_id text NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz, outcome text, PRIMARY KEY(job_id,fence)
);
CREATE TABLE broadcast_reservation (
 job_id text PRIMARY KEY REFERENCES broadcast_job(id), fence integer NOT NULL, worker_id text NOT NULL, expires_at timestamptz NOT NULL,
 FOREIGN KEY(job_id,fence) REFERENCES broadcast_attempt(job_id,fence)
);
CREATE TABLE broadcast_usage_sample (
 job_id text NOT NULL REFERENCES broadcast_job(id), fence integer NOT NULL, sequence integer NOT NULL,
 broadcast_id text NOT NULL REFERENCES broadcast_run(id), organization_id text NOT NULL, project_id text NOT NULL, environment_id text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now(), output_seconds double precision NOT NULL CHECK(output_seconds>=0),
 reservation_seconds double precision NOT NULL CHECK(reservation_seconds>=0), coverage text NOT NULL CHECK(coverage IN ('observed','partial')),
 PRIMARY KEY(job_id,fence,sequence)
);
CREATE INDEX broadcast_usage_scope_idx ON broadcast_usage_sample(project_id,environment_id,occurred_at);
CREATE INDEX broadcast_usage_run_idx ON broadcast_usage_sample(broadcast_id,occurred_at);
ALTER TABLE streaming_operation ADD COLUMN broadcast_id text REFERENCES broadcast_run(id);
ALTER TABLE streaming_operation ADD CONSTRAINT streaming_operation_broadcast_source_fk FOREIGN KEY(broadcast_id,stream_id) REFERENCES broadcast_run(id,stream_id);
ALTER TABLE streaming_operation DROP CONSTRAINT streaming_operation_kind_check;
ALTER TABLE streaming_operation ADD CONSTRAINT streaming_operation_kind_check CHECK(kind IN ('start','stop','delete','broadcast.start','broadcast.stop'));
ALTER TABLE streaming_operation ADD CONSTRAINT streaming_operation_broadcast_kind_check CHECK(
 (broadcast_id IS NOT NULL) = (kind IN ('broadcast.start','broadcast.stop'))
);
CREATE FUNCTION validate_broadcast_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.stream_id<>OLD.stream_id OR NEW.organization_id<>OLD.organization_id OR NEW.project_id<>OLD.project_id OR NEW.environment_id<>OLD.environment_id OR NEW.snapshot IS DISTINCT FROM OLD.snapshot) THEN RAISE EXCEPTION 'Broadcast scope and snapshot are immutable'; END IF;
 IF TG_OP='UPDATE' AND NEW.state<>OLD.state AND NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Broadcast state requires the next version'; END IF;
 IF NOT EXISTS (SELECT 1 FROM streaming_stream WHERE id=NEW.stream_id AND organization_id=NEW.organization_id
 AND project_id=NEW.project_id AND environment_id=NEW.environment_id) THEN RAISE EXCEPTION 'Invalid broadcast scope'; END IF;
 IF NEW.source_session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM streaming_session WHERE id=NEW.source_session_id AND stream_id=NEW.stream_id) THEN RAISE EXCEPTION 'Invalid broadcast source'; END IF;
 IF TG_OP='UPDATE' AND OLD.state<>NEW.state AND NOT (
   (OLD.state='created' AND NEW.state IN ('waiting_for_source','starting','stopping','stopped','failed')) OR
   (OLD.state='waiting_for_source' AND NEW.state IN ('starting','stopping','failed')) OR
   (OLD.state IN ('starting','live','reconnecting','degraded') AND NEW.state IN ('starting','live','reconnecting','degraded','stopping','failed')) OR
   (OLD.state='stopping' AND NEW.state IN ('stopped','failed'))
 ) THEN RAISE EXCEPTION 'Illegal broadcast transition'; END IF;
 IF NEW.state IN ('stopped','failed') AND NEW.desired_state<>'stopped' THEN RAISE EXCEPTION 'Terminal broadcast cannot run'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER broadcast_validate BEFORE INSERT OR UPDATE ON broadcast_run FOR EACH ROW EXECUTE FUNCTION validate_broadcast_run();
CREATE FUNCTION stop_stream_broadcasts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status<>'active' THEN
   UPDATE broadcast_run SET desired_state='stopped', terminal_state='stopped', last_error='SOURCE_RETIRED'
   WHERE stream_id=NEW.id AND state NOT IN ('stopped','failed');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER broadcast_stream_retirement AFTER UPDATE OF status ON streaming_stream FOR EACH ROW EXECUTE FUNCTION stop_stream_broadcasts();
CREATE FUNCTION stop_broadcast_source_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.desired_state='stopped' AND OLD.desired_state<>'stopped' THEN
   UPDATE broadcast_run SET desired_state='stopped',terminal_state=CASE WHEN NEW.state='failed' THEN 'failed' ELSE 'stopped' END,
     last_error=CASE WHEN NEW.state='failed' THEN 'SOURCE_FAILED' ELSE 'SOURCE_STOPPED' END
   WHERE stream_id=NEW.stream_id AND desired_state='running' AND state NOT IN ('stopped','failed');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER broadcast_source_stop AFTER UPDATE OF desired_state ON streaming_session FOR EACH ROW EXECUTE FUNCTION stop_broadcast_source_session();
DO $$ DECLARE item record;
BEGIN
 FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='webhook_endpoint'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%event_types%' LOOP EXECUTE format('ALTER TABLE webhook_endpoint DROP CONSTRAINT %I',item.conname); END LOOP;
 FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='webhook_event'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%event_type%' LOOP EXECUTE format('ALTER TABLE webhook_event DROP CONSTRAINT %I',item.conname); END LOOP;
END $$;
ALTER TABLE webhook_endpoint ADD CONSTRAINT webhook_endpoint_event_types_check CHECK(cardinality(event_types) BETWEEN 1 AND 23 AND array_position(event_types,NULL) IS NULL AND event_types <@ ARRAY['room.created','room.started','room.ended','participant.joined','participant.left','participant.reconnected','track.published','track.unpublished','connection.degraded','connection.recovered','stream.created','stream.starting','stream.live','stream.reconnecting','stream.ended','stream.failed','broadcast.created','broadcast.starting','broadcast.live','broadcast.reconnecting','broadcast.output_degraded','broadcast.stopped','broadcast.failed']::text[]);
ALTER TABLE webhook_event ADD CONSTRAINT webhook_event_type_check CHECK(event_type IN ('room.created','room.started','room.ended','participant.joined','participant.left','participant.reconnected','track.published','track.unpublished','connection.degraded','connection.recovered','stream.created','stream.starting','stream.live','stream.reconnecting','stream.ended','stream.failed','broadcast.created','broadcast.starting','broadcast.live','broadcast.reconnecting','broadcast.output_degraded','broadcast.stopped','broadcast.failed'));

