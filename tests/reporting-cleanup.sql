-- Test-only cleanup for the organization IDs supplied in $1.
-- Retained journals intentionally survive owner deletion and must be removed explicitly.
DELETE FROM organization WHERE id=ANY($1::text[]);
--> statement-breakpoint
DELETE FROM usage_lifecycle_event WHERE organization_id=ANY($1::text[]);
--> statement-breakpoint
DELETE FROM media_usage_sample WHERE organization_id=ANY($1::text[]);
--> statement-breakpoint
DELETE FROM service_usage_sample WHERE organization_id=ANY($1::text[]);
--> statement-breakpoint
DELETE FROM service_usage_object WHERE organization_id=ANY($1::text[]);
--> statement-breakpoint
DELETE FROM usage_event WHERE organization_id=ANY($1::text[]);
--> statement-breakpoint
DELETE FROM usage_aggregate WHERE organization_id=ANY($1::text[]);
--> statement-breakpoint
DELETE FROM usage_history_interval WHERE session_id IN (
  SELECT s.id FROM usage_history_session s JOIN usage_history_room r ON r.id=s.room_id
  WHERE r.organization_id=ANY($1::text[])
);
--> statement-breakpoint
DELETE FROM usage_history_session WHERE room_id IN (
  SELECT id FROM usage_history_room WHERE organization_id=ANY($1::text[])
);
--> statement-breakpoint
DELETE FROM usage_history_room WHERE organization_id=ANY($1::text[]);
--> statement-breakpoint
DELETE FROM usage_history_environment WHERE project_id IN (
  SELECT id FROM usage_history_project WHERE organization_id=ANY($1::text[])
);
--> statement-breakpoint
DELETE FROM usage_history_project WHERE organization_id=ANY($1::text[]);
--> statement-breakpoint
DELETE FROM usage_history_organization WHERE id=ANY($1::text[]);
--> statement-breakpoint
DELETE FROM usage_aggregation_dirty WHERE organization_id=ANY($1::text[]);
--> statement-breakpoint
DELETE FROM usage_aggregation_checkpoint WHERE organization_id=ANY($1::text[]);
