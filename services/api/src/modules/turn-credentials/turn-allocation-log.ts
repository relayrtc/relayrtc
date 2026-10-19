export interface TurnAllocationObservation {
  readonly nativeId: string;
  readonly username: string;
  readonly realm: string;
  readonly occurredAt: Date;
  readonly kind: "new" | "refreshed" | "deleted" | "client" | "peer";
  readonly lifetime: number;
  readonly ingressBytes: number;
  readonly egressBytes: number;
}

export function parseTurnAllocationLog(line: string): TurnAllocationObservation | null {
  const record = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) INFO (.*)$/u.exec(line);
  const body = record?.[2] ?? line;
  const lifecycle =
    /^allocation (new|refreshed), realm=<[^>]*>, username=<([^>]*)>, lifetime=(\d+)(?:, cipher=[^\r\n,]+, method=[^\r\n]+)? \(session (\d{18})\)$/u.exec(
      body,
    );
  const deleted =
    /^allocation delete: realm=<[^>]*>, username=<([^>]*)> \(session (\d{18})\)$/u.exec(body);
  const traffic =
    /^(peer )?usage: realm=<[^>]*>, username=<([^>]*)>, rp=\d+, rb=(\d+), sp=\d+, sb=(\d+) \(session (\d{18})\)$/u.exec(
      body,
    );
  if (!lifecycle && !deleted && !traffic) {
    if (/^(?:allocation (?:new|refreshed|delete)|(?:peer )?usage: realm=)/u.test(body))
      throw new Error("Unsupported coturn allocation log format");
    return null;
  }
  const timestamp = record?.[1];
  const realm = /realm=<([^>]*)>/u.exec(body)?.[1] ?? "";
  const occurredAt = new Date(timestamp ?? "");
  if (!Number.isFinite(occurredAt.getTime()))
    throw new Error("Coturn observations require UTC timestamps");
  const integer = (value: string | undefined) => {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0)
      throw new Error("Invalid coturn observation counter");
    return result;
  };
  if (lifecycle) {
    const lifetime = integer(lifecycle[3]);
    if (lifetime > 3600)
      throw new Error("Coturn allocation lifetime exceeds the supported maximum");
    return {
      nativeId: lifecycle[4] ?? "",
      username: lifecycle[2] ?? "",
      realm,
      occurredAt,
      kind: lifecycle[1] === "new" ? "new" : "refreshed",
      lifetime,
      ingressBytes: 0,
      egressBytes: 0,
    };
  }
  if (deleted)
    return {
      nativeId: deleted[2] ?? "",
      username: deleted[1] ?? "",
      realm,
      occurredAt,
      kind: "deleted",
      lifetime: 0,
      ingressBytes: 0,
      egressBytes: 0,
    };
  if (traffic)
    if (!traffic[2] && integer(traffic[3]) === 0 && integer(traffic[4]) === 0) return null;
  if (traffic)
    return {
      nativeId: traffic[5] ?? "",
      username: traffic[2] ?? "",
      realm,
      occurredAt,
      kind: traffic[1] ? "peer" : "client",
      lifetime: 0,
      ingressBytes: integer(traffic[3]),
      egressBytes: integer(traffic[4]),
    };
  return null;
}
