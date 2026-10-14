-- Legacy organization audit tables required tenant/resource/request context.
-- Personal and system events legitimately have no tenant, actor ID, resource
-- ID or request ID. Match the shared audit schema without changing records or
-- relaxing the append-only triggers.
ALTER TABLE "audit_event" ALTER COLUMN "organization_id" DROP NOT NULL;
ALTER TABLE "audit_event" ALTER COLUMN "actor_id" DROP NOT NULL;
ALTER TABLE "audit_event" ALTER COLUMN "resource_id" DROP NOT NULL;
ALTER TABLE "audit_event" ALTER COLUMN "correlation_id" DROP NOT NULL;
