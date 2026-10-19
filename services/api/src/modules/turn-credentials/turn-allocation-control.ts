import { createConnection, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RelayKitDatabase } from "@relayrtc/database";
import { sql } from "drizzle-orm";

export interface TurnAllocationControl {
  host: string;
  port: number;
  password: string;
}

class TurnAdminConnection {
  readonly socket: Socket;
  #pending: { resolve(value: string): void; reject(error: Error): void } | undefined;
  #buffer = "";
  #passwordSent = false;

  constructor(private readonly options: TurnAllocationControl) {
    this.socket = createConnection({ host: options.host, port: options.port });
    this.socket.setTimeout(3000, () =>
      this.socket.destroy(new Error("TURN administration timed out")),
    );
    this.socket.on("data", (chunk: Buffer) => {
      this.#buffer += chunk.toString("latin1").replace(/\xff[\xfb-\xfe][\s\S]/gu, "");
      if (this.#buffer.length > 1048576) {
        this.socket.destroy(new Error("TURN administration response exceeds the limit"));
        return;
      }
      if (/Enter password:/u.test(this.#buffer)) {
        if (this.#passwordSent) {
          this.socket.destroy(new Error("TURN administration authentication failed"));
          return;
        }
        this.#buffer = "";
        this.#passwordSent = true;
        this.socket.write(`${this.options.password}\r\n`);
      }
      if (this.#buffer.endsWith("> ") && this.#pending) {
        if (!this.#passwordSent) {
          this.socket.destroy(new Error("TURN administration must require authentication"));
          return;
        }
        const pending = this.#pending;
        this.#pending = undefined;
        const response = this.#buffer;
        this.#buffer = "";
        pending.resolve(response);
      }
    });
    this.socket.on("error", () => this.#fail());
    this.socket.on("close", () => this.#fail());
  }

  #fail() {
    this.#pending?.reject(new Error("TURN administration connection failed"));
    this.#pending = undefined;
  }

  response(command?: string): Promise<string> {
    if (this.socket.destroyed)
      return Promise.reject(new Error("TURN administration is unavailable"));
    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
      if (command) this.socket.write(`${command}\r\n`);
    });
  }
}

export async function retireTurnCredentials(database: RelayKitDatabase) {
  await database.execute(sql`
    update turn_credential c set revoked_at = now()
    where c.username in (
      select t.username from turn_credential t
      where t.revoked_at is null and not exists (
        select 1 from turn_credential_authority a where a.username = t.username
      ) order by t.expires_at limit 1000
    )
  `);
}

export async function cancelRetiredTurnAllocations(
  database: RelayKitDatabase,
  directory: string,
  options: TurnAllocationControl,
) {
  const source = (await readFile(join(directory, "current"), "utf8")).trim();
  if (!/^[0-9a-f-]{36}\.log$/u.test(source)) throw new Error("Invalid coturn source identity");
  const allocations = await database.execute(sql`
    select t.id, t.native_id, t.username from turn_allocation t
    join turn_credential c on c.username = t.username
    where t.source_id = ${source} and t.ended_at is null
      and (c.revoked_at is not null or not exists (
        select 1 from turn_credential_authority a where a.username = c.username
      )) order by t.retirement_checked_at nulls first, t.last_observed_at limit 32
  `);
  if (!allocations.length) return;
  const connection = new TurnAdminConnection(options);
  const deadline = setTimeout(
    () => connection.socket.destroy(new Error("TURN retirement deadline exceeded")),
    10_000,
  );
  try {
    await connection.response();
    for (const allocation of allocations) {
      const nativeId = String(allocation.native_id);
      const username = String(allocation.username);
      if (!/^\d{18}$/u.test(nativeId) || !/^[A-Za-z0-9_.:-]{1,512}$/u.test(username))
        throw new Error("Invalid retained TURN session identity");
      const sessions = await connection.response(`ps ${username}`);
      await database.execute(
        sql`update turn_allocation set retirement_checked_at = now() where id = ${String(allocation.id)}`,
      );
      if (!sessions.includes(`id=${nativeId}, user <${username}>:`)) continue;
      if ((await readFile(join(directory, "current"), "utf8")).trim() !== source)
        throw new Error("The coturn source changed during allocation retirement");
      await connection.response(`cs ${nativeId}`);
    }
  } finally {
    clearTimeout(deadline);
    connection.socket.destroy();
  }
}
