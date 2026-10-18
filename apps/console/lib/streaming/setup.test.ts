import { describe, expect, it } from "vitest";
import { localDateInput, localDateToIso, rtmpEncoderFields } from "./setup";

describe("encoder setup", () => {
  it("splits RTMP into the server and authenticated stream key", () => {
    expect(rtmpEncoderFields("rtmp://localhost:1935/ingest_stream_test", "a+b&c=?")).toEqual({
      server: "rtmp://localhost:1935",
      streamKey: "ingest_stream_test?pass=a%2Bb%26c%3D%3F",
    });
  });
  it("preserves RTMPS and nested publishing paths", () => {
    expect(rtmpEncoderFields("rtmps://video.example:1936/live/stream", "secret")).toEqual({
      server: "rtmps://video.example:1936",
      streamKey: "live/stream?pass=secret",
    });
  });
});

describe("local schedule input", () => {
  it("converts a local selection to the same instant shown in the form", () => {
    const local = "2027-06-20T14:30";
    const instant = localDateToIso(local);
    expect(instant).toBe(new Date(2027, 5, 20, 14, 30).toISOString());
    expect(localDateInput(instant)).toBe(local);
  });
  it("rejects incomplete and normalized invalid calendar dates", () => {
    for (const input of ["", "not-a-date", "2027-02-30T14:30", "2027-01-01", "2027-01-01T25:00"])
      expect(localDateToIso(input)).toBe("");
    expect(localDateInput("invalid")).toBe("");
  });
});
