import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadImage, forbiddenAddress, type DownloadHooks } from '../../src/media/download.js';
import { downloadIncoming } from '../../src/qq/incoming.js';
import { tmp } from '../agent/helpers.js';
import { PNG_1PX as PNG } from '../agent/helpers.js';

let server: Server, base: string, hits: number;
const hooks: DownloadHooks = {
  resolve: async () => [{ address: '93.184.216.34', family: 4 }],
  request: (url, options, cb) => {
    // 先证明生产连接会固定在已验证的 IP；测试传输再导向本机假 CDN。
    expect(url.hostname).toBe('93.184.216.34');
    expect(options.headers).toMatchObject({ Host: 'public.test' });
    const lookup = options.lookup!;
    lookup('public.test', { all: false }, (err, address) => { expect(err).toBeNull(); expect(address).toBe('93.184.216.34'); });
    expect(options.agent).toBe(false);
    return request(new URL(url.pathname, base), { ...options, lookup: undefined }, cb);
  },
};
beforeEach(async () => {
  hits = 0;
  server = createServer((req, res) => {
    hits++;
    if (req.url === '/private') res.writeHead(302, { location: base }).end();
    else if (req.url?.startsWith('/hop/')) {
      const n = Number(req.url.split('/').pop());
      if (n) res.writeHead(302, { location: `/hop/${n-1}` }).end(); else res.end(PNG);
    } else res.end(PNG);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
const download = (url: string, h = hooks) => downloadImage(url, AbortSignal.timeout(1000), h);
describe('入站 SSRF 与固定 DNS', () => {
  it('拒绝直接私网 IP，不连接假服务器', async () => { await expect(download(base)).rejects.toThrow('内部网络'); expect(hits).toBe(0); });
  it('任一 DNS 地址为私网即拒绝，含混合 IPv4/IPv6', async () => {
    await expect(download('http://public.test', { ...hooks, resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '::ffff:127.0.0.1', family: 6 }] })).rejects.toThrow('内部网络');
    expect(hits).toBe(0);
  });
  it('公网外观假 CDN 通过且连接固定 IP', async () => { expect(await download('http://public.test')).toEqual(PNG); expect(hits).toBe(1); });
  it('重定向到私网被拒绝', async () => { await expect(download('http://public.test/private')).rejects.toThrow('内部网络'); expect(hits).toBe(1); });
  it('最多跟随 3 跳，第四跳拒绝', async () => {
    expect(await download('http://public.test/hop/3')).toEqual(PNG);
    await expect(download('http://public.test/hop/4')).rejects.toThrow('超过 3 次');
  });
  it.each(['localhost', 'a.localhost', 'host.docker.internal', 'x.internal', 'x.docker.internal', 'localhost.'])('拒绝内部主机 %s', async host => {
    await expect(download('http://' + host)).rejects.toThrow('内部网络'); expect(hits).toBe(0);
  });
  it.each(['0.0.0.0','127.0.0.2','10.2.3.4','172.16.0.1','172.31.255.255','192.168.1.1','169.254.1.2','224.0.0.1','::','::1','fe80::1','febf::1','ff02::1','fc00::1','::ffff:10.1.1.1','::ffff:c0a8:0101'])('地址分类拒绝 %s', ip => expect(forbiddenAddress(ip)).toBe(true));
  it('get_image 刷新 URL 使用相同策略', async () => {
    await expect(downloadIncoming({ message: [{ type: 'image', data: { file: 'remote-id' } }] }, 'a'.repeat(64), tmp(),
      { call: async () => ({ url: base }) }, AbortSignal.timeout(1000), hooks)).rejects.toThrow('内部网络');
    expect(hits).toBe(0);
  });
});
describe('incoming 文件约束', () => {
  const event = { message: [{ type: 'image', data: { url: 'http://public.test' } }] };
  it('父目录越界在 mkdir 票据目录前拒绝', async () => {
    const root = tmp(), outside = tmp();
    await fs.symlink(outside, path.join(root, 'incoming'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(downloadIncoming(event, 'b'.repeat(64), root, { call: async () => ({}) }, AbortSignal.timeout(1000), hooks)).rejects.toThrow('越界');
    expect(await fs.readdir(outside)).toEqual([]); expect(hits).toBe(0);
  });
  it('恢复现有文件先检查类型及大小，拒绝目录', async () => {
    const root = tmp(), ticket = 'c'.repeat(64);
    await fs.mkdir(path.join(root, 'incoming', ticket, '1.png'), { recursive: true });
    await expect(downloadIncoming(event, ticket, root, { call: async () => ({}) }, AbortSignal.timeout(1000), hooks)).rejects.toThrow(/不安全|EISDIR|EPERM|EEXIST/);
  });
});
