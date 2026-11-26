import {setTimeout as delay} from 'node:timers/promises';
import {connectOnce,phoneConfig} from '../src/android-connector.ts';

async function main(){
  const config=phoneConfig(process.env),stop=new AbortController();
  process.once('SIGINT',()=>stop.abort());process.once('SIGTERM',()=>stop.abort());
  while(!stop.signal.aborted){
    try{await connectOnce(config,stop.signal);}catch{console.error('Android 连接不可用，请核对本机 ARC 与 Relay 配置。');}
    if(!stop.signal.aborted)await delay(3000+Math.random()*2000,undefined,{signal:stop.signal}).catch(()=>{});
  }
}
void main().catch(()=>{console.error('Android 连接器配置无效。');process.exitCode=1;});
