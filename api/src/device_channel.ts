import type { Scope } from "./types";

/** What the server can tell a running speaker over its line socket. */
export type DeviceMessage =
  | { type: "alarms.changed" }
  | { type: "alarm.stop"; id?: string }
  | { type: "alarm.snooze"; id?: string; minutes: number };

/** Pushes a message to the speaker's open socket; false when the speaker is not connected. */
export async function notifyDevice(scope: Scope, deviceId: string, message: DeviceMessage): Promise<boolean> {
  const line = scope.env.LINE_BRIDGE.get(scope.env.LINE_BRIDGE.idFromName(deviceId));
  const res = await line.fetch("https://line/push", { method: "POST", body: JSON.stringify(message) });
  return res.ok && ((await res.json()) as { delivered: boolean }).delivered;
}
