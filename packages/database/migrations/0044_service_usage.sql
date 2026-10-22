CREATE TABLE service_usage_activation (
  id text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  retained_from timestamptz
);
INSERT INTO service_usage_activation(id) VALUES ('streaming-v1');

CREATE TABLE service_usage_sample (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  project_id text NOT NULL,
  environment_id text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  stream_id text NOT NULL,
  run_id text NOT NULL,
  actor_key text,
  metrics jsonb NOT NULL,
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision integer NOT NULL DEFAULT 0,
  corrections jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  coverage text NOT NULL,
  CONSTRAINT service_usage_window_check CHECK (ended_at >= started_at),
  CONSTRAINT service_usage_coverage_check CHECK (coverage IN ('observed','estimated','partial','unavailable'))
);
CREATE INDEX service_usage_scope_idx ON service_usage_sample(organization_id, project_id, environment_id, ended_at);
CREATE INDEX service_usage_resource_idx ON service_usage_sample(resource_type, resource_id, ended_at);
CREATE INDEX service_usage_actor_idx ON service_usage_sample(actor_key, ended_at);

CREATE TABLE service_usage_object (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  project_id text NOT NULL,
  environment_id text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  stream_id text NOT NULL,
  size_bytes double precision NOT NULL,
  opened_at timestamptz NOT NULL,
  removed_at timestamptz,
  CONSTRAINT service_usage_object_bytes_check CHECK (size_bytes >= 0)
);
CREATE INDEX service_usage_object_scope_idx ON service_usage_object(organization_id, project_id, environment_id);
CREATE INDEX service_usage_object_owner_idx ON service_usage_object(resource_id, removed_at);
INSERT INTO service_usage_object(id, organization_id, project_id, environment_id, resource_type, resource_id, stream_id, size_bytes, opened_at)
SELECT r.id || ':' || o.name, s.organization_id, r.project_id, r.environment_id,
  CASE WHEN r.kind='buffer' THEN 'dvr' ELSE r.kind END, r.id, r.stream_id, o.size_bytes,
  greatest(o.committed_at, (SELECT started_at FROM service_usage_activation WHERE id='streaming-v1'))
FROM recording_object o JOIN recording r ON r.id=o.recording_id JOIN streaming_stream s ON s.id=r.stream_id WHERE o.committed_at IS NOT NULL;
