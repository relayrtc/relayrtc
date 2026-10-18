import { z } from "zod";
export const destinationSchema = z.object({
  id: z.string(),
  streamId: z.string(),
  name: z.string(),
  host: z.string(),
  protocol: z.enum(["rtmp", "rtmps"]),
  port: z.number(),
  profile: z.enum(["remux", "720p", "1080p"]),
  enabled: z.boolean(),
  version: z.number(),
  credentialVersion: z.number(),
  secretConfigured: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const destinationPageSchema = z.object({
  data: z.array(destinationSchema),
  nextCursor: z.string().nullable(),
});
export type ConsoleDestination = z.infer<typeof destinationSchema>;
