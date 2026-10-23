import { expect, it } from "vitest";
import { blitYuv, solidYuv } from "./mixer-yuv.js";

it("composes Y, U and V planes without corrupting adjacent room tiles", () => {
  const canvas = solidYuv("#000000", 8, 4);
  const tile = solidYuv("#ffffff", 4, 4);
  blitYuv(canvas.pixels, tile, { x: 4, y: 0, width: 4, height: 4 }, 8, 4);
  expect([...canvas.pixels.subarray(0, 8)]).toEqual([16, 16, 16, 16, 235, 235, 235, 235]);
  expect([...canvas.pixels.subarray(24, 32)]).toEqual([16, 16, 16, 16, 235, 235, 235, 235]);
  expect([...canvas.pixels.subarray(32)]).toEqual(Array(16).fill(128));
});
