import type { DeviceService } from "../src/devices/contracts";

export function deviceServiceDetail(device: DeviceService) {
  const kind = device.capability === "shell" ? "设备命令行" : "设备桌面";
  return kind + " · " + device.id.slice(0, 8);
}

export function serviceLabel(id: string, device?: DeviceService) {
  return device ? device.name + " · " + deviceServiceDetail(device) : id;
}
