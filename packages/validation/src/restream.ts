import { z } from "zod";
import { streamingIdSchema } from "./streaming.js";
const fields = {
  name: z.string().trim().min(1).max(120),
  endpoint: z.url().max(2048).optional(),
  authorization: z
    .string()
    .max(2048)
    .refine((v) => !/[\r\n]/u.test(v) && !v.includes(String.fromCharCode(0)))
    .optional(),
  redistributionAuthorized: z.literal(true),
  reconnectBudget: z.number().int().min(0).max(5).default(3),
  maxDurationSeconds: z.number().int().min(60).max(86400).default(14400),
  maxBytes: z.number().int().min(1048576).max(20000000000).default(2000000000),
};
export const createRestreamSourceSchema = z
  .object({
    ...fields,
    streamId: streamingIdSchema,
    protocol: z.enum(["hls_pull", "rtmp_push", "whip_push"]),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      (v.protocol === "hls_pull") !== !!v.endpoint ||
      (v.protocol !== "hls_pull" && v.authorization)
    )
      c.addIssue({
        code: "custom",
        message: "Only HLS pull sources accept an endpoint and authorization header",
      });
  });
export const updateRestreamSourceSchema = z
  .object({
    ...fields,
    reconnectBudget: fields.reconnectBudget.unwrap(),
    maxDurationSeconds: fields.maxDurationSeconds.unwrap(),
    maxBytes: fields.maxBytes.unwrap(),
  })
  .partial()
  .extend({ version: z.number().int().positive() })
  .strict();
