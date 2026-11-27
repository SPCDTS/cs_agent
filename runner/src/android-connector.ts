import {request} from 'node:http';
import {WebSocket} from 'ws';
import {androidTools,bearerPattern,maxFrame,textLimit,validCall} from './android-protocol.ts';

export function phoneConfig(env:NodeJS.ProcessEnv){
  const endpoint=new URL(env.ANDROID_RELAY_URL??'');
  const token=env.ANDROID_RELAY_TOKEN??'', arc=env.ARC_TOKEN??'', slug=env.ARC_SLUG??'';
  const port=Number(env.ARC_PORT??8080);
  if(endpoint.protocol!=='wss:' || endpoint.pathname!=='/android/connect' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password ||
     !bearerPattern.test(token) || !arc || arc===token || /[^\x21-\x7e]/.test(arc) || arc.length>1024 || !/^[a-zA-Z0-9_]{0,20}$/.test(slug) ||
     !Number.isInteger(port)||port<1||port>65535)throw Error('invalid_phone_config');
  return {endpoint,token,port,arc,slug};
}
type Config=ReturnType<typeof phoneConfig>;
// 数字 loopback + 固定路径，不使用系统代理、不跟随重定向，也不重试 POST。
export function localArc(config:Config,signal:AbortSignal){
  let serial=0,version='2025-11-25';
  const wire=(name:string)=>name.replace(/^android_/,config.slug?'android_'+config.slug+'_':'android_');
  async function rpc(method:string,params:object,notification=false){
    const id=++serial;
    const body=JSON.stringify({jsonrpc:'2.0',...(!notification&&{id}),method,params});
    const response=await new Promise<import('node:http').IncomingMessage>((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port:config.port,path:'/mcp',method:'POST',agent:false,
        signal:AbortSignal.any([signal,AbortSignal.timeout(10_000)]),headers:{Authorization:'Bearer '+config.arc,'Content-Type':'application/json',
        Accept:'application/json, text/event-stream','MCP-Protocol-Version':version}},resolve);
      req.on('error',reject);req.end(body);
    });
    if(notification && response.statusCode===202){response.destroy();return;}
    if(response.statusCode!==200 || !/^application\/json\b/i.test(response.headers['content-type']??'')){response.destroy();throw Error('arc_protocol');}
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of response){size+=chunk.length;if(size>512*1024)throw Error('arc_size');chunks.push(chunk);}
    const data=JSON.parse(Buffer.concat(chunks).toString());
    if(data.jsonrpc!=='2.0'||data.id!==id||!data.result||data.error)throw Error('arc_protocol');
    return data.result;
  }
  return {
    async ready(){
      const init=await rpc('initialize',{protocolVersion:version,clientInfo:{name:'cs-agent-android',version:'1'},capabilities:{}});
      if(!['2025-11-25','2025-06-18','2025-03-26'].includes(init.protocolVersion)||!init.capabilities?.tools)throw Error('arc_version');
      version=init.protocolVersion;
      await rpc('notifications/initialized',{},true);
      const list=await rpc('tools/list',{});
      if(!Array.isArray(list.tools)||!androidTools.every(t=>list.tools.some((v:{name?:string})=>v?.name===wire(t.name))))throw Error('arc_tools_unavailable');
    },
    async call(name:string,args:unknown){
      if(!validCall(name,args))throw Error('android_denied');
      const result=await rpc('tools/call',{name:wire(name),arguments:args});
      if(result.isError || !Array.isArray(result.content) || !result.content.length || !result.content.every((p:{type?:string;text?:unknown})=>p?.type==='text'&&typeof p.text==='string'))throw Error('arc_result');
      const value=result.content.map((p:{text:string})=>p.text).join('\n');
      if(Buffer.byteLength(value)>textLimit)throw Error('arc_size');
      return value as string;
    },
  };
}
export async function connectOnce(config:Config,stop:AbortSignal){
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,stop]);
  const arc=localArc(config,signal);await arc.ready();signal.throwIfAborted();
  const ws=new WebSocket(config.endpoint,{headers:{Authorization:'Bearer '+config.token},followRedirects:false,
    handshakeTimeout:10_000,maxPayload:maxFrame,perMessageDeflate:false});
  try { await servePhone(ws,arc,stop); } finally { controller.abort(); }
}

export function servePhone(ws:WebSocket,arc:Pick<ReturnType<typeof localArc>,'call'>,stop:AbortSignal){
  return new Promise<void>(resolve=>{
    let seq=0,busy=false;
    const abort=()=>ws.terminate();
    stop.addEventListener('abort',abort,{once:true});
    ws.on('error',abort);
    ws.once('close',()=>{stop.removeEventListener('abort',abort);resolve();});
    ws.on('message',async(raw,binary)=>{
      try{
        const frame=JSON.parse(raw.toString());
        if(binary||busy||frame.seq!==seq+1||!validCall(frame.name,frame.args)){abort();return;}
        busy=true;++seq;
        let reply;
        try{reply={seq,text:await arc.call(frame.name,frame.args)};}catch{reply={seq,unknown:true};}
        if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(reply));
        busy=false;
      }catch{abort();}
    });
  });
}
