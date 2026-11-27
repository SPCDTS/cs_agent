import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {WebSocketServer, WebSocket} from 'ws';
import {androidTools,bearerPattern,idPattern,maxFrame,textLimit,validCall} from './android-protocol.ts';

type Peer = {ws:WebSocket; seq:number; pending?:(v?:string)=>void};
export class AndroidRelay {
  private devices = new Map<string,string>();
  private peers = new Map<string,Peer>();
  readonly http = createServer((_req,res)=>res.writeHead(404).end());
  private sockets = new WebSocketServer({noServer:true,maxPayload:maxFrame,perMessageDeflate:false});
  constructor(entries:unknown) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length > 64) throw Error('invalid_android_registry');
    for (const [id,hash] of Object.entries(entries)) {
      if (!idPattern.test(id) || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash) || this.devices.has(hash)) throw Error('invalid_android_registry');
      this.devices.set(hash,id);
    }
    this.http.on('upgrade',(req,socket,head)=>{
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      const id = token && bearerPattern.test(token) && this.devices.get(createHash('sha256').update(token).digest('hex'));
      if (!id || req.url !== '/android/connect' || req.headers.origin || this.peers.has(id)) { socket.destroy(); return; }
      this.sockets.handleUpgrade(req,socket,head,ws=>{
        const peer:Peer = {ws,seq:0};
        this.peers.set(id,peer);
        let alive=true;
        const heartbeat=setInterval(()=>{ if (!alive) ws.terminate(); else {alive=false;ws.ping();} },30_000);
        ws.on('pong',()=>{alive=true;});
        ws.on('error',()=>ws.terminate());
        ws.on('close',()=>{clearInterval(heartbeat);peer.pending?.();if(this.peers.get(id)===peer)this.peers.delete(id);});
        ws.on('message',(raw,binary)=>{
          try {
            if(binary) throw Error();
            const v=JSON.parse(raw.toString());
            if(!peer.pending || v.seq!==peer.seq) throw Error();
            if(v.unknown===true) peer.pending();
            else if(typeof v.text==='string' && Buffer.byteLength(v.text)<=textLimit) peer.pending(v.text);
            else throw Error();
          } catch {ws.terminate();}
        });
      });
    });
  }
  cards(){return Array.from(this.devices.values(),id=>({id,name:id,os:'android',status:this.peers.has(id)?'online':'offline'}));}
  async call(name:string,a:Record<string,unknown>,signal:AbortSignal,timeout=15_000){
    const id=String(a.space);
    if(!this.cards().some(c=>c.id===id) || a.service!=='driver') throw Error('android_denied');
    if(name==='list_tools')return {content:[{type:'text' as const,text:JSON.stringify({service:'driver',tools:androidTools.filter(t=>t.name.includes(String(a.name??'')))})}]};
    if(name!=='call_tool'||!validCall(a.tool,a.arguments))throw Error('android_denied');
    const peer=this.peers.get(id);
    if(!peer || peer.pending || peer.ws.readyState!==WebSocket.OPEN)throw Error('android_unavailable');
    signal.throwIfAborted();
    const value=await new Promise<string>((resolve,reject)=>{
      const abort=()=>{peer.ws.terminate();finish();};
      const timer=setTimeout(abort,timeout);
      function finish(result?:string){
        clearTimeout(timer);signal.removeEventListener('abort',abort);delete peer!.pending;
        if(result===undefined)reject(Error('outcome_unknown'));else resolve(result);
      }
      peer.pending=finish;signal.addEventListener('abort',abort,{once:true});
      try{peer.ws.send(JSON.stringify({seq:++peer.seq,name:a.tool,args:a.arguments}),err=>{if(err)abort();});}
      catch{abort();}
    });
    return {content:[{type:'text' as const,text:value}]};
  }
  close(){for(const p of this.peers.values())p.ws.terminate();this.sockets.close();this.http.close();}
}
