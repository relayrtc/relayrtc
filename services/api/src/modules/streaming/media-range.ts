import type { FastifyReply, FastifyRequest } from "fastify";

export function mediaRange(
  request: FastifyRequest,
  reply: FastifyReply,
  length: number,
): { start: number; end: number } | null {
  reply.header("accept-ranges", "bytes");
  const header = request.headers.range;
  if (!header) return { start: 0, end: length - 1 };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header);
  let start: number,
    end = length - 1;
  if (match && (match[1] || match[2])) {
    if (match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    } else start = Math.max(0, length - Number(match[2]));
    if (
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start <= end &&
      start < length &&
      (match[1] || Number(match[2]) > 0)
    ) {
      reply
        .code(206)
        .header("content-range", `bytes ${String(start)}-${String(end)}/${String(length)}`);
      return { start, end };
    }
  }
  reply.code(416).header("content-range", `bytes */${String(length)}`);
  return null;
}
