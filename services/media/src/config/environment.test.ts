import { describe, expect, it } from "vitest";

import { readMediaEnvironment } from "./environment.js";

describe("readMediaEnvironment", () => {
  it("provides local defaults", () => {
    expect(readMediaEnvironment({})).toEqual({
      databaseUrl: "postgresql://relaykit:relaykit@127.0.0.1:5432/relaykit",
      host: "0.0.0.0",
      logLevel: "info",
      maxRoomsPerWorker: 100,
      maxTransportsPerRoom: 200,
      nodeEnvironment: "development",
      nodeId: "media-local",
      internalSecret: "development-internal-secret-change-me",
      port: 8082,
      rtcAnnouncedAddress: "127.0.0.1",
      rtcAdditionalAnnouncedAddresses: [],
      rtcListenIp: "0.0.0.0",
      rtcMaxPort: 40_003,
      rtcPort: 40_000,
      workerCount: 1,
      signalingInternalUrl: "http://signaling:8081/internal/v1",
    });
  });

  it("reads configured service values", () => {
    expect(
      readMediaEnvironment({
        DATABASE_URL: "postgresql://relayrtc:sufficient-database-credential@postgres:5432/relayrtc",
        MEDIA_HOST: "127.0.0.1",
        MEDIA_LOG_LEVEL: "debug",
        MEDIA_MAX_ROOMS_PER_WORKER: "50",
        MEDIA_MAX_TRANSPORTS_PER_ROOM: "80",
        MEDIA_NODE_ID: "media-2",
        MEDIA_PORT: "9082",
        MEDIA_RTC_ANNOUNCED_ADDRESS: "203.0.113.10",
        MEDIA_RTC_LISTEN_IP: "10.0.0.10",
        MEDIA_RTC_MAX_PORT: "41003",
        MEDIA_RTC_PORT: "41000",
        MEDIA_WORKERS: "4",
        NODE_ENV: "production",
        RELAYRTC_INTERNAL_SECRET: "production-internal-secret-at-least-32-characters",
        RELAYRTC_SIGNALING_INTERNAL_URL: "http://signaling:9081/internal/v1",
      }),
    ).toEqual({
      databaseUrl: "postgresql://relayrtc:sufficient-database-credential@postgres:5432/relayrtc",
      host: "127.0.0.1",
      logLevel: "debug",
      maxRoomsPerWorker: 50,
      maxTransportsPerRoom: 80,
      nodeEnvironment: "production",
      nodeId: "media-2",
      internalSecret: "production-internal-secret-at-least-32-characters",
      port: 9082,
      rtcAnnouncedAddress: "203.0.113.10",
      rtcAdditionalAnnouncedAddresses: [],
      rtcListenIp: "10.0.0.10",
      rtcMaxPort: 41_003,
      rtcPort: 41_000,
      workerCount: 4,
      signalingInternalUrl: "http://signaling:9081/internal/v1",
    });
  });

  it("rejects invalid ports", () => {
    expect(() => readMediaEnvironment({ MEDIA_PORT: "70000" })).toThrow(
      "Invalid media service configuration",
    );
  });

  it("requires one RTC port per worker", () => {
    expect(() =>
      readMediaEnvironment({
        MEDIA_RTC_MAX_PORT: "40001",
        MEDIA_RTC_PORT: "40000",
        MEDIA_WORKERS: "3",
      }),
    ).toThrow("RTC port range must provide one port per media worker");
  });
});

const productionEnvironment = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://relayrtc:independent-database-password@postgres:5432/relayrtc",
  RELAYRTC_INTERNAL_SECRET: "independent-internal-control-key-456",
  RELAYRTC_SIGNALING_INTERNAL_URL: "http://signaling:8081/internal/v1",
  MEDIA_RTC_ANNOUNCED_ADDRESS: "203.0.113.10",
};

describe("production media configuration", () => {
  it.each([
    "DATABASE_URL",
    "RELAYRTC_INTERNAL_SECRET",
    "RELAYRTC_SIGNALING_INTERNAL_URL",
    "MEDIA_RTC_ANNOUNCED_ADDRESS",
  ])("requires explicit %s", (name) => {
    expect(() => readMediaEnvironment({ ...productionEnvironment, [name]: undefined })).toThrow(
      name,
    );
  });
  it("rejects the development secret and database password", () => {
    expect(() =>
      readMediaEnvironment({
        ...productionEnvironment,
        RELAYRTC_INTERNAL_SECRET: "development-internal-secret-change-me",
      }),
    ).toThrow("RELAYRTC_INTERNAL_SECRET");
    expect(() =>
      readMediaEnvironment({
        ...productionEnvironment,
        DATABASE_URL: "postgresql://relaykit:relaykit@postgres/relaykit",
      }),
    ).toThrow("DATABASE_URL");
  });
});
