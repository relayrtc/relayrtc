CREATE INDEX broadcast_run_stream_recent_idx ON broadcast_run(project_id,environment_id,stream_id,created_at DESC,id DESC);
CREATE INDEX broadcast_run_stream_active_idx ON broadcast_run(project_id,environment_id,stream_id,created_at DESC,id DESC) WHERE desired_state='running' AND state NOT IN ('stopping','stopped','failed');
