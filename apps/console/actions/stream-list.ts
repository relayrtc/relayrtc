"use server";

import { z } from "zod";
import { streamScopeSchema, streamingIdSchema } from "@relayrtc/validation";
import { listBroadcastsAction } from "./broadcasts";
import { listSchedulesAction } from "./schedules";
import { streamListActivity, type StreamListActivity } from "@/lib/streaming/stream-list";
import type { StreamingResult } from "@/lib/streaming/contracts";

/** Resolve list statuses in bulk, including activity beyond the first API page. */
export async function getStreamListActivityAction(
  input: unknown,
): Promise<StreamingResult<Record<string, StreamListActivity>>> {
  const parsed = streamScopeSchema
    .required()
    .extend({
      streamIds: z.array(streamingIdSchema).max(100),
    })
    .safeParse(input);
  if (!parsed.success)
    return {
      data: null,
      error: { code: "INVALID_STREAM_INPUT", description: "Choose a valid stream environment." },
    };
  const { projectId, environmentId, streamIds } = parsed.data;
  if (!streamIds.length) return { data: {}, error: null };
  try {
    async function collect<T>(
      list: (cursor?: string) => Promise<StreamingResult<{ data: T[]; nextCursor: string | null }>>,
    ): Promise<T[]> {
      const rows: T[] = [];
      let cursor: string | undefined;
      do {
        const result = await list(cursor);
        if (result.error) throw new Error(result.error.description);
        rows.push(...result.data.data);
        cursor = result.data.nextCursor ?? undefined;
      } while (cursor);
      return rows;
    }
    const [broadcasts, schedules] = await Promise.all([
      collect((cursor) => listBroadcastsAction({ projectId, environmentId, cursor })),
      collect((cursor) => listSchedulesAction({ projectId, environmentId, cursor })),
    ]);
    return {
      data: Object.fromEntries(
        streamIds.map((id) => [id, streamListActivity(id, broadcasts, schedules)]),
      ),
      error: null,
    };
  } catch {
    return {
      data: null,
      error: {
        code: "STREAM_STATUS_UNAVAILABLE",
        description: "Broadcast status is unavailable. Refresh to try again.",
      },
    };
  }
}
