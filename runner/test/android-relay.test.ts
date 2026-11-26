import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {WebSocket} from 'ws';
import {AndroidRelay} from '../src/android-relay.ts';
import {phoneConfig,localArc,servePhone} from '../src/android-connector.ts';

const token='synthetic-'.repeat(5), space='android:fixture', stop=new AbortController().signal;
const env={ANDROID_RELAY_URL:'wss://relay.invalid/android/connect',ANDROID_RELAY_TOKEN:token,ARC_TOKEN:'fixture-local',ARC_SLUG:'demo'};
test('ARC 使用本机 JSON-only MCP 握手、独立认证和带 slug 的白名单工具；不随重定向',async t=>{
  const calls:string[]=[];
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer fixture-local');assert.equal(req.url,'/mcp');
    let body='';for await(const c of req)body+=c;
    const v=JSON.parse(body);let result;
    if(v.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}}};
    else if(v.method==='notifications/initialized'){res.writeHead(202).end();return;}
    else if(v.method==='tools/list')result={tools:['get_screen_state','click_node'].map(s=>({name:'android_demo_'+s}))};
    else {
      calls.push(v.params.name);
      if(v.params.name==='android_demo_click_node'){
        assert.deepEqual(v.params.arguments,{node_id:'node_12'});
        res.writeHead(307,{location:'/wrong'}).end();return;
      }
      result={content:[{type:'text',text:'node_12'}]};
    }
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:v.id,result}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const arc=localArc(phoneConfig({...env,ARC_PORT:String((server.address() as AddressInfo).port)}),stop);
  await arc.ready();assert.equal(await arc.call('android_get_screen_state',{}),'node_12');
  await assert.rejects(arc.call('android_click_node',{node_id:'node_12'}));
  await assert.rejects(arc.call('android_get_screen_state',{include_screenshot:true}));
  assert.deepEqual(calls,['android_demo_get_screen_state','android_demo_click_node']);
  assert.throws(()=>phoneConfig({...env,ANDROID_RELAY_URL:'ws://relay.invalid/android/connect'}));
});
test('设备身份仅由凭据决定；在途断连或超时不将点击送往替代连接',async t=>{
  const relay=new AndroidRelay({[space]:createHash('sha256').update(token).digest('hex')});
  relay.http.listen(0,'127.0.0.1');await once(relay.http,'listening');t.after(()=>relay.close());
  const dial=(cred:string)=>new WebSocket('ws://127.0.0.1:'+(relay.http.address() as AddressInfo).port+'/android/connect',{headers:{Authorization:'Bearer '+cred}});
  await assert.rejects(once(dial('wrong'),'open'));
  const first=dial(token);await once(first,'open');await assert.rejects(once(dial(token),'open'));
  const call={space,service:'driver',tool:'android_click_node',arguments:{node_id:'node_12'}};
  await assert.rejects(relay.call('space_bash',call,stop));
  const received=once(first,'message');
  const lost=assert.rejects(relay.call('call_tool',call,stop),/outcome_unknown/);
  const [msg]=await received;assert.equal(JSON.parse(String(msg)).seq,1);
  first.terminate();await lost;
  const next=dial(token);await once(next,'open');
  assert.deepEqual(relay.cards(),[{id:space,name:space,os:'android',status:'online'}]);
  const frames:string[]=[];
  const stopped=servePhone(next,{async call(name){
    frames.push(name);
    if(name==='android_get_screen_state')return 'fixture UI';
    // 手势已分发，但模拟本机回执丢失。
    return new Promise(resolve=>next.once('close',()=>resolve('late reply')));
  }},stop);
  assert.deepEqual((await relay.call('call_tool',{...call,tool:'android_get_screen_state',arguments:{}},stop)).content,[{type:'text',text:'fixture UI'}]);
  await assert.rejects(relay.call('call_tool',call,stop,35),/outcome_unknown/);
  await stopped;assert.deepEqual(frames,['android_get_screen_state','android_click_node']);
});
