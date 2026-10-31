CREATE TABLE room_activity_policy (
  room_id text PRIMARY KEY REFERENCES room(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  activity_enabled boolean NOT NULL DEFAULT true,
  speakers_enabled boolean NOT NULL DEFAULT true,
  idle_seconds integer NOT NULL DEFAULT 120 CHECK(idle_seconds BETWEEN 30 AND 3600),
  heartbeat_seconds integer NOT NULL DEFAULT 45 CHECK(heartbeat_seconds BETWEEN 30 AND 120)
);
INSERT INTO room_activity_policy(room_id) SELECT id FROM room;
CREATE TABLE participant_activity (
  participant_id text PRIMARY KEY REFERENCES participant(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'auto' CHECK(mode IN ('auto','away')),
  share_activity boolean NOT NULL DEFAULT true,
  share_speaking boolean NOT NULL DEFAULT true,
  visible boolean NOT NULL DEFAULT true,
  heartbeat_at timestamptz,
  last_input_at timestamptz
);
INSERT INTO participant_activity(participant_id) SELECT id FROM participant;
CREATE TABLE room_speaker_snapshot (
  room_id text PRIMARY KEY REFERENCES room(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  speakers jsonb NOT NULL CHECK(jsonb_typeof(speakers)='array' AND jsonb_array_length(speakers)<=16),
  dominant_session_id text
);
CREATE INDEX room_speaker_snapshot_expiry_idx ON room_speaker_snapshot(observed_at);
CREATE INDEX participant_room_activity_idx ON participant(room_id,id) WHERE left_at IS NULL AND removed_at IS NULL;

CREATE FUNCTION initialize_room_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='room' THEN INSERT INTO room_activity_policy(room_id) VALUES(NEW.id);
  ELSE INSERT INTO participant_activity(participant_id) VALUES(NEW.id); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER room_activity_initialize AFTER INSERT ON room FOR EACH ROW EXECUTE FUNCTION initialize_room_activity();
CREATE TRIGGER participant_activity_initialize AFTER INSERT ON participant FOR EACH ROW EXECUTE FUNCTION initialize_room_activity();

CREATE FUNCTION clear_departed_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.left_at IS NOT NULL OR NEW.removed_at IS NOT NULL THEN
    UPDATE participant_activity SET heartbeat_at=NULL,last_input_at=NULL WHERE participant_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER participant_activity_clear AFTER UPDATE OF left_at,removed_at ON participant FOR EACH ROW EXECUTE FUNCTION clear_departed_activity();

CREATE FUNCTION read_room_activity(room_id_value text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH policy AS (SELECT * FROM room_activity_policy WHERE room_id=room_id_value),
  observed AS (SELECT ss.* FROM room_speaker_snapshot ss JOIN media_room_runtime mr ON mr.room_id=ss.room_id AND mr.node_id=ss.node_id
    JOIN room r ON r.id=ss.room_id WHERE ss.room_id=room_id_value AND ss.observed_at>now()-interval '3 seconds'
    AND ss.observed_at<=now()+interval '1 second' AND r.status='active'),
  members AS (SELECT p.id,a.mode,a.share_activity,a.visible,a.heartbeat_at,a.last_input_at,
    EXISTS(SELECT 1 FROM participant_session s WHERE s.participant_id=p.id AND s.connection_state='connected'
      AND (s.signaling_instance_id IS NULL OR EXISTS(SELECT 1 FROM signaling_node_lease l WHERE l.instance_id=s.signaling_instance_id AND l.node_id=s.signaling_node_id AND l.expires_at>now()))) AS connected
    FROM participant p JOIN room r ON r.id=p.room_id LEFT JOIN participant_activity a ON a.participant_id=p.id WHERE p.room_id=room_id_value AND r.status='active' AND p.left_at IS NULL AND p.removed_at IS NULL
    ORDER BY p.id LIMIT 513),
  public_speakers AS (SELECT DISTINCT ON(p.id) p.id,least(1.0,greatest(0.0,(item->>'level')::numeric)) AS level,
    s.id=observed.dominant_session_id AS dominant
    FROM observed CROSS JOIN LATERAL jsonb_array_elements(observed.speakers) item
    JOIN participant_session s ON s.id=item->>'sessionId'
    JOIN participant p ON p.id=s.participant_id JOIN participant_activity a ON a.participant_id=p.id CROSS JOIN policy
    WHERE p.room_id=room_id_value AND p.left_at IS NULL AND p.removed_at IS NULL AND s.connection_state='connected'
      AND a.share_speaking AND policy.speakers_enabled AND (p.allowed_permissions IS NULL OR 'audio:publish'=ANY(p.allowed_permissions))
      AND observed.observed_at>=coalesce(s.reconnected_at,s.joined_at)
      AND (s.signaling_instance_id IS NULL OR EXISTS(SELECT 1 FROM signaling_node_lease l WHERE l.instance_id=s.signaling_instance_id AND l.node_id=s.signaling_node_id AND l.expires_at>now()))
    ORDER BY p.id,level DESC LIMIT 16)
  SELECT jsonb_build_object('roomId',room_id_value,'observedAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'policy',jsonb_build_object('version',version,'activityEnabled',activity_enabled,'speakersEnabled',speakers_enabled,'idleSeconds',idle_seconds,'heartbeatSeconds',heartbeat_seconds),
    'participants',coalesce((SELECT jsonb_agg(jsonb_build_object('participantId',id,'state',CASE
      WHEN NOT coalesce(share_activity,false) OR NOT policy.activity_enabled THEN 'hidden'
      WHEN NOT connected OR NOT visible OR heartbeat_at IS NULL OR heartbeat_at<now()-make_interval(secs=>policy.heartbeat_seconds) THEN 'unknown'
      WHEN mode='away' THEN 'away'
      WHEN last_input_at IS NULL OR last_input_at<now()-make_interval(secs=>policy.idle_seconds) THEN 'inactive'
      ELSE 'online' END) ORDER BY id) FROM(SELECT * FROM members ORDER BY id LIMIT 512) selected),'[]'::jsonb),
    'truncated',(SELECT count(*)>512 FROM members),
    'speakers',coalesce((SELECT jsonb_agg(jsonb_build_object('participantId',id,'level',level) ORDER BY level DESC,id) FROM public_speakers),'[]'::jsonb),
    'dominantSpeakerId',(SELECT id FROM public_speakers WHERE dominant LIMIT 1),
    'speakerState',CASE WHEN NOT speakers_enabled THEN 'disabled' WHEN EXISTS(SELECT 1 FROM observed) THEN 'available' ELSE 'unavailable' END)
  FROM policy;
$$;

CREATE FUNCTION clear_ended_room_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('ending','ended','failed') THEN
    UPDATE participant_activity SET heartbeat_at=NULL,last_input_at=NULL WHERE participant_id IN(SELECT id FROM participant WHERE room_id=NEW.id);
    DELETE FROM room_speaker_snapshot WHERE room_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER room_activity_clear AFTER UPDATE OF status ON room FOR EACH ROW EXECUTE FUNCTION clear_ended_room_activity();
