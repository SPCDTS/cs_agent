import { createServer, request, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createQQBridge } from '../../src/qq/bridge.js';
import type { Channel, InboundMessage } from '../../src/channel/types.js';
import { normalizeMessage } from '../../src/qq/policy.js';
import { ReplyStore, inboundKey } from '../../src/qq/reply-store.js';
import { FakeOneBot, privateEvent, TOKEN, waitFor } from './fake-onebot.js';
import { tmp } from '../agent/helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let bridge: Channel, bot: FakeOneBot, cdn: Server, dir: string, base: string;
let held: ServerResponse[], received: InboundMessage[], active: number, peak: number;
const picture = (user: string, id: string) => privateEvent(user, '', { message_id: id, message: [{ type: 'text', data: { text: '改图' } }, { type: 'image', data: { url: 'http://public.test/hold', file: id } }] });
function makeBridge(deadline = 2000) {
  const b = createQQBridge({ httpUrl: bot.httpUrl, wsUrl: bot.wsUrl, token: TOKEN, allowUsers: '*', allowGroups: [], groupMentions: true,
    dataDir: dir, imageRoot: path.join(dir, 'images'), incomingDownloadDeadlineMs: deadline, incomingDownloadConcurrency: 2 }, {
    downloadHooks: { resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      request: (url, options, cb) => request(new URL(url.pathname, base), { ...options, lookup: undefined }, cb) },
  });
  b.on('message', m => received.push(m)); return b;
}
beforeEach(async () => {
  dir = tmp(); held = []; received = []; active = 0; peak = 0;
  cdn = createServer((_req, res) => { held.push(res); active++; peak = Math.max(peak,active); res.on('close', () => active--); });
  await new Promise<void>(r => cdn.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}`;
  bot = new FakeOneBot(); await bot.start(); bridge = makeBridge(); await bridge.start(); await waitFor(() => bridge.status().ws_connected);
});
afterEach(async () => { held.forEach(r => r.end(PNG)); await bridge.stop(); await bot.stop(); cdn.closeAllConnections(); await new Promise<void>(r => cdn.close(() => r())); });
describe('持久化入站下载 worker', () => {
  it('A 下载时 B 文本立即接纳派发，同 scope 保序且下载前已落盘', async () => {
    const a = picture('20001','101'); bot.push(a); await waitFor(() => held.length === 1);
    const rec = bridge.inbox.getInbound(inboundKey(normalizeMessage(a)!));
    expect(rec?.attachments).toMatchObject([{ status: 'pending', file: '101', url: 'http://public.test/hold' }]);
    bot.push(privateEvent('20001','同 scope 后续', { message_id: '102' }));
    bot.push(privateEvent('20002','B 文本', { message_id: '103' }));
    await waitFor(() => received.length === 1);
    expect(received[0]!.message_id).toBe('103');
    expect(bridge.inbox.listInbound('queued').map(r => r.message_id)).toEqual(['101','102','103']);
    held[0]!.end(PNG); await waitFor(() => received.length === 3);
    expect(received.map(m => m.message_id)).toEqual(['103','101','102']);
  });
  it('全局最多 2 个下载，同 scope 最多 1 个', async () => {
    bot.push(picture('20001','201')); bot.push(picture('20001','202'));
    bot.push(picture('20002','203')); bot.push(picture('20003','204'));
    await waitFor(() => held.length === 2); expect(peak).toBe(2);
    held[0]!.end(PNG); await waitFor(() => held.length === 3);
    held[1]!.end(PNG); await waitFor(() => held.length === 4);
    held.slice(2).forEach(r => r.end(PNG)); await waitFor(() => received.length === 4);
    expect(peak).toBeLessThanOrEqual(2);
    expect(received.filter(m => m.user_id === '20001').map(m => m.message_id)).toEqual(['201','202']);
  });
  it('发送者在途上限 2，超额附件 skipped 并继续处理文本', async () => {
    for (const id of ['301','302','303']) bot.push(picture('20001',id));
    await waitFor(() => held.length === 1);
    const records = bridge.inbox.listInbound('queued');
    expect(records[2]?.attachments?.[0]?.status).toBe('skipped');
    held[0]!.end(PNG); await waitFor(() => held.length === 2); held[1]!.end(PNG);
    await waitFor(() => received.length === 3);
    expect(received[2]!.images).toEqual([]); expect(received[2]!.image_error).toBeUndefined();
  });
  it('票据总截止时间到达后 skipped，释放 worker 且继续同 scope', async () => {
    await bridge.stop(); bridge = makeBridge(80); await bridge.start(); await waitFor(() => bridge.status().ws_connected);
    bot.push(picture('20001','401')); bot.push(privateEvent('20001','后续', { message_id: '402' }));
    await waitFor(() => received.length === 2);
    expect(received.map(m => m.message_id)).toEqual(['401','402']);
    expect(received[0]!.attachments?.[0]).toMatchObject({ status: 'skipped', reason: '参考图下载超时，已跳过' });
    expect(received[0]!.image_error).toBeUndefined();
  });
  it('恢复不重置已落盘的下载截止时间', async () => {
    await bridge.stop(); const store = new ReplyStore(dir), m = normalizeMessage(picture('20001','601'))!;
    m.attachments = [{ status: 'pending', file: 'old', deadline: Date.now() - 1 }];
    const ticket = store.admit(m, 'private:' + m.user_id)!; store.close(); bridge = makeBridge();
    expect((await bridge.prepareIncoming!(ticket))?.attachments?.[0]?.status).toBe('skipped');
    expect(held).toHaveLength(0);
  });
  it('重启按持久化 file id 刷新并恢复 pending 附件，完成前不派发', async () => {
    await bridge.stop();
    const store = new ReplyStore(dir), m = normalizeMessage(picture('20001','501'))!;
    m.attachments = [{ status: 'pending', file: 'remote-file-id' }];
    const ticket = store.admit(m, 'private:' + m.user_id)!; store.close();
    bot.override = c => c.action === 'get_image' ? { body: { status: 'ok', retcode: 0, data: { url: 'http://public.test/hold' } } } : undefined;
    bridge = makeBridge();
    const ready = bridge.prepareIncoming!(ticket);
    await waitFor(() => held.length === 1);
    expect(bridge.inbox.getInbound(ticket)?.attachments[0]?.status).toBe('pending');
    expect(bot.calls.find(c => c.action === 'get_image')?.body).toEqual({ file: 'remote-file-id' });
    expect(received).toEqual([]);
    held[0]!.end(PNG);
    expect((await ready)?.attachments?.[0]?.status).toBe('ok');
    expect(bridge.inbox.getInbound(ticket)?.images).toHaveLength(1);
  });
});
