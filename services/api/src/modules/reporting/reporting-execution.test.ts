import type { RelayKitDatabase } from "@relayrtc/database";
import { expect, it, vi } from "vitest";
import { createReportReader } from "./reporting-execution.js";

it("coalesces authorized report reads and does not retain failed results", async () => {
  const execute = vi.fn(() => Promise.resolve([]));
  const transaction = vi.fn(async (load: (db: { execute: typeof execute }) => Promise<unknown>) =>
    load({ execute }),
  );
  const read = createReportReader({ transaction } as unknown as RelayKitDatabase);
  const load = vi.fn(() => Promise.resolve({ value: 12 }));
  const [a, b] = await Promise.all([read("scope-1", load), read("scope-1", load)]);
  expect(a).toEqual(b);
  expect(load).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledTimes(6);
  await read("scope-2", load);
  expect(load).toHaveBeenCalledTimes(2);
  await expect(
    read("failed", () => Promise.reject(new Error("database down"))),
  ).rejects.toThrow("database down");
  await expect(read("failed", load)).resolves.toEqual({ value: 12 });
});
