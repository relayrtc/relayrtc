import { randomUUID } from "node:crypto";

import type { Metadata, RoomStatus } from "@relayrtc/types";

import { ApiError } from "../../http/errors/api-error.js";
import type { CreateRoomBody, ListRoomsQuery } from "./room.schema.js";
import type { RoomCursor, RoomRecord, RoomRepository, RoomScope } from "./room.repository.js";
import type { RuntimeOperationView } from "@relayrtc/auth";
import type { RoomRuntimeService } from "./room-runtime.service.js";

interface RoomResponse {
  createdAt: string;
  endedAt: string | null;
  environmentId: string;
  id: string;
  maxParticipants: number;
  metadata: Metadata;
  name: string;
  projectId: string;
  startedAt: string | null;
  status: RoomStatus;
}

interface RoomConnection {
  nodes: readonly RoomResponse[];
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
}

const roomId = (): string => `room_${randomUUID().replaceAll("-", "")}`;

const toResponse = (room: RoomRecord): RoomResponse => ({
  ...room,
  createdAt: room.createdAt.toISOString(),
  endedAt: room.endedAt?.toISOString() ?? null,
  startedAt: room.startedAt?.toISOString() ?? null,
});

const encodeCursor = (room: RoomRecord): string =>
  Buffer.from(JSON.stringify([room.createdAt.toISOString(), room.id]), "utf8").toString("base64url");

const decodeCursor = (cursor: string): RoomCursor => {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "string"
    ) {
      throw new Error("Invalid cursor shape");
    }

    const createdAt = new Date(value[0]);
    if (Number.isNaN(createdAt.getTime()) || value[1].length === 0) {
      throw new Error("Invalid cursor values");
    }

    return { createdAt, id: value[1] };
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "The room list cursor is invalid");
  }
};

export const createRoomService = (repository: RoomRepository, runtime?: RoomRuntimeService) => ({
  async create(scope: RoomScope, input: CreateRoomBody): Promise<RoomResponse> {
    const created = await repository.create({
      ...scope,
      id: roomId(),
      maxParticipants: input.maxParticipants,
      metadata: input.metadata,
      name: input.name,
    });

    return toResponse(created);
  },

  async end(scope: RoomScope, id: string): Promise<RuntimeOperationView | undefined> {
    const ended = await repository.end(scope, id, new Date());
    if (!ended) throw new ApiError(404, "ROOM_NOT_FOUND", "The room does not exist");
    return runtime?.end(ended);
  },

  async get(scope: RoomScope, id: string): Promise<RoomResponse> {
    const room = await repository.find(scope, id);
    if (!room) throw new ApiError(404, "ROOM_NOT_FOUND", "The room does not exist");
    return toResponse(room);
  },

  async list(scope: RoomScope, query: ListRoomsQuery): Promise<RoomConnection> {
    const rooms = await repository.list({
      ...scope,
      ...(query.cursor ? { cursor: decodeCursor(query.cursor) } : {}),
      limit: query.limit,
      ...(query.status ? { status: query.status } : {}),
        ...(query.search ? { search: query.search } : {}),
        ...(query.joinable ? { joinable: true } : {}),
    });
    const hasNextPage = rooms.length > query.limit;
    const nodes = rooms.slice(0, query.limit);
    const lastRoom = nodes.at(-1);

    return {
      nodes: nodes.map(toResponse),
      pageInfo: {
        endCursor: hasNextPage && lastRoom ? encodeCursor(lastRoom) : null,
        hasNextPage,
      },
    };
  },
});
