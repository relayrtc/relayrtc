"use client";
import { useRouter } from "next/navigation";
import { StreamForm } from "./stream-form";
import { StreamingTaskPage } from "./streaming-task-page";
import { streamWorkspaceHref } from "@/lib/stream-workspace";

export function CreateStreamPage({
  projectId,
  environmentId,
  environmentName,
  base,
}: {
  projectId: string;
  environmentId: string;
  environmentName: string;
  base: string;
}) {
  const router = useRouter();
  return (
    <StreamingTaskPage
      wide
      title="Create a stream"
      backHref={`${base}/streams?environmentId=${encodeURIComponent(environmentId)}`}
      description={`Set up your source and output quality in ${environmentName}. Connect your encoder after creating the stream.`}
    >
      <StreamForm
        projectId={projectId}
        environmentId={environmentId}
        stream={null}
        onSaved={(stream) => router.replace(streamWorkspaceHref(base, stream.id, environmentId))}
      />
    </StreamingTaskPage>
  );
}
