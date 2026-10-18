"use server";
import { getAuthRuntime } from "@/lib/auth-server";
import { getCurrentSession } from "@/lib/auth-session";
import {
  createConsoleRoomSchema,
  getConsoleRoomSchema,
  listConsoleRoomsSchema,
} from "@/lib/rooms/contracts";
import { createConsoleRoom, getConsoleRoom, listConsoleRooms } from "@/lib/rooms/service";

const invalid = {
  data: null,
  error: { description: "Check the room configuration and selected environment." },
} as const;
const signedOut = { data: null, error: { description: "Sign in to manage rooms." } } as const;

export async function createRoomAction(input: unknown) {
  const parsed = createConsoleRoomSchema.safeParse(input);
  if (!parsed.success) return invalid;
  const session = await getCurrentSession();
  if (!session) return signedOut;
  return createConsoleRoom(
    { database: getAuthRuntime().database, userId: session.user.id },
    parsed.data,
  );
}
export async function listRoomsAction(input: unknown) {
  const parsed = listConsoleRoomsSchema.safeParse(input);
  if (!parsed.success) return invalid;
  const session = await getCurrentSession();
  if (!session) return signedOut;
  return listConsoleRooms(
    { database: getAuthRuntime().database, userId: session.user.id },
    parsed.data,
  );
}
export async function getRoomAction(input: unknown) {
  const parsed = getConsoleRoomSchema.safeParse(input);
  if (!parsed.success) return invalid;
  const session = await getCurrentSession();
  if (!session) return signedOut;
  return getConsoleRoom(
    { database: getAuthRuntime().database, userId: session.user.id },
    parsed.data,
  );
}
