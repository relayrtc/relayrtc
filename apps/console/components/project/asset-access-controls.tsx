"use client";

import { useState } from "react";
import { revokeAssetGrantsAction } from "@/actions/recordings";
import { Button } from "@/components/ui/button";

export function AssetAccessControls({
  projectId,
  environmentId,
  assetId,
  onRevoked,
}: {
  projectId: string;
  environmentId: string;
  assetId: string;
  onRevoked(): void;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const revoke = async () => {
    setPending(true);
    setMessage("");
    try {
      const result = await revokeAssetGrantsAction({
        projectId,
        environmentId,
        assetId,
        idempotencyKey: crypto.randomUUID(),
      });
      if (result.error) setMessage(result.error.description);
      else {
        onRevoked();
        setMessage("Existing playback and download links have been revoked.");
      }
    } catch {
      setMessage("Link revocation could not be confirmed. Try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="space-y-2">
      <Button variant="outline" disabled={pending} onClick={() => void revoke()}>
        {pending ? "Revoking links…" : "Revoke existing links"}
      </Button>
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  );
}
