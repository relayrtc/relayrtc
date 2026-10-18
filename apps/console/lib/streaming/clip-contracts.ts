import { z } from "zod";
import { clipResourceSchema as clipSchema, clipWindowSchema } from "@relayrtc/validation";
export { clipSchema, clipWindowSchema };
export type ConsoleClip = z.infer<typeof clipSchema>;
export type ConsoleClipWindow = z.infer<typeof clipWindowSchema>;
