import "server-only";
import { isDeepStrictEqual } from "node:util";
import { schema, type RelayKitDatabase } from "@relayrtc/database";
import { setUserAuditContext } from "@relayrtc/auth";
import { roomSchema } from "@relayrtc/validation";
import { and, desc, eq, lt, or } from "drizzle-orm";
import type { z } from "zod";
import { canManageProjects } from "@/lib/projects/project-service";
import type {
  ConsoleRoomPage,
  RoomResult,
  createConsoleRoomSchema,
  getConsoleRoomSchema,
  listConsoleRoomsSchema,
} from "./contracts";

type Transaction = Parameters<Parameters<RelayKitDatabase["transaction"]>[0]>[0];
type Scope = { projectId: string; environmentId: string };
type Context = { database: RelayKitDatabase; userId: string };
class RoomAccessError extends Error {}

// Lock parents and membership until the operation completes, including creation.
async function authorize(tx: Transaction, userId: string, scope: Scope, write = false) {
  const [parent] = await tx
    .select({ organizationId: schema.project.organizationId })
    .from(schema.project)
    .where(eq(schema.project.id, scope.projectId));
  if (!parent) throw new RoomAccessError("The project or environment is unavailable.");
  const [organization] = await tx
    .select({ status: schema.organization.status })
    .from(schema.organization)
    .where(eq(schema.organization.id, parent.organizationId))
    .for("share");
  const [project] = await tx
    .select({ status: schema.project.status })
    .from(schema.project)
    .where(eq(schema.project.id, scope.projectId))
    .for("share");
  const [environment] = await tx
    .select({ status: schema.environment.status })
    .from(schema.environment)
    .where(
      and(
        eq(schema.environment.id, scope.environmentId),
        eq(schema.environment.projectId, scope.projectId),
      ),
    )
    .for("share");
  const [member] = await tx
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, parent.organizationId),
        eq(schema.member.userId, userId),
      ),
    )
    .for("share");
  if (
    organization?.status !== "active" ||
    project?.status !== "active" ||
    environment?.status !== "active" ||
    !member
  )
    throw new RoomAccessError("The project or environment is unavailable.");
  if (write && !canManageProjects(member.role))
    throw new RoomAccessError("Only organization owners and admins can create rooms.");
  await setUserAuditContext(tx, userId);
}

function publicRoom(row: typeof schema.room.$inferSelect) {
  return roomSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
  });
}
async function run<T>(
  context: Context,
  scope: Scope,
  write: boolean,
  execute: (tx: Transaction) => Promise<T>,
): Promise<RoomResult<T>> {
  try {
    const data = await context.database.transaction(async (tx) => {
      await authorize(tx, context.userId, scope, write);
      return execute(tx);
    });
    return { data, error: null };
  } catch (error) {
    return {
      data: null,
      error: {
        description:
          error instanceof RoomAccessError
            ? error.message
            : "Rooms are unavailable. Please try again.",
      },
    };
  }
}

export async function createConsoleRoom(
  context: Context,
  input: z.infer<typeof createConsoleRoomSchema>,
) {
  return run(context, input, true, async (tx) => {
    // A stable creation ID makes retrying a lost server-action response safe.
    const id = `room_${input.requestId.replaceAll("-", "")}`;
    const [inserted] = await tx
      .insert(schema.room)
      .values({
        id,
        projectId: input.projectId,
        environmentId: input.environmentId,
        ...input.configuration,
      })
      .onConflictDoNothing({ target: schema.room.id })
      .returning();
    if (inserted) return publicRoom(inserted);
    const [existing] = await tx
      .select()
      .from(schema.room)
      .where(
        and(
          eq(schema.room.id, id),
          eq(schema.room.projectId, input.projectId),
          eq(schema.room.environmentId, input.environmentId),
        ),
      );
    if (
      !existing ||
      existing.name !== input.configuration.name ||
      existing.maxParticipants !== input.configuration.maxParticipants ||
      !isDeepStrictEqual(existing.metadata, input.configuration.metadata)
    )
      throw new RoomAccessError(
        "This creation request was already used. Close the form and try again.",
      );
    return publicRoom(existing);
  });
}
export async function listConsoleRooms(
  context: Context,
  input: z.infer<typeof listConsoleRoomsSchema>,
) {
  return run<ConsoleRoomPage>(context, input, false, async (tx) => {
    const conditions = [
      eq(schema.room.projectId, input.projectId),
      eq(schema.room.environmentId, input.environmentId),
    ];
    if (input.status) conditions.push(eq(schema.room.status, input.status));
    if (input.cursor) {
      const date = new Date(input.cursor.createdAt);
      const cursor = or(
        lt(schema.room.createdAt, date),
        and(eq(schema.room.createdAt, date), lt(schema.room.id, input.cursor.id)),
      );
      if (cursor) conditions.push(cursor);
    }
    const result = await tx
      .select()
      .from(schema.room)
      .where(and(...conditions))
      .orderBy(desc(schema.room.createdAt), desc(schema.room.id))
      .limit(31);
    const rooms = result.slice(0, 30).map(publicRoom),
      last = rooms.at(-1);
    return {
      rooms,
      nextCursor: result.length > 30 && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  });
}
export async function getConsoleRoom(
  context: Context,
  input: z.infer<typeof getConsoleRoomSchema>,
) {
  return run(context, input, false, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.room)
      .where(
        and(
          eq(schema.room.id, input.roomId),
          eq(schema.room.projectId, input.projectId),
          eq(schema.room.environmentId, input.environmentId),
        ),
      );
    if (!row) throw new RoomAccessError("The room was not found in this environment.");
    return publicRoom(row);
  });
}
