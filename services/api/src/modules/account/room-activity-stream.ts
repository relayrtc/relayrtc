import type { FastifyInstance, FastifyReply } from "fastify";
import type { RoomActivitySnapshot } from "@relayrtc/types";
import { ApiError } from "../../http/errors/api-error.js";

export function createRoomActivityStream(app: FastifyInstance) {
  const connections = new Set<() => void>();
  const owners = new Map<string, number>();
  let stopping = false;
  app.addHook("preClose", (done) => {
    stopping = true;
    for (const close of connections) close();
    done();
  });
  return async (reply: FastifyReply, owner: string, read: () => Promise<RoomActivitySnapshot>) => {
    const initial = await read();
    if (reply.raw.destroyed || stopping) return;
    if (connections.size >= 128 || (owners.get(owner) ?? 0) >= 4) {
      reply.header("retry-after", "5");
      throw new ApiError(
        429,
        "ACTIVITY_STREAM_LIMIT",
        "Close another live activity view before opening this one.",
      );
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "private, no-store, no-transform",
      "referrer-policy": "no-referrer",
      "x-accel-buffering": "no",
    });
    let closed = false;
    function isClosed() {
      return closed;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous = "";
    let sentAt = 0;
    const lifetime = setTimeout(close, 110000);
    lifetime.unref();
    function close() {
      if (isClosed()) return;
      closed = true;
      clearTimeout(timer);
      clearTimeout(lifetime);
      connections.delete(close);
      const remaining = (owners.get(owner) ?? 1) - 1;
      if (remaining > 0) owners.set(owner, remaining);
      else owners.delete(owner);
      reply.raw.off("close", close);
      if (!reply.raw.destroyed) reply.raw.end();
    }
    function send(snapshot: RoomActivitySnapshot) {
      if (isClosed() || reply.raw.destroyed) return;
      if (reply.raw.writableLength > 262144) {
        close();
        return;
      }
      const key = JSON.stringify({ ...snapshot, observedAt: null });
      if (key === previous && Date.now() - sentAt < 2000) return;
      previous = key;
      sentAt = Date.now();
      reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    }
    async function tick() {
      if (isClosed()) return;
      try {
        send(await read());
      } catch {
        close();
      } finally {
        if (!isClosed()) {
          timer = setTimeout(() => {
            void tick();
          }, 500);
          timer.unref();
        }
      }
    }
    connections.add(close);
    owners.set(owner, (owners.get(owner) ?? 0) + 1);
    reply.raw.on("close", close);
    reply.raw.write("retry: 500\n\n");
    send(initial);
    timer = setTimeout(() => {
      void tick();
    }, 500);
    timer.unref();
  };
}
