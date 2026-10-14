-- Phase 12's shared mutation trigger replaces legacy deletion-only audit writers.
-- Confirm replacement coverage before retiring the old triggers. Keep every
-- ownership guard and all append-only audit protections.
DO $$ DECLARE target_table text; BEGIN
  FOREACH target_table IN ARRAY ARRAY['organization','project','environment','api_key'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = format('public.%I', target_table)::regclass
      AND tgname = 'sensitive_mutation_audit' AND NOT tgisinternal AND tgenabled <> 'D') THEN
      RAISE EXCEPTION 'Shared audit trigger missing on %', target_table;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target_table || '_deletion_audit', target_table);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS audit_resource_deletion();

-- Existing installations also audit account deletion from their owner guard.
-- The shared user/member triggers now record it, so keep this function focused
-- on preventing orphaned organizations, without a second legacy audit INSERT.
CREATE OR REPLACE FUNCTION protect_account_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM organization WHERE id IN (SELECT organization_id FROM member WHERE user_id = OLD.id)
    ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM member WHERE user_id = OLD.id
    AND role ~ '(^|,[[:space:]]*)owner([[:space:]]*,|$)') THEN
    RAISE EXCEPTION 'Transfer organization ownership before deleting your account' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;

-- Cascaded child deletes must retain tenant attribution even after the parent
-- project is gone; the retained usage-history record supplies its organization.
CREATE OR REPLACE FUNCTION audit_sensitive_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF tenant IS NULL THEN
      SELECT organization_id INTO tenant FROM usage_history_project WHERE id = row_data->>'project_id';
    END IF;
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
