ALTER TABLE "user" ADD COLUMN "two_factor_enabled" boolean NOT NULL DEFAULT false;
CREATE TABLE "two_factor" (
  "id" text PRIMARY KEY, "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "secret" text NOT NULL, "backup_codes" text NOT NULL, "verified" boolean NOT NULL DEFAULT false,
  "failed_verification_count" integer NOT NULL DEFAULT 0, "locked_until" timestamptz
);
CREATE INDEX "two_factor_user_idx" ON "two_factor"("user_id");
CREATE TABLE "account_request_limit" (
  "key" text PRIMARY KEY, "count" integer NOT NULL, "expires_at" timestamptz NOT NULL
);
CREATE TABLE "account_email_outbox" (
  "id" text PRIMARY KEY, "payload" text, "subject_user_id" text, "attempts" integer NOT NULL DEFAULT 0,
  "available_at" timestamptz NOT NULL DEFAULT now(), "expires_at" timestamptz NOT NULL,
  "delivered_at" timestamptz
);
CREATE INDEX "account_email_delivery_idx" ON "account_email_outbox"("available_at") WHERE "payload" IS NOT NULL;
ALTER TABLE "api_key" ALTER COLUMN "created_by" DROP NOT NULL;
ALTER TABLE "api_key" DROP CONSTRAINT "api_key_created_by_user_id_fk";
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_created_by_user_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS "audit_event" (
  "id" text PRIMARY KEY, "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "actor_type" text NOT NULL CHECK ("actor_type" IN ('USER','SYSTEM','API_KEY','ANONYMOUS')),
  "actor_id" text, "actor_name" text NOT NULL, "subject_user_id" text, "organization_id" text,
  "resource_type" text NOT NULL, "resource_id" text, "action" text NOT NULL,
  "outcome" text NOT NULL CHECK ("outcome" IN ('SUCCESS','FAILURE','ATTEMPT')),
  "correlation_id" text, "metadata" jsonb NOT NULL DEFAULT '{}'
);
-- Earlier installations already have a smaller audit table. Upgrade it in
-- place rather than discarding records or modifying the migration ledger.
DROP TRIGGER IF EXISTS audit_event_immutable ON audit_event;
ALTER TABLE audit_event DROP CONSTRAINT IF EXISTS audit_event_outcome_check;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'audit_event' AND column_name = 'created_at')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'audit_event' AND column_name = 'occurred_at') THEN
    ALTER TABLE audit_event RENAME COLUMN created_at TO occurred_at;
  END IF;
END $$;
ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS actor_type text;
ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS actor_name text;
ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS subject_user_id text;
ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';
UPDATE audit_event SET
  actor_type = coalesce(actor_type, CASE WHEN actor_id IS NULL THEN 'ANONYMOUS' ELSE 'USER' END),
  actor_name = coalesce(actor_name, (SELECT name FROM "user" WHERE id = actor_id),
    CASE WHEN actor_id IS NULL THEN 'Legacy actor unavailable' ELSE 'Legacy user' END),
  subject_user_id = coalesce(subject_user_id, CASE WHEN resource_type = 'user' THEN resource_id
    WHEN resource_type = 'account' AND organization_id IS NULL THEN coalesce(actor_id,
      (SELECT id FROM "user" WHERE id = resource_id)) END),
  outcome = CASE outcome WHEN 'attempted' THEN 'ATTEMPT' WHEN 'succeeded' THEN 'SUCCESS' WHEN 'failed' THEN 'FAILURE' ELSE outcome END
WHERE actor_type IS NULL OR actor_name IS NULL OR outcome IN ('attempted', 'succeeded', 'failed');
ALTER TABLE audit_event ALTER COLUMN actor_type SET NOT NULL;
ALTER TABLE audit_event ALTER COLUMN actor_name SET NOT NULL;
ALTER TABLE audit_event ADD CONSTRAINT audit_event_outcome_check CHECK (outcome IN ('SUCCESS', 'FAILURE', 'ATTEMPT'));
-- A newly created table already has this check; the legacy table does not.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'audit_event'::regclass AND conname = 'audit_event_actor_type_check') THEN
    ALTER TABLE audit_event ADD CONSTRAINT audit_event_actor_type_check CHECK (actor_type IN ('USER', 'SYSTEM', 'API_KEY', 'ANONYMOUS'));
  END IF;
