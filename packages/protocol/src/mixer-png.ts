import { inflateSync } from "node:zlib";
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (bytes: Buffer) => {
  let c = 0xffffffff;
  for (const b of bytes) c = (c >>> 8) ^ Number(crcTable[(c ^ b) & 255]);
  return (c ^ 0xffffffff) >>> 0;
};
const invalid = () => new Error("MIXER_OVERLAY_INVALID");
/** Deliberately restricted PNG admission: 8-bit RGB/RGBA, non-interlaced, bounded inflate. */
export function decodeMixerPng(file: Buffer): { width: number; height: number; pixels: Buffer } {
  if (
    file.length > 1048576 ||
    file.length < 57 ||
    file.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  )
    throw invalid();
  let offset = 8,
    width = 0,
    height = 0,
    channels = 0,
    ended = false,
    closedData = false,
    chunks = 0;
  const compressed: Buffer[] = [];
  while (offset < file.length) {
    if (++chunks > 128 || offset + 12 > file.length) throw invalid();
    const size = file.readUInt32BE(offset),
      type = file.toString("ascii", offset + 4, offset + 8),
      finish = offset + 12 + size;
    if (
      finish > file.length ||
      !/^[A-Za-z]{4}$/u.test(type) ||
      crc(file.subarray(offset + 4, offset + 8 + size)) !== file.readUInt32BE(offset + 8 + size)
    )
      throw invalid();
    const data = file.subarray(offset + 8, offset + 8 + size);
    if (chunks === 1) {
      if (type !== "IHDR" || size !== 13) throw invalid();
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (
        width < 1 ||
        width > 640 ||
        height < 1 ||
        height > 360 ||
        data[8] !== 8 ||
        !channels ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      )
        throw invalid();
    } else if (type === "IDAT") {
      if (closedData) throw invalid();
      compressed.push(data);
    } else if (type === "IEND") {
      if (size || finish !== file.length || !compressed.length) throw invalid();
      ended = true;
      break;
    } else {
      if (compressed.length) closedData = true;
      if (type === "IHDR" || type === "acTL" || type === "tRNS" || type.charCodeAt(0) < 97)
        throw invalid();
    }
    offset = finish;
  }
  if (!ended) throw invalid();
  const stride = width * channels,
    expected = (stride + 1) * height;
  const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  if (raw.length !== expected) throw invalid();
  const decoded = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter === undefined || filter > 4) throw invalid();
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? Number(decoded[y * stride + x - channels]) : 0,
        b = y ? Number(decoded[(y - 1) * stride + x]) : 0,
        c = y && x >= channels ? Number(decoded[(y - 1) * stride + x - channels]) : 0;
      const p = a + b - c,
        pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c);
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? Math.floor((a + b) / 2)
                : pa <= pb && pa <= pc
                  ? a
                  : pb <= pc
                    ? b
                    : c;
      decoded[y * stride + x] = (Number(raw[y * (stride + 1) + 1 + x]) + predictor) & 255;
    }
  }
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = Number(decoded[i * channels]);
    pixels[i * 4 + 1] = Number(decoded[i * channels + 1]);
    pixels[i * 4 + 2] = Number(decoded[i * channels + 2]);
    pixels[i * 4 + 3] = channels === 4 ? Number(decoded[i * channels + 3]) : 255;
  }
  return { width, height, pixels };
}
