import { z } from "zod";
import { createBroadcastSchema } from "./broadcast.js";
export const scheduleTimeZoneSchema = z
  .string()
  .max(80)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Use an IANA time zone");
// UTC instants are authoritative. Local wall times without offsets are never guessed.
export const scheduleTimingSchema = z
  .object({
    startsAt: z.iso.datetime({ offset: false }),
    endsAt: z.iso.datetime({ offset: false }),
    timeZone: scheduleTimeZoneSchema.default("UTC"),
    sourceWaitSeconds: z.number().int().min(10).max(600).default(120),
    catchUpSeconds: z.number().int().min(0).max(3600).default(300),
    publisherEarlySeconds: z.number().int().min(0).max(3600).default(900),
    viewerEarlySeconds: z.number().int().min(0).max(86400).default(900),
    viewerAfterSeconds: z.number().int().min(0).max(3600).default(0),
    notifyBeforeSeconds: z.number().int().min(30).max(86400).nullable().default(null),
  })
  .strict()
  .refine(
    (v) =>
      Date.parse(v.endsAt) > Date.parse(v.startsAt) &&
      Date.parse(v.endsAt) - Date.parse(v.startsAt) <= 86400000,
    { message: "End must follow start within 24 hours" },
  );
export const createScheduleSchema = z
  .object({ broadcast: createBroadcastSchema, timing: scheduleTimingSchema })
  .strict();
export const updateScheduleSchema = z
  .object({ version: z.number().int().positive(), timing: scheduleTimingSchema })
  .strict();
export const scheduleCommandSchema = z.object({ version: z.number().int().positive() }).strict();