END $$;
CREATE INDEX "audit_personal_idx" ON "audit_event"("subject_user_id", "occurred_at", "id");
CREATE INDEX "audit_organization_idx" ON "audit_event"("organization_id", "occurred_at", "id");
CREATE INDEX "audit_retention_idx" ON "audit_event"("occurred_at");

-- Updates are always forbidden. Deletion is limited to the configured retention
-- cutoff via the maintenance function; no user-facing mutation endpoint exists.
CREATE OR REPLACE FUNCTION protect_audit_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'AUDIT_RECORD_IMMUTABLE'; END IF;
  IF TG_OP = 'DELETE' AND current_setting('relayrtc.audit_retention', true) = 'on'
     AND OLD.occurred_at < now() - interval '365 days' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'AUDIT_RECORD_IMMUTABLE';
END $$;
CREATE TRIGGER audit_event_immutable BEFORE UPDATE OR DELETE ON audit_event
FOR EACH ROW EXECUTE FUNCTION protect_audit_event();
DROP TRIGGER IF EXISTS audit_event_no_truncate ON audit_event;
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_event
FOR EACH STATEMENT EXECUTE FUNCTION protect_audit_event();
CREATE FUNCTION expire_account_security_history() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('relayrtc.audit_retention', 'on', true);
  DELETE FROM audit_event WHERE id IN (
    SELECT id FROM audit_event WHERE occurred_at < now() - interval '365 days' LIMIT 1000
  );
  PERFORM set_config('relayrtc.audit_retention', 'off', true);
  DELETE FROM account_request_limit WHERE expires_at < now() - interval '1 day';
  DELETE FROM verification WHERE expires_at < now() - interval '1 day';
END $$;

-- Successful changes are audited in the same transaction as the mutation.
-- Never serialize whole rows: user/account/session/key rows contain credentials.
CREATE FUNCTION audit_sensitive_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_data jsonb; prior_data jsonb; tenant text; subject_id text; actor_id_value text;
  actor_type_value text; actor_name_value text; action_value text;
  safe_metadata jsonb := '{}'::jsonb;
