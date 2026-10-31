import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { channelDown, parseFrame, type SendReceipt } from "./onebot";
import { cleanName, id, inboundKey, isAllowed, isRecord, isTriggered, policyFrom, scopeOf, threadKey, type InboundInput, type Target, ownerIds } from "./policy";
import { SendRules } from "./send-rules";
import { effectiveSettings, type SettingsSnapshot } from "./settings";
import { DeliveryStore, type AuthorizedQqIntent, type SystemQqIntent, type DeliveryState, type Delivery, type DeliverySource } from "./delivery";
import { MediaRepository, type AssetRef } from "./media/repository";
import { FILE_MAX_BYTES, validScope } from "./media/model";

type Attachment = { id: string; active: boolean };
type Pending = { socket: WebSocket; resolve: (data: unknown) => void; reject: (error: Error) => void };
type GroupName = { name: string; expires: number };

export class BridgeDO extends DurableObject<Env> {
  // echo 与发送事实持久化；内存 Promise 仅用于等待本次连接的响应。
  private readonly ledger = new DeliveryStore(this.ctx.storage);
  private readonly sending = new Map<string, Promise<Delivery>>();
  private readonly runSending = new Map<string, Promise<Delivery>>();
  private readonly pending = new Map<string, Pending>();
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly groupQueries = new Map<string, Promise<string | undefined>>();
  private readonly rules = new SendRules(this.ctx.storage);
  // 设置只在内存缓存；面板保存后经 reloadSettings 推送，DO 重建时重新拉取。
  private settingsLoad?: Promise<SettingsSnapshot>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS seen (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS threads (key TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
    `);
  }

  private activeSocket(): WebSocket | undefined {
    return this.ctx.getWebSockets().find(socket => {
      const attachment: Attachment | null = socket.deserializeAttachment();
      return attachment?.active === true && socket.readyState === WebSocket.OPEN;
    });
  }

  override fetch(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("websocket required", { status: 426 });
    for (const socket of this.ctx.getWebSockets()) {
      this.disconnect(socket);
      socket.close(1000, "replaced");
    }
    const { 0: client, 1: server } = new WebSocketPair();
    server.serializeAttachment({ id: crypto.randomUUID(), active: true } satisfies Attachment);
    this.ctx.acceptWebSocket(server);
    this.ctx.waitUntil(this.connected().catch(()=>{ console.error({event:"bridge_connected_tick_failed"}); }));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const frame = parseFrame(raw);
    if (!frame) return;
    if (frame.kind === "response") {
      const attachment: Attachment | null = socket.deserializeAttachment();
      const stored = this.ledger.byEcho(frame.echo);
      if (stored && attachment?.id === stored.connectionId) {
        const messageId = isRecord(frame.data) ? id(frame.data.message_id) : "";
        const uploaded = stored.intent?.attachments?.[0]?.kind === "file";
        if (frame.ok && (messageId || uploaded)) this.ledger.settle(stored.receipt.id,"sent",messageId || undefined);
        else if (frame.ok) this.ledger.settle(stored.receipt.id,"unknown",undefined,"onebot_failed: 回执缺少消息 ID，请先核实，不要重试");
        else this.ledger.settle(stored.receipt.id,"failed",undefined,"onebot_failed: API 未成功，请先核实，不要重试");
      }
      const pending = this.pending.get(frame.echo);
      if (pending?.socket === socket) {
        if (frame.ok) pending.resolve(frame.data);
        else pending.reject(new Error("onebot_failed: API 未成功，请先核实，不要重试"));
      }
      return;
    }
    if (socket !== this.activeSocket()) return;
    switch (frame.kind) {
      case "meta":
        if (frame.selfId) await this.ctx.storage.put("selfId", frame.selfId);
        return;
      case "message":
        await this.acceptInput(frame.input,true);
        return;
      case "notice": {
        if(frame.notice.kind==="upload") { await this.acceptInput(frame.notice.input,false); return; }
        const notice=frame.notice;
        const input:InboundInput={...notice,kind:"message",nickname:"",text:"",routeText:"",mentionedSelf:false,replyToId:null,imageCount:0};
        const policy=policyFrom(this.env,effectiveSettings(this.env,(await this.loadSettings()).overrides));
        if(!isAllowed(policy,input))return;
        const thread=threadKey(policy,input),target=this.env.THREAD.getByName(thread);
        this.enqueue(thread,async()=>{
          if("markRecalled"in target&&typeof target.markRecalled==="function")await target.markRecalled(scopeOf(notice.target),notice.messageId);
        },()=>console.error({event:"recall_failed",messageId:notice.messageId}));
        return;
      }
    }
  }

  private async acceptInput(input:InboundInput,allowTrigger:boolean):Promise<void>{
    const policy=policyFrom(this.env,effectiveSettings(this.env,(await this.loadSettings()).overrides));
    if(!isAllowed(policy,input)){
      await this.ctx.storage.transaction(async tx=>{await tx.put("ignored",(await tx.get<number>("ignored")??0)+1);});return;
    }
    await this.ctx.storage.put("selfId",input.selfId);
    const key=inboundKey(input),thread=threadKey(policy,input);
    const inserted=this.ctx.storage.transactionSync(()=>{
      const added=this.ctx.storage.sql.exec("INSERT OR IGNORE INTO seen (key) VALUES (?) RETURNING key",key).toArray().length>0;
      this.ctx.storage.sql.exec("DELETE FROM seen WHERE id NOT IN (SELECT id FROM seen ORDER BY id DESC LIMIT 5000)");
      this.ctx.storage.sql.exec("INSERT INTO threads (key,seen_at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET seen_at=excluded.seen_at",thread,Date.now());return added;
    });
    if(!inserted)return;
    this.enqueue(thread,async()=>{
      if(input.target.kind==="group")input.scopeName=await this.groupName(input.target.groupId);
      const target=this.env.THREAD.getByName(thread),{repliedToSelf}=await target.ingest(input);
      if(allowTrigger&&(input.text.trim()||input.media?.length)&&isTriggered(policy,input,repliedToSelf)){
        this.ctx.waitUntil(target.submit(input).catch(()=>console.error({event:"submit_failed",messageId:input.messageId,length:input.text.length})));
      }
    },()=>{
      this.ctx.storage.sql.exec("DELETE FROM seen WHERE key=?",key);
      console.error({event:"ingest_failed",messageId:input.messageId,length:input.text.length});
    });
  }
  private enqueue(thread:string,operation:()=>Promise<void>,failed:()=>void):void{
    // 回执不等待入库；同线程的上传、聊天与撤回按到达顺序串行处理。
    const delivery=(this.deliveries.get(thread)??Promise.resolve()).then(operation).catch(failed);
    this.deliveries.set(thread,delivery);
    this.ctx.waitUntil(delivery.finally(()=>{if(this.deliveries.get(thread)===delivery)this.deliveries.delete(thread);}));
  }

  private loadSettings(): Promise<SettingsSnapshot> {
    return this.settingsLoad ??= this.env.REGISTRY.getByName("main").settings().catch(error => {
      this.settingsLoad = undefined;
      throw error;
    });
  }

  async reloadSettings(): Promise<string> {
    this.settingsLoad = undefined;
    return (await this.loadSettings()).revision;
  }

  async threadList(): Promise<{ key: string; seenAt: number; name?: string }[]> {
    const rows = this.ctx.storage.sql.exec<{ key: string; seen_at: number }>("SELECT key, seen_at FROM threads ORDER BY seen_at DESC, key LIMIT 50").toArray();
    const names = await this.ctx.storage.get<GroupName>(rows.filter(row => row.key.startsWith("group:")).map(row => row.key));
    return rows.map(row => {
      const name = names.get(row.key)?.name;
      return { key: row.key, seenAt: row.seen_at, ...(name ? { name } : {}) };
    });
  }

  releaseSendRule(scope: string): { released: boolean } {
    return { released: this.rules.release(scope) };
  }

  private groupName(groupId: string): Promise<string | undefined> {
    const existing = this.groupQueries.get(groupId);
    if (existing) return existing;
    const query = (async () => {
      const cached = await this.ctx.storage.get<GroupName>(`group:${groupId}`);
      if (cached && cached.expires > Date.now()) return cached.name || undefined;
      let name = cached?.name;
      try {
        const result = await this.call("get_group_info", { group_id: groupId });
        if (isRecord(result) && typeof result.group_name === "string") name = cleanName(result.group_name);
      } catch {
        // 查名失败仍处理聊天；短暂负缓存避免每条群消息都再等待 15 秒。
        await this.ctx.storage.put(`group:${groupId}`, { name: name ?? "", expires: Date.now() + 60_000 } satisfies GroupName);
        return name;
      }
      await this.ctx.storage.put(`group:${groupId}`, { name: name ?? "", expires: Date.now() + 6 * 3600_000 } satisfies GroupName);
      return name;
    })();
    this.groupQueries.set(groupId, query);
    return query.finally(() => { this.groupQueries.delete(groupId); });
  }

  async send(target: Target, text: string, atUserId?: string): Promise<SendReceipt> {
    if (!this.activeSocket()) throw channelDown();
    if(text.length<1||text.length>4000)throw new Error("send_rule: 单条文字必须为 1～4000 字符");
    const id = `legacy:${crypto.randomUUID()}`;
    const receipt=await this.systemDeliver({ id,operationAt:Date.now(),runId:id,target,text,...(atUserId?{atUserId}:{}) });
    if (receipt.state!=="sent" || !receipt.messageId) throw new Error(receipt.error ?? (receipt.state==="queued"?"channel_down":`onebot_${receipt.state}: API 结果不确定，请先核实，不要重试`));
    return { message_id:receipt.messageId };
  }

  async sendPrivate(userId: string, text: string): Promise<SendReceipt> { return this.send({ kind:"private",userId },text); }

  async deliver(input: AuthorizedQqIntent): Promise<Delivery> {
    if (!input.source) throw new Error("delivery_source_required");
    return this.systemDeliver(input);
  }
  async systemDeliver(input: SystemQqIntent): Promise<Delivery> {
    const stored=this.ledger.create(input);
    if(stored.receipt.state!=="queued")return stored.receipt;
    const existing=this.sending.get(input.id);if(existing)return existing;
    const runKey=JSON.stringify([input.runId,scopeOf(input.target)]),previous=this.runSending.get(runKey);
    const pending=previous?previous.catch(()=>undefined).then(()=>this.dispatch(input.id)):this.dispatch(input.id);
    this.sending.set(input.id,pending);this.runSending.set(runKey,pending);
    return pending.finally(()=>{
      if(this.sending.get(input.id)===pending)this.sending.delete(input.id);
      if(this.runSending.get(runKey)===pending)this.runSending.delete(runKey);
    });
  }
  delivery(id: string): Delivery | undefined { return this.ledger.get(id)?.receipt; }
  deliveryList(input:{state?:DeliveryState;limit?:number}={}): Delivery[] { return this.ledger.list(input); }
  cancelQueued(input:{thread:string;generation:number}): { cancelled:number } { return {cancelled:this.ledger.cancelQueued(input)}; }

  private async sourceValid(source:DeliverySource,target:Target):Promise<boolean>{
    const thread=this.env.THREAD.getByName(source.thread);
    // 基线旧 Thread 没有该 RPC 时拒绝发送；集成后由宿主查持久 input 和当前授权。
    if (!("validateDeliverySource" in thread) || typeof thread.validateDeliverySource!=="function")return false;
    try { return await thread.validateDeliverySource(source,target) === true; } catch { return false; }
  }
  private async dispatch(deliveryId:string):Promise<Delivery>{
    let stored=this.ledger.required(deliveryId);const input=stored.intent;
    if(!input)return stored.receipt;
    if(stored.receipt.state!=="queued")return stored.receipt;
    if(!this.activeSocket())return stored.receipt;
    try{
      const files=input.attachments?.filter(asset=>asset.kind==="file")??[];
      if(files.length && (files.length!==1 || input.attachments?.length!==1 || input.text.trim() || input.atUserId))return this.ledger.settle(deliveryId,"rejected",undefined,"file_delivery_requires_single_attachment");
      const media: {type:string;data:Record<string,string>}[]=[];
      for(const asset of input.attachments??[]){
        if(!input.source || asset.scope!==input.source.thread) return this.ledger.settle(deliveryId,"rejected",undefined,"asset_scope_denied");
        const repository=new MediaRepository({bucket:this.env.ASSETS,scope:input.source.thread});
        const current=await repository.get(asset.id);
        if(!current || current.ref.sha256!==asset.sha256 || current.ref.kind!==asset.kind || current.ref.bytes!==asset.bytes || current.ref.mime!==asset.mime || current.ref.name!==asset.name)return this.ledger.settle(deliveryId,"rejected",undefined,"asset_reference_mismatch");
        const url=await repository.issueUrl(asset.id,this.env.PUBLIC_ORIGIN,300);
        media.push({type:asset.kind==="audio"?"record":asset.kind,data:{file:url}});
      }
      const ops=(await this.env.REGISTRY.getByName("main").opsSettings()).value;
      if(input.purpose==="owner_alert"&&(!ops.alertOwner||input.target.kind!=="private"||!ownerIds(this.env).includes(input.target.userId)))return this.ledger.settle(deliveryId,"rejected",undefined,"owner_alert_disabled");
      const limits=ops.sendLimits,selfId=await this.ctx.storage.get<string>("selfId");
      if(input.source && !(await this.sourceValid(input.source,input.target)))return this.ledger.settle(deliveryId,"rejected",undefined,"delivery_source_revoked");
      stored=this.ledger.required(deliveryId);if(stored.receipt.state!=="queued")return stored.receipt;
      const socket=this.activeSocket();if(!socket)return stored.receipt;
      const attachment:Attachment|null=socket.deserializeAttachment();if(!attachment)return stored.receipt;
      const rejected=this.rules.accept(scopeOf(input.target),input.text || `[附件:${input.attachments?.map(asset=>asset.sha256).join(",")}]`,Date.now(),limits);
      if(rejected)return this.ledger.settle(deliveryId,"rejected",undefined,`send_rule: ${rejected}`);
      const echo=crypto.randomUUID();stored=this.ledger.begin(deliveryId,echo,attachment.id,input.target,selfId);
      if(stored.receipt.state!=="sending")return stored.receipt;
      const message=[...(stored.mention&&input.atUserId?[{type:"at",data:{qq:input.atUserId}}]:[]),...(input.text?[{type:"text",data:{text:input.text}}]:[]),...media];
      const target=input.target.kind==="group"?{group_id:input.target.groupId}:{user_id:input.target.userId};
      const file=files[0],action=file?(input.target.kind==="group"?"upload_group_file":"upload_private_file"):(input.target.kind==="group"?"send_group_msg":"send_private_msg");
      const params=file?{...target,file:media[0]?.data.file,name:file.name}:{...target,message};
      try{
        const result=await this.call(action,params,echo);
        // 真实 WebSocket 回执先更新账本；仅成功的文件上传 ACK 可以没有消息 ID。
        const receipt=this.ledger.required(deliveryId).receipt;
        if(receipt.state!=="sending")return receipt;
        const messageId=isRecord(result)?id(result.message_id):"";
        return messageId||file?this.ledger.settle(deliveryId,"sent",messageId||undefined):this.ledger.settle(deliveryId,"unknown",undefined,"onebot_failed: 回执缺少消息 ID，请先核实，不要重试");
      }catch(error){
        const receipt=this.ledger.required(deliveryId).receipt;if(receipt.state!=="sending")return receipt;
        return this.ledger.settle(deliveryId,"unknown",undefined,error instanceof Error?error.message:"onebot_unknown");
      }
    }catch(error){
      const receipt=this.ledger.required(deliveryId).receipt;
      return receipt.state==="queued"?this.ledger.settle(deliveryId,"failed",undefined,error instanceof Error?error.message:"delivery_failed"):receipt;
    }
  }

  /** 只读查证；只在平台 ID、本人身份、目标、时间窗口和完整段内容全部唯一匹配时结算。 */
  async reconcile(deliveryId:string):Promise<Delivery>{
    const stored=this.ledger.required(deliveryId);
    if(stored.receipt.state!=="unknown"||!stored.intent)return stored.receipt;
    const input=stored.intent;
    if(input.attachments?.length)return stored.receipt;
    const selfId=stored.senderId,attemptedAt=stored.attemptedAt;if(!selfId||attemptedAt===null)return stored.receipt;
    const target=input.target;
    const result=await this.call(target.kind==="group"?"get_group_msg_history":"get_friend_msg_history",target.kind==="group"?{group_id:target.groupId,count:100}:{user_id:target.userId,count:100});
    if(!isRecord(result)||!Array.isArray(result.messages))return stored.receipt;
    const matches=result.messages.filter((row:unknown)=>{
      if(!isRecord(row)||id(row.user_id)!==selfId||!id(row.message_id)||typeof row.time!=="number"||!Array.isArray(row.message))return false;
      const at=row.time*1000;if(at<attemptedAt-1000||at>attemptedAt+15000)return false;
      if(target.kind==="group"?id(row.group_id)!==target.groupId:id(row.target_id||row.peer_id||row.user_id)!==target.userId)return false;
      const expected=[...(stored.mention&&input.atUserId?[{type:"at",data:{qq:input.atUserId}}]:[]),{type:"text",data:{text:input.text}}];
      return JSON.stringify(row.message)===JSON.stringify(expected);
    });
    // 同一内容的其他 intent 也可能命中；此时证据不能归属到某个唯一副作用。
    const siblings=this.ledger.list({limit:200}).filter(row=>row.id!==deliveryId&&row.createdAt>=stored.receipt.createdAt-30000&&row.createdAt<=stored.receipt.updatedAt+30000)
      .some(row=>{const other=this.ledger.required(row.id).intent;return JSON.stringify(other?.target)===JSON.stringify(target)&&other?.text===input?.text;});
    const match=matches[0];
    return matches.length===1&&!siblings&&isRecord(match)?this.ledger.settle(deliveryId,"sent",id(match.message_id)):stored.receipt;
  }
  async chats(refresh=false):Promise<{target:Target;name:string}[]>{
    const cached=await this.ctx.storage.get<{expires:number;items:{target:Target;name:string}[]}>("qq_chats");
    if(cached&&cached.expires>Date.now()&&!refresh)return cached.items;
    const items:{target:Target;name:string}[]=[];
    for(const kind of ["friend","group"]){
      const result=await this.call(kind==="friend"?"get_friend_list":"get_group_list",{});
      if(!Array.isArray(result))continue;
      for(const row of result){if(!isRecord(row))continue;
        const key=id(kind==="friend"?row.user_id:row.group_id);if(!key)continue;
        items.push({target:kind==="friend"?{kind:"private",userId:key}:{kind:"group",groupId:key},name:cleanName(String(kind==="friend"?row.remark||row.nickname||key:row.group_name||key))});
      }
    }
    await this.ctx.storage.put("qq_chats",{expires:Date.now()+300000,items});return items;
  }
  getMessage(messageId:string):Promise<unknown>{if(!/^-?\d{1,20}$/.test(messageId))throw new Error("invalid_message_id");return this.call("get_msg",{message_id:messageId});}
  getHistory(target:Target,count=20):Promise<unknown>{if(!Number.isInteger(count)||count<1||count>100)throw new Error("invalid_history_limit");return this.call(target.kind==="group"?"get_group_msg_history":"get_friend_msg_history",target.kind==="group"?{group_id:target.groupId,count}:{user_id:target.userId,count});}
  async getFileUrl(target:Target,fileId:string,busid=102):Promise<string>{
    if(!fileId||fileId.length>512||!Number.isInteger(busid)||busid<0)throw new Error("invalid_file_reference");
    const result=await this.call(target.kind==="group"?"get_group_file_url":"get_private_file_url",target.kind==="group"?{group_id:target.groupId,file_id:fileId,busid}:{user_id:target.userId,file_id:fileId});
    return this.mediaUrl(result);
  }
  /** QQ 图片由本机下载，经 OneBot 回传内容；不使用返回的 QQ URL。 */
  async getImage(file: string, scope: string): Promise<AssetRef> {
    this.validMediaFile(file);
    validScope(scope);
    const result = await this.call("get_image", { file });
    if (!isRecord(result) || typeof result.base64 !== "string" || !result.base64) throw new Error("napcat_image_content_missing");
    if (result.base64.length > Math.ceil(FILE_MAX_BYTES / 3) * 4) throw new Error("too_large");
    let binary: string;
    try { binary = atob(result.base64); } catch { throw new Error("invalid_image_content"); }
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new MediaRepository({ bucket: this.env.ASSETS, scope }).put({
      bytes, kind: "image", name: typeof result.file_name === "string" ? result.file_name : "image",
    });
  }
  async getRecord(file:string):Promise<string>{this.validMediaFile(file);return this.mediaUrl(await this.call("get_record",{file,out_format:"mp3"}));}
  async getFile(file:string):Promise<string>{this.validMediaFile(file);return this.mediaUrl(await this.call("get_file",{file}));}
  private validMediaFile(file:string):void{if(!file||file.length>8192||/[\x00-\x1f\x7f]/.test(file))throw new Error("invalid_media_reference");}
  private mediaUrl(result:unknown):string{
    if(isRecord(result)&&typeof result.url==="string"){
      try{const url=new URL(result.url);if((url.protocol==="https:"||url.protocol==="http:")&&!url.username&&!url.password)return url.href;}catch{}
    }
    throw new Error("media_url_unavailable");
  }
  getForward(id:string):Promise<unknown>{if(!id||id.length>200)throw new Error("invalid_forward_id");return this.call("get_forward_msg",{id});}

  private async connected():Promise<void>{
    const at=await this.ctx.storage.get<number>("disconnectedAt");
    await this.ctx.storage.delete("disconnectedAt");
    await this.env.REGISTRY.getByName("main").resolveAlert("qq_disconnect","bridge","qq");
    if(at!==undefined&&Date.now()-at>=300000)await this.env.REGISTRY.getByName("main").recordAlert({kind:"qq_disconnect",scope:"bridge",episode:`recovered:${at}`,origin:"qq",message:`QQ 连接已恢复；此前中断约 ${Math.ceil((Date.now()-at)/60000)} 分钟。`});
    await this.tick();
  }
  async tick():Promise<void>{
    this.ledger.prune();
    if(!this.activeSocket()){
      let at=await this.ctx.storage.get<number>("disconnectedAt");
      if(at===undefined){at=Date.now();await this.ctx.storage.put("disconnectedAt",at);}
      if(Date.now()-at>=300000)await this.env.REGISTRY.getByName("main").recordAlert({kind:"qq_disconnect",scope:"bridge",episode:String(at),origin:"qq",message:"QQ 连接已中断超过五分钟，请检查 NapCat 与网络。"});
      return;
    }
    for(const row of this.ledger.list({state:"queued",limit:20})){const stored=this.ledger.required(row.id);if(stored.intent)await this.systemDeliver(stored.intent);}
  }

  private async call(action: string, params: object, requestedEcho?:string): Promise<unknown> {
    const socket = this.activeSocket();
    if (!socket) throw channelDown();
    const echo = requestedEcho ?? crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        this.pending.set(echo, { socket, resolve, reject });
        timer = setTimeout(() => reject(new Error("onebot_timeout: API 结果不确定，请先核实，不要重试")), 15_000);
        socket.send(JSON.stringify({ action, params, echo }));
      });
    } finally {
      // 计时器只在有在途 API 时存在，结算后清理，空闲 Bridge 才能休眠。
      if (timer !== undefined) clearTimeout(timer);
      this.pending.delete(echo);
    }
  }

  async status() {
    return { connected: this.activeSocket() !== undefined,
      selfId: await this.ctx.storage.get<string>("selfId"),
      ignored: await this.ctx.storage.get<number>("ignored") ?? 0,
      threads: this.ctx.storage.sql.exec<{ key: string }>("SELECT key FROM threads ORDER BY seen_at DESC, key LIMIT 50").toArray().map(row => row.key),
      deliveryStorage:this.ledger.stats(),sendRules: this.rules.breakers() };
  }

  threadKeys(): string[] {
    return this.ctx.storage.sql.exec<{ key: string }>("SELECT key FROM threads ORDER BY key").toArray().map(row => row.key);
  }

  private disconnect(socket: WebSocket): void {
    const attachment: Attachment | null = socket.deserializeAttachment();
    if (attachment) socket.serializeAttachment({ ...attachment, active: false });
    if(attachment?.active)this.ctx.waitUntil(this.ctx.storage.put("disconnectedAt",Date.now()));
    for (const pending of this.pending.values()) {
      if (pending.socket === socket) pending.reject(new Error("onebot_disconnected: API 结果不确定，请先核实，不要重试"));
    }
  }
  override webSocketClose(socket: WebSocket, code: number): void {
    this.disconnect(socket);
    socket.close(code === 1005 || code === 1006 ? 1000 : code);
  }
  override webSocketError(socket: WebSocket): void {
    this.disconnect(socket);
    socket.close(1011, "websocket error");
  }
}
