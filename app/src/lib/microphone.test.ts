import { afterEach, describe, expect, it, vi } from "vitest";
import { openMicrophone, preferredInput, routeThroughHeadset } from "./microphone";

const input = (deviceId: string, label: string) =>
  ({ deviceId, label, kind: "audioinput", groupId: "", toJSON: () => ({}) }) as MediaDeviceInfo;

const phone = input("phone", "iPhone Microphone");
const airpods = input("pods", "Andreas's AirPods Pro");

function track(deviceId: string) {
  return { label: deviceId, stop: vi.fn(), getSettings: () => ({ deviceId }) };
}

function stream(deviceId: string) {
  const t = track(deviceId);
  return { getAudioTracks: () => [t], getTracks: () => [t] } as unknown as MediaStream;
}

describe("microphone", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers a connected headset over the phone's own microphone", () => {
    expect(preferredInput([phone, airpods], "phone")).toBe(airpods);
    expect(preferredInput([phone, airpods], "pods")).toBeNull();
    expect(preferredInput([phone], "phone")).toBeNull();
    expect(preferredInput([phone, input("bt", "Jabra Bluetooth Headset")], undefined)?.deviceId).toBe("bt");
  });

  it("reopens the microphone on the AirPods when the phone's was opened", async () => {
    const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
      const wanted = (c.audio as MediaTrackConstraints).deviceId as { exact: string } | undefined;
      return stream(wanted?.exact ?? "phone");
    });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia, enumerateDevices: async () => [phone, airpods] },
    });
    const mic = await openMicrophone();
    expect(mic.getAudioTracks()[0]?.getSettings().deviceId).toBe("pods");
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("asks Safari for a play-and-record session, and does nothing where there is none", () => {
    const audioSession = { type: "auto" };
    vi.stubGlobal("navigator", { audioSession });
    routeThroughHeadset();
    expect(audioSession.type).toBe("play-and-record");
    vi.stubGlobal("navigator", {});
    expect(() => routeThroughHeadset()).not.toThrow();
  });
});
