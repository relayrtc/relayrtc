import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { RelayKitDatabase } from "@relayrtc/database";
import type { AccountEmail, AccountEmailSender } from "./account-email.js";
import { recordAudit } from "./audit.js";

const keyFor = (secret: string) => createHash("sha256").update(`relayrtc-account-email-v1:${secret}`).digest();
const seal = (message: AccountEmail, secret: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(message), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
};
const open = (payload: string, secret: string): AccountEmail => {
  const data = Buffer.from(payload, "base64");
  const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8")) as AccountEmail;
};

// Delivery is durable and does not expose account existence through provider latency.
export const createQueuedAccountEmailSender = (database: Pick<RelayKitDatabase, "execute">, secret: string): AccountEmailSender =>
  async (message) => {
    const expiresSeconds = message.expiresInSeconds ?? (message.subject.includes("code") ? 300 : 3600);
    await database.execute(sql`INSERT INTO account_email_outbox(id, payload, subject_user_id, expires_at)
      VALUES (${randomUUID()}, ${seal(message, secret)},
        coalesce(${message.subjectUserId ?? null}, (SELECT id FROM "user" WHERE lower(email) = ${message.to.toLowerCase()})),
        now() + ${expiresSeconds} * interval '1 second')`);
  };

export async function deliverAccountEmails(database: RelayKitDatabase, secret: string, sender: AccountEmailSender) {
  // A committed lease prevents holding a database connection during network calls.
  const messages = await database.execute<{ id: string; payload: string; attempts: number; subjectUserId: string | null; expiresAt: Date }>(sql`
    WITH ready AS (SELECT id FROM account_email_outbox
      WHERE payload IS NOT NULL AND expires_at > now() AND attempts < 5 AND available_at <= now()
      ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 10)
    UPDATE account_email_outbox o SET available_at = now() + interval '2 minutes', attempts = attempts + 1
    FROM ready WHERE o.id = ready.id RETURNING o.id, o.payload, o.attempts, o.subject_user_id AS "subjectUserId", o.expires_at AS "expiresAt"`);
  for (const message of messages) {
    try {
      if (new Date(message.expiresAt).getTime() <= Date.now()) continue;
      await sender({ ...open(message.payload, secret), deliveryId: message.id });
      await database.transaction(async (transaction) => {
        const delivered = await transaction.execute(sql`UPDATE account_email_outbox SET payload = NULL, delivered_at = now() WHERE id = ${message.id} AND payload IS NOT NULL RETURNING id`);
        if (!delivered.length) return;
        await recordAudit(transaction, { actor: { type: "SYSTEM", name: "Account email delivery" },
          action: "account.email_delivered", outcome: "SUCCESS", resourceType: "user", subjectUserId: message.subjectUserId,
          correlationId: message.id });
      });
    } catch {
      const pending = await database.execute(sql`UPDATE account_email_outbox SET available_at = now() + ${Math.min(60, message.attempts * 10)} * interval '1 second' WHERE id = ${message.id} AND payload IS NOT NULL RETURNING id`);
      if (pending.length && message.attempts === 5) await recordAudit(database, { actor: { type: "SYSTEM", name: "Account email delivery" },
        action: "account.email_delivery_failed", outcome: "FAILURE", resourceType: "user", subjectUserId: message.subjectUserId, correlationId: message.id });
    }
  }
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`WITH expired AS (
      DELETE FROM account_email_outbox WHERE id IN (
        SELECT id FROM account_email_outbox WHERE expires_at < now() AND payload IS NOT NULL LIMIT 1000 FOR UPDATE SKIP LOCKED
      ) RETURNING id, subject_user_id, attempts
    ) INSERT INTO audit_event(id, actor_type, actor_name, subject_user_id, resource_type, action, outcome, correlation_id)
      SELECT gen_random_uuid()::text, 'SYSTEM', 'Account email delivery', subject_user_id, 'user', 'account.email_delivery_expired', 'FAILURE', id
      FROM expired WHERE attempts < 5`);
    await transaction.execute(sql`DELETE FROM account_email_outbox WHERE id IN (
      SELECT id FROM account_email_outbox WHERE payload IS NULL AND (expires_at < now() OR delivered_at < now() - interval '1 day') LIMIT 1000
    )`);
  });
}
