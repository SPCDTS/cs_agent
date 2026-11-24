import type { DeviceToolLabel } from "./config";
import { digest } from "./names";

/** 只由宿主附在已配对设备的工具定义上，远端描述和 schema 不参与命名。 */
export const deviceToolAlias = Symbol("deviceToolAlias");

export function deviceToolPresentation(device: DeviceToolLabel | undefined, action: string) {
  if (!device) return {};
  const suffix = /^[a-zA-Z0-9_]{1,80}$/.test(action) ? action
    : action.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64) + "_" + digest(action).slice(0, 12);
  return { [deviceToolAlias]: `mcp_${device.alias}_${suffix}` };
}

export function deviceToolNamespace(serverId: string, device?: DeviceToolLabel) {
  if (!device) return { name: serverId, description: "" };
  const desktop = serverId.endsWith("-desktop");
  return { name: `device/${device.alias}/${desktop ? "desktop" : "shell"}`, description: device.name };
}
