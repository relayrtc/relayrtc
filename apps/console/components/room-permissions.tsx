"use client";

import { roomParticipantPermissions } from "@relayrtc/types";
import { Checkbox } from "@/ui/checkbox";

const labels: Record<string, string> = {
  "room:join": "Join the room",
  "audio:publish": "Publish microphone audio",
  "video:publish": "Publish camera video",
  "screen:publish": "Share a screen",
  "messages:send": "Send messages",
  "metadata:update": "Update participant metadata",
};

export function RoomPermissions({
  value,
  onChange,
}: {
  value: readonly string[];
  onChange: (value: readonly string[]) => void;
}) {
  return (
    <fieldset className="developer-choices">
      <legend className="field-label">Permissions</legend>
      <div className="developer-choice-list">
        {roomParticipantPermissions.map((permission) => (
          <label className="account-checkbox" key={permission}>
            <Checkbox
              checked={value.includes(permission)}
              disabled={permission === "room:join"}
              onChange={(event) => {
                onChange(
                  event.target.checked
                    ? [...value, permission]
                    : value.filter((item) => item !== permission),
                );
              }}
            />
            <span>{labels[permission]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
