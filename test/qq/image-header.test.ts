import { describe, expect, it } from 'vitest';
import { validateImageHeader } from '../../src/qq/image-header.js';

function png(w: number, h: number) {
  const b = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(b);
  b.writeUInt32BE(13,8); b.write('IHDR',12); b.writeUInt32BE(w,16); b.writeUInt32BE(h,20); return b;
}
function webp(kind: string) { const b = Buffer.alloc(30); b.write('RIFF'); b.write('WEBP',8); b.write(kind,12); return b; }
function gif(frames = 1) {
  const head = Buffer.from([71,73,70,56,57,97,1,0,1,0,0,0,0]);
  const frame = Buffer.from([44,0,0,0,0,1,0,1,0,0,2,1,0,0]);
  return Buffer.concat([head, ...Array(frames).fill(frame), Buffer.from([59])]);
}
describe('无解码参考图头校验', () => {
  it('PNG IHDR 读取尺寸，拒绝超边长及像素炸弹', () => {
    expect(validateImageHeader(png(4096,4096))).toEqual({ width: 4096, height: 4096 });
    expect(() => validateImageHeader(png(4097,1))).toThrow('4096');
    expect(() => validateImageHeader(png(5000,5000))).toThrow('20 MP');
  });
  it('JPEG SOF 在解码前读取尺寸并拒绝截断', () => {
    const b = Buffer.from([255,216,255,224,0,2,255,192,0,8,8,0,32,0,64,1]);
    expect(validateImageHeader(b)).toEqual({ width: 64, height: 32 });
    b.writeUInt16BE(5000,13); expect(() => validateImageHeader(b)).toThrow('4096');
    expect(() => validateImageHeader(b.subarray(0,12))).toThrow('截断');
  });
  it('读取 WebP VP8、VP8L、VP8X 头并拒绝动画标志', () => {
    const vp8 = webp('VP8 '); Buffer.from([157,1,42]).copy(vp8,23); vp8.writeUInt16LE(32,26); vp8.writeUInt16LE(64,28);
    expect(validateImageHeader(vp8)).toEqual({ width: 32, height: 64 });
    const lossless = webp('VP8L'); lossless[20] = 47; lossless.writeUInt32LE(31 | (63 << 14),21);
    expect(validateImageHeader(lossless)).toEqual({ width: 32, height: 64 });
    const extended = webp('VP8X'); extended.writeUIntLE(31,24,3); extended.writeUIntLE(63,27,3);
    expect(validateImageHeader(extended)).toEqual({ width: 32, height: 64 });
    extended[20] = 2; expect(() => validateImageHeader(extended)).toThrow('动画 WebP');
  });
  it('GIF LSD 读取尺寸，拒绝多帧及 NETSCAPE 循环块', () => {
    expect(validateImageHeader(gif())).toEqual({ width: 1, height: 1 });
    expect(() => validateImageHeader(gif(2))).toThrow('动画 GIF');
    const loop = Buffer.concat([gif().subarray(0,13), Buffer.from([33,255,11]), Buffer.from('NETSCAPE2.0'), Buffer.from([0,59])]);
    expect(() => validateImageHeader(loop)).toThrow('循环块');
  });
});