BEGIN
  row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  prior_data := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'session' THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME = 'two_factor' AND row_data->>'verified' IS NOT DISTINCT FROM prior_data->>'verified'
      AND row_data->>'backup_codes' IS NOT DISTINCT FROM prior_data->>'backup_codes' THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME = 'api_key' AND (row_data - 'last_used_at') = (prior_data - 'last_used_at') THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME = 'runtime_operation' AND row_data->>'status' IS NOT DISTINCT FROM prior_data->>'status' THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME = 'user' AND (row_data - 'updated_at') = (prior_data - 'updated_at') THEN RETURN NEW; END IF;
  END IF;
  tenant := row_data->>'organization_id';
  IF TG_TABLE_NAME = 'organization' THEN tenant := row_data->>'id'; END IF;
  IF tenant IS NULL AND row_data ? 'project_id' THEN
    SELECT organization_id INTO tenant FROM project WHERE id = row_data->>'project_id';
  END IF;
  subject_id := CASE WHEN TG_TABLE_NAME = 'user' THEN row_data->>'id'
    WHEN TG_TABLE_NAME IN ('account', 'session', 'two_factor') THEN row_data->>'user_id' ELSE NULL END;
  actor_type_value := coalesce(nullif(current_setting('relayrtc.audit_actor_type', true), ''), 'SYSTEM');
  actor_id_value := nullif(current_setting('relayrtc.audit_actor_id', true), '');
  actor_name_value := coalesce(nullif(current_setting('relayrtc.audit_actor_name', true), ''), 'Database lifecycle');
  IF actor_type_value = 'SYSTEM' AND TG_TABLE_NAME = 'runtime_operation' THEN
    actor_name_value := 'Runtime operation worker';
  END IF;
  -- Successful session issuance is attributable to the authenticated subject.
  IF actor_type_value = 'ANONYMOUS' AND TG_TABLE_NAME = 'session' AND TG_OP = 'INSERT' THEN
    actor_type_value := 'USER'; actor_id_value := subject_id;
    SELECT name INTO actor_name_value FROM "user" WHERE id = subject_id;
  END IF;
  action_value := TG_TABLE_NAME || '.' || lower(TG_OP);
  IF TG_TABLE_NAME IN ('organization','project','environment','api_key','room') THEN
    safe_metadata := jsonb_strip_nulls(jsonb_build_object('name', row_data->>'name', 'status', row_data->>'status'));
  ELSIF TG_TABLE_NAME = 'member' THEN
    safe_metadata := jsonb_strip_nulls(jsonb_build_object('previousRole', prior_data->>'role', 'role', row_data->>'role'));
  ELSIF TG_TABLE_NAME = 'runtime_operation' THEN
    safe_metadata := jsonb_strip_nulls(jsonb_build_object('kind', row_data->>'kind', 'status', row_data->>'status',
      'initiatedBy', row_data->'payload'->>'requestedBy'));
  END IF;
  IF TG_TABLE_NAME = 'user' AND TG_OP = 'UPDATE' THEN
    action_value := CASE WHEN row_data->>'email' IS DISTINCT FROM prior_data->>'email' THEN 'account.email_changed'
      WHEN row_data->>'two_factor_enabled' IS DISTINCT FROM prior_data->>'two_factor_enabled' THEN 'account.mfa_changed'
      WHEN row_data->>'email_verified' IS DISTINCT FROM prior_data->>'email_verified' THEN 'account.email_verified'
      ELSE 'account.profile_updated' END;
  END IF;
  INSERT INTO audit_event(id, actor_type, actor_id, actor_name, subject_user_id,
    organization_id, resource_type, resource_id, action, outcome, correlation_id, metadata)
  VALUES (gen_random_uuid()::text, actor_type_value, actor_id_value, coalesce(actor_name_value, 'User'),
    subject_id, tenant, TG_TABLE_NAME, row_data->>'id', action_value, 'SUCCESS',
    nullif(current_setting('relayrtc.audit_correlation_id', true), ''), safe_metadata);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['user','account','session','two_factor','organization','member','invitation',
    'api_key','project','environment','room','runtime_operation','webhook_endpoint'] LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format('CREATE TRIGGER sensitive_mutation_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_sensitive_mutation()', table_name);
    END IF;
  END LOOP;
END $$;

-- Lock the same organization rows as ownership transfer. The existing deferred
-- owner trigger is a second line of defense against concurrent orphaning.
CREATE FUNCTION protect_account_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM organization o JOIN member m ON m.organization_id = o.id
    WHERE m.user_id = OLD.id ORDER BY o.id FOR UPDATE OF o;
  IF EXISTS (SELECT 1 FROM member WHERE user_id = OLD.id
    AND role ~ '(^|,[[:space:]]*)owner([[:space:]]*,|$)') THEN
    RAISE EXCEPTION 'ACCOUNT_OWNS_ORGANIZATION_TRANSFER_REQUIRED';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER account_deletion_ownership BEFORE DELETE ON "user"
FOR EACH ROW EXECUTE FUNCTION protect_account_deletion();

CREATE FUNCTION protect_last_login_method() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('relayrtc.account_deletion', true) IS DISTINCT FROM 'on'
    AND EXISTS (SELECT 1 FROM "user" WHERE id = OLD.user_id) THEN
    PERFORM 1 FROM "user" WHERE id = OLD.user_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM account WHERE user_id = OLD.user_id AND id <> OLD.id
      AND (provider_id <> 'credential' OR password IS NOT NULL)) THEN
      RAISE EXCEPTION 'LAST_LOGIN_METHOD';
    END IF;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER account_last_login_method BEFORE DELETE ON account
FOR EACH ROW EXECUTE FUNCTION protect_last_login_method();
