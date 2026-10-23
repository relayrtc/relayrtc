import { expect, it } from "vitest";
import { dueMixerFrames } from "./mixer-clock.js";
it("keeps raw media time aligned after delayed callbacks and bounds catch-up IO", () => {
  expect(dueMixerFrames(1000, 29, 30)).toBe(1);
  expect(dueMixerFrames(1100, 30, 30)).toBe(3);
  expect(dueMixerFrames(2000, 30, 30)).toBe(8);
  expect(dueMixerFrames(1000, 30, 30)).toBe(0);
});
