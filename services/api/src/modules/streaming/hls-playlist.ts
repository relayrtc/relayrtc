import { streamingObjectNameSchema } from "@relayrtc/validation";
import { ApiError } from "../../http/errors/api-error.js";

function objectName(value: unknown) {
  const parsed = streamingObjectNameSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      502,
      "INVALID_PLAYLIST_URI",
      "The packager returned an unsupported media reference",
    );
  return parsed.data;
}

export function parseHlsPlaylist(text: string) {
  if (
    !text.startsWith("#EXTM3U") ||
    text.includes("#EXT-X-KEY") ||
    text.includes("#EXT-X-SESSION-KEY")
  )
    throw new ApiError(502, "INVALID_PLAYLIST", "The packager returned an unsupported playlist");
  const children = new Set<string>(),
    segments: string[] = [],
    maps = new Set<string>();
  let gap = false,
    duration = 0;
  let programDateTime: number | null = null,
    latestEndAt: number | null = null;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "#EXT-X-GAP") gap = true;
    if (line.startsWith("#EXTINF:")) duration = Number(line.slice(8).split(",")[0]);
    if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const instant = Date.parse(line.slice(25));
      programDateTime = Number.isFinite(instant) ? instant : null;
    }
    if (line && !line.startsWith("#")) {
      const name = objectName(line);
      if (!gap) {
        children.add(name);
        if (duration > 0 && !name.endsWith("m3u8")) {
          segments.push(name);
          latestEndAt = programDateTime === null ? null : programDateTime + duration * 1000;
        }
      }
      gap = false;
      duration = 0;
      programDateTime = null;
    }
    if (
      line.startsWith("#EXT-X-PRELOAD-HINT:") ||
      line.startsWith("#EXT-X-RENDITION-REPORT:") ||
      line.startsWith("#EXT-X-PART:") ||
      /(?:^|,)GAP=YES(?:,|$)/u.test(line)
    )
      continue;
    for (const match of line.matchAll(/URI="([^"]+)"/gu)) {
      const name = objectName(match[1]);
      children.add(name);
      if (line.startsWith("#EXT-X-MAP:")) maps.add(name);
    }
  }
  if (children.size > 128)
    throw new ApiError(
      502,
      "PLAYLIST_TOO_LARGE",
      "The playlist exceeds the supported media window",
    );
  return {
    children: [...children],
    playlists: [...children].filter((name) => name.endsWith("m3u8")),
    segments,
    maps: [...maps],
    latestEndAt,
  };
}

export function rewriteHlsPlaylist(text: string, uri: (name: string) => string) {
  parseHlsPlaylist(text);
  return text
    .split(/\r?\n/u)
    .map((line) =>
      line.startsWith("#")
        ? line.replace(
            /URI="([^"]+)"/gu,
            (_match: string, name: string) => `URI="${uri(objectName(name))}"`,
          )
        : line.trim()
          ? uri(objectName(line.trim()))
          : line,
    )
    .join("\n");
}

export function hasMp4Boxes(body: Buffer, required: string[]) {
  const found = new Set<string>();
  for (let position = 0; position + 8 <= body.length;) {
    const size = body.readUInt32BE(position),
      type = body.toString("ascii", position + 4, position + 8);
    if (size < 8 || position + size > body.length) return false;
    found.add(type);
    position += size;
    if (position === body.length) return required.every((name) => found.has(name));
  }
  return false;
}
