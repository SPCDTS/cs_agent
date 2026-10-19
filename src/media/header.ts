/** 只解析容器头与块长度，不调用解码器；参考图在下载及上传前共用此边界。 */
export function validateImageHeader(b: Buffer): { width: number; height: number } {
  let width = 0, height = 0;
  const invalid = () => { throw new Error('参考图头无效或截断'); };
  const need = (end: number) => { if (end > b.length) invalid(); };
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    need(33);
    if (b.readUInt32BE(8) !== 13 || b.toString('ascii', 12, 16) !== 'IHDR') invalid();
    width = b.readUInt32BE(16); height = b.readUInt32BE(20);
  } else if (b[0] === 255 && b[1] === 216) {
    let p = 2;
    while (p < b.length) {
      if (b[p++] !== 255) invalid();
      while (b[p] === 255) p++;
      const marker = b[p++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker! >= 208 && marker! <= 215)) continue;
      need(p + 2); const len = b.readUInt16BE(p);
      if (len < 2) invalid(); need(p + len);
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker!)) {
        if (len < 8) invalid();
        height = b.readUInt16BE(p + 3); width = b.readUInt16BE(p + 5); break;
      }
      p += len;
    }
  } else if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    need(20);
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      need(30); if (b[20]! & 2) throw new Error('不支持动画 WebP');
      width = b.readUIntLE(24, 3) + 1; height = b.readUIntLE(27, 3) + 1;
    } else if (kind === 'VP8L') {
      need(25); if (b[20] !== 47) invalid();
      const bits = b.readUInt32LE(21);
      width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (kind === 'VP8 ') {
      need(30); if (!b.subarray(23,26).equals(Buffer.from([157,1,42]))) invalid();
      width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff;
    } else invalid();
  } else if (/^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) {
    need(13); width = b.readUInt16LE(6); height = b.readUInt16LE(8);
    let p = 13 + ((b[10]! & 128) ? 3 * (2 ** ((b[10]! & 7) + 1)) : 0), frames = 0;
    const blocks = () => { for (;;) { need(p + 1); const n = b[p++]!; if (!n) return; need(p + n); p += n; } };
    for (;;) {
      need(p + 1); const tag = b[p++];
      if (tag === 59) break;
      if (tag === 44) {
        if (++frames > 1) throw new Error('不支持动画 GIF');
        need(p + 9);
        const frameWidth = b.readUInt16LE(p + 4), frameHeight = b.readUInt16LE(p + 6);
        if (frameWidth > 4096 || frameHeight > 4096 || frameWidth * frameHeight > 20_000_000) throw new Error('参考图尺寸超过 4096 边长或 20 MP');
        const packed = b[p + 8]!; p += 9;
        if (packed & 128) p += 3 * (2 ** ((packed & 7) + 1));
        need(p + 1); p++; blocks();
      } else if (tag === 33) {
        need(p + 1); const label = b[p++];
        if (label === 255 && b.toString('ascii', p + 1, p + 12) === 'NETSCAPE2.0') throw new Error('不支持动画 GIF（循环块）');
        blocks();
      } else invalid();
    }
    if (!frames) invalid();
  } else throw new Error('参考图魔数无效，仅支持 PNG/JPEG/WebP/GIF');
  if (!width || !height) invalid();
  if (width > 4096 || height > 4096 || width * height > 20_000_000) throw new Error('参考图尺寸超过 4096 边长或 20 MP');
  return { width, height };
}
