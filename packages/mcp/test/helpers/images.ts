/** Minimal image headers — enough for image-size to read dimensions. */

export function pngBytes(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); // chunk length
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // RGBA
  // compression/filter/interlace = 0, CRC left zero (not checked by image-size)
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([sig, ihdr, iend]);
}

/** Baseline JPEG header with an EXIF APP1 segment carrying `orientation`. */
export function jpegBytes(width: number, height: number, orientation?: number): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (orientation !== undefined) {
    const tiff = Buffer.alloc(26);
    tiff.write('MM', 0, 'ascii');
    tiff.writeUInt16BE(0x002a, 2);
    tiff.writeUInt32BE(8, 4); // IFD0 offset
    tiff.writeUInt16BE(1, 8); // one entry
    tiff.writeUInt16BE(0x0112, 10); // Orientation
    tiff.writeUInt16BE(3, 12); // SHORT
    tiff.writeUInt32BE(1, 14); // count
    tiff.writeUInt16BE(orientation, 18); // value (left-justified)
    tiff.writeUInt32BE(0, 22); // next IFD
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2, 0);
    parts.push(Buffer.from([0xff, 0xe1]), len, payload);
  } else {
    // APP0 JFIF — real JPEGs always carry an APP segment right after SOI
    const jfif = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
    parts.push(jfif);
  }
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  for (let c = 0; c < 3; c++) {
    sof[10 + c * 3] = c + 1;
    sof[11 + c * 3] = 0x11;
    sof[12 + c * 3] = 0;
  }
  parts.push(sof, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}
