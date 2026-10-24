"use client";

import { Select } from "@/ui/select";

import { useEffect, useState } from "react";
import type { Page, Stream } from "@/lib/stream-types";
import { useStreams } from "./streams-provider";
import { useWorkspaceResource } from "./use-workspace-resource";
import { Field, FormFeedback } from "@/ui/auth-fields";
import { Button } from "@/ui/button";

export function StreamPicker({ value, onChange, exclude }: { value: string; onChange: (id: string) => void; exclude?: string }) {
  const state = useStreams();
  const [cursor, setCursor] = useState(""), [options, setOptions] = useState<Stream[]>([]);
  const resource = useWorkspaceResource<Page<Stream>>(state.path("streams", { limit: "100", ...(cursor ? { cursor } : {}) }));
  useEffect(() => { if (resource.data) setOptions(current => [...new Map([...current, ...resource.data!.data].map(item => [item.id, item])).values()]); }, [resource.data]);
  return <><Field label="Stream"><Select className="input" value={value} onChange={event => onChange(event.target.value)} required><option value="">Choose a stream</option>{options.filter(item => item.status === "active" && item.id !== exclude).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field><FormFeedback error={resource.error} />{resource.error && <Button type="button" onClick={() => void resource.refresh().catch(() => {})}>Reload streams</Button>}{resource.data?.nextCursor && <Button type="button" disabled={resource.loading} onClick={() => setCursor(resource.data!.nextCursor!)}>Load more streams</Button>}</>;
}
