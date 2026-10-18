import { z } from "zod";
export const destinationEndpointSchema = z
  .string()
  .max(512)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["rtmp:", "rtmps:"].includes(url.protocol) &&
        !!url.hostname &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        [1935, 1936, 443].includes(Number(url.port || (url.protocol === "rtmps:" ? 443 : 1935))) &&
        /^\/[A-Za-z0-9_/-]{1,200}$/u.test(url.pathname)
      );
    } catch {
      return false;
    }
  }, "Use an RTMP/RTMPS server URL with an application path, no credentials or query, and port 1935, 1936 or 443.");
export const destinationProfileSchema = z.enum(["remux", "720p", "1080p"]);
export const destinationSecretSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_.~!$&'()*+,;=:@%/-]+$/u);
export const createDestinationSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    endpoint: destinationEndpointSchema,
    streamKey: destinationSecretSchema,
    profile: destinationProfileSchema.default("remux"),
    enabled: z.boolean().default(true),
  })
  .strict();
export const updateDestinationSchema = createDestinationSchema
  .omit({ streamKey: true })
  .partial()
  .extend({ version: z.number().int().positive() })
  .strict();
export const rotateDestinationSecretSchema = z
  .object({ version: z.number().int().positive(), streamKey: destinationSecretSchema })
  .strict();
