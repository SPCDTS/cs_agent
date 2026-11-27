import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
type Slot = {machineId:string; relayPort:number; directoryPort:number};
function slotsFor(capacity = '8'): Slot[] {
  const count = Number(capacity);
  if (!/^[1-9][0-9]{0,2}$/.test(capacity) || count > 100) throw new Error('invalid_pair_capacity');
  return Array.from({length:count}, (_, index) => ({
    machineId:'paired-' + (index + 1), relayPort:19101 + index, directoryPort:19201 + index,
  }));
}
const secret = () => randomBytes(32).toString('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Identity = { invitation:string; client:string; deviceToken:string };
export const pairMethod = 'joule/cua/pair';

export function pairingCaddy(section: string, capacity?: string) {
  const slots = slotsFor(capacity);
  switch (section) {
    case 'servers': return slots.map(s => `servers 127.0.0.1:${s.directoryPort} {\n protocols h1 h2 h2c\n}`).join('\n');
    case 'join': return slots.map(s => `import join ${s.machineId} ${s.relayPort}`).join('\n');
    case 'directory': return slots.map(s => `http://127.0.0.1:${s.directoryPort} {\n import device-execution ${s.machineId} ${s.relayPort}\n import directory ${s.machineId} ${s.relayPort}\n}`).join('\n');
    default: throw new Error('invalid_section');
  }
}

/** 每个槽位永久绑定一次。先写完私有目录再原子发布，重启时按原端口恢复。 */
export class PairingSlots {
  readonly root: string;
  readonly relay: string;
  readonly slots: readonly Slot[];
  constructor(root: string, relay: string, capacity?: string) {
    this.slots = slotsFor(capacity);
    const url = new URL(relay);
    if (!/^wss:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?$/.test(url.origin) || url.origin + '/' !== url.href || url.username || url.password) throw new Error('invalid_pair_relay');
    this.root = root;
    this.relay = url.origin;
    mkdirSync(root,{recursive:true,mode:0o700});
  }
  dir(s: Slot) { return join(this.root,s.machineId); }
  identity(s: Slot): Identity {
    const id: Identity = JSON.parse(readFileSync(join(this.dir(s),'identity.json'),'utf8'));
    if (!uuid.test(id.invitation) || !/^[0-9a-f]{64}$/.test(id.client) || !/^[0-9a-f]{64}$/.test(id.deviceToken)) throw new Error('invalid_identity');
    return id;
  }
  request(params: Record<string,unknown>) {
    const free = this.slots.find(s => !existsSync(this.dir(s)));
    if (params.action === 'ready') return {status:free ? 'ready' : 'full'};
    const {invitation,client} = params;
    if (params.action !== 'claim' || typeof invitation !== 'string' || !uuid.test(invitation) ||
        typeof client !== 'string' || !/^[0-9a-f]{64}$/.test(client)) return {status:'invalid'};
    let slot = this.slots.find(s => existsSync(this.dir(s)) && this.identity(s).invitation === invitation);
    if (!slot) {
      if (!free) return {status:'full'};
      const tmp = mkdtempSync(join(this.root,'.pending-'));
      try {
        writeFileSync(join(tmp,'identity.json'),JSON.stringify({invitation,client,deviceToken:secret()}),{mode:0o600});
        writeFileSync(join(tmp,'registration.token'),secret()+'\n',{mode:0o600});
        renameSync(tmp,this.dir(free));
      } finally { rmSync(tmp,{recursive:true,force:true}); }
      slot = free;
    }
    const id = this.identity(slot);
    if (id.client !== client || existsSync(join(this.dir(slot),'retired'))) return {status:'used'};
    const registration = readFileSync(join(this.dir(slot),'registration.token'),'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(registration)) throw new Error('invalid_registration');
    return {status:'ok',relay:this.relay,machineId:slot.machineId,registration,deviceToken:id.deviceToken};
  }
}

export function startPairedRelays(store: PairingSlots, socketPath: string, stop: AbortSignal) {
  const children = new Map<Slot,ChildProcess>();
  const retry = new Map<Slot,{at:number,delay:number}>();
  let busy = false;
  async function reconcile() {
    if (busy || stop.aborted) return;
    busy = true;
    try {
      for (const s of store.slots) {
        if (stop.aborted) break;
        const dir = store.dir(s);
        if (!existsSync(dir)) continue;
        const child = children.get(s);
        if (existsSync(join(dir,'retired'))) { child?.kill(); continue; }
        if (!child) {
          const proc = spawn('/usr/local/bin/cua-relay',['--listen','127.0.0.1:'+s.relayPort,'--token-file',join(dir,'registration.token'),'--max-machines-per-token','1'],{stdio:'ignore',env:directoryEnv()});
          children.set(s,proc);
          proc.once('error',() => console.error('无法启动已配对设备的 Relay。'));
          proc.once('close',() => children.delete(s));
          continue;
        }
        const prior = retry.get(s);
        if (existsSync(join(dir,'registered')) || (prior && Date.now() < prior.at)) continue;
        try {
          await run('/usr/local/bin/cua',['--daemon',socketPath,'spaces','add',`http://127.0.0.1:${s.directoryPort}/m/${s.machineId}`],{
            timeout:5000,maxBuffer:65536,signal:stop,env:{...directoryEnv(),CUA_ENV_TOKEN:store.identity(s).deviceToken},
          });
          writeFileSync(join(dir,'registered'),'',{mode:0o600});
          retry.delete(s);
        } catch {
          const delay = Math.min(60_000,(prior?.delay ?? 2500)*2);
          retry.set(s,{at:Date.now()+delay,delay});
        }
      }
    } finally { busy = false; }
  }
  const tick = () => void reconcile().catch(() => console.error('无法恢复 Cua 配对状态。'));
  tick();
  const timer = setInterval(tick,5000);
  stop.addEventListener('abort',() => { clearInterval(timer); for (const proc of children.values()) proc.kill(); },{once:true});
}

function directoryEnv(): NodeJS.ProcessEnv {
  // 原生 CLI 无需访问反向桥的凭据。
  return {PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/var/lib/cs-agent-cua',CUA_HOME:'/var/lib/cs-agent-cua',
    CUA_CREDENTIAL_STORE:'file',CUA_MESH:'off',CUA_TELEMETRY:'0',DO_NOT_TRACK:'1',CUA_TELEMETRY_FORBID_NETWORK:'1',CUA_RELAY_URL:'http://127.0.0.1:1'};
}
