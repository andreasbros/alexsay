import { debugLog } from "./debug";

/** Inputs worn on the head: when one is connected, it is the microphone the user means. */
const HEADSET = /airpods|headset|headphone|earphone|earbud|buds|beats|bluetooth|hands-?free/i;

/**
 * The headset input to switch to, if one is listed and the open microphone is not it. On an iPhone with
 * AirPods the page can play through the AirPods while still listening through the phone.
 */
export function preferredInput(inputs: MediaDeviceInfo[], currentId: string | undefined): MediaDeviceInfo | null {
  const headset = inputs.find((d) => d.kind === "audioinput" && HEADSET.test(d.label));
  return headset && headset.deviceId !== currentId ? headset : null;
}

type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };

/**
 * Safari's audio session (iOS 16.4+): "play-and-record" before anything plays, so iOS routes a connected
 * headset's microphone as well as its speaker, rather than playing to the AirPods and recording the phone.
 */
export function routeThroughHeadset(): void {
  const session = (navigator as AudioSessionNavigator).audioSession;
  if (!session) {
    return;
  }
  try {
    session.type = "play-and-record";
    debugLog(`audio session ${session.type}`);
  } catch {
    // An older Safari knows the object but not the type: the default route stays
  }
}

const CONSTRAINTS: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

/** The microphone, on a connected headset when there is one. */
export async function openMicrophone(): Promise<MediaStream> {
  let stream = await navigator.mediaDevices.getUserMedia({ audio: CONSTRAINTS });
  const track = stream.getAudioTracks()[0];
  // Labels are only listed once the page may use the microphone, so this comes after the first open
  const inputs = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter(
    (d) => d.kind === "audioinput",
  );
  debugLog(`microphones: ${inputs.map((d) => d.label || "(unnamed)").join(", ") || "none listed"}`);
  const headset = preferredInput(inputs, track?.getSettings().deviceId);
  if (headset) {
    try {
      const switched = await navigator.mediaDevices.getUserMedia({
        audio: { ...CONSTRAINTS, deviceId: { exact: headset.deviceId } },
      });
      for (const old of stream.getTracks()) {
        old.stop();
      }
      stream = switched;
    } catch (err) {
      debugLog(`headset microphone refused: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  debugLog(`listening through ${stream.getAudioTracks()[0]?.label || "the default microphone"}`);
  return stream;
}
