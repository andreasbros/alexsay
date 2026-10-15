import { devices } from "./db";
import type { NotificationKind, Scope } from "./types";

/** What the server can tell a running speaker over its line socket. */
export type DeviceMessage =
  | { type: "alarms.changed" }
  | { type: "alarm.stop"; id?: string }
  | { type: "alarm.snooze"; id?: string; minutes: number }
  /** Someone is calling the number: ring, say who, ask whether to answer. */
  | { type: "call.incoming"; conference: string; from: string; name: string | null; say: string }
  /** The call was answered elsewhere, or nobody did in time: stop ringing. */
  | { type: "call.incoming.cancel"; conference: string }
  /** Something to read out after a chime: a text, a missed call, a message taken. */
  | { type: "notify"; id: string; kind: NotificationKind; say: string };

/** Pushes one message to every speaker of the home; how many were connected to take it. */
export async function notifyHome(scope: Scope, home: string, message: DeviceMessage): Promise<number> {
  let delivered = 0;
  for (const device of await devices.list(scope.env.DB, home)) {
    if (await notifyDevice(scope, device.id, message)) {
      delivered += 1;
    }
  }
  return delivered;
}

/** Pushes a message to the speaker's open socket; false when the speaker is not connected. */
export async function notifyDevice(scope: Scope, deviceId: string, message: DeviceMessage): Promise<boolean> {
  const line = scope.env.LINE_BRIDGE.get(scope.env.LINE_BRIDGE.idFromName(deviceId));
  const res = await line.fetch("https://line/push", { method: "POST", body: JSON.stringify(message) });
  return res.ok && ((await res.json()) as { delivered: boolean }).delivered;
}
