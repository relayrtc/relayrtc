"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { StreamChoice } from "./stream-choice";
import { StreamingTaskPage } from "./streaming-task-page";
import { streamWorkspaceHref } from "@/lib/stream-workspace";
export function ChooseStreamPage({
  projectId,
  environmentId,
  base,
  section,
  title,
}: {
  projectId: string;
  environmentId: string;
  base: string;
  section: string;
  title: string;
}) {
  const router = useRouter();
  const [streamId, setStreamId] = useState("");
  return (
    <StreamingTaskPage
      title={title}
      description="Choose a stream to continue. Its environment and broadcast stay selected."
      backHref={`${base}/streams?environmentId=${encodeURIComponent(environmentId)}`}
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (streamId)
            router.push(streamWorkspaceHref(base, streamId, environmentId, `${section}/new`));
        }}
      >
        <Label>Stream</Label>
        <StreamChoice
          projectId={projectId}
          environmentId={environmentId}
          value={streamId}
          onChange={setStreamId}
        />
        <Button type="submit" disabled={!streamId}>
          Continue
        </Button>
      </form>
    </StreamingTaskPage>
  );
}
