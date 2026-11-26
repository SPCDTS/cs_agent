// 手机和 Relay 各自验证同一份最小协议。禁止透传任意 ARC 工具、URL 或参数。
export const maxFrame = 192 * 1024;
export const textLimit = 24 * 1024;
export const idPattern = /^android:[a-z0-9][a-z0-9-]{0,47}$/;
const object = (v:unknown): v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const androidTools = [
  {name:'android_get_screen_state',description:'读取当前无障碍节点文本（不含截图）。',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'android_click_node',description:'点击刚读取的 node_id；结果未知时不要重试。',inputSchema:{type:'object',properties:{node_id:{type:'string',pattern:'^node_[a-zA-Z0-9_-]{1,64}$'}},required:['node_id'],additionalProperties:false}},
];
export function validCall(name:unknown,args:unknown): args is Record<string,unknown> {
  if (!object(args)) return false;
  return name === 'android_get_screen_state' ? !Object.keys(args).length :
    name === 'android_click_node' && Object.keys(args).length === 1 && typeof args.node_id === 'string' && /^node_[a-zA-Z0-9_-]{1,64}$/.test(args.node_id);
}
export const bearerPattern = /^[A-Za-z0-9._~-]{32,256}$/;
