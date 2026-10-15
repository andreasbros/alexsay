import { type Call, Device } from "@twilio/voice-sdk";
import { api } from "../api";
import type { ActivityKind } from "./live";

export type LineStatus = "off" | "ready" | "ringing" | "connected";

export interface LineHandlers {
  onStatus: (status: LineStatus, who?: string) => void;
  onActivity: (kind: ActivityKind, text: string) => void;
  /** The browser refused to start the call's sound; `resume` must be called from a tap. */
  onPlaybackBlocked?: (resume: () => void) => void;
  /** The page answered one of the assistant's own conference legs. */
  onConferenceJoined?: (conference: string) => void;
}

export interface PhoneLine {
  readonly status: () => LineStatus;
  answer: () => void;
  decline: () => void;
  hangUp: () => void;
  setMuted: (muted: boolean) => void;
  stop: () => void;
}

/** Silences (or restores) the given microphone tracks at the source, whatever the SDK does with them. */
export function applyMute(tracks: { enabled: boolean }[], muted: boolean): void {
  for (const track of tracks) {
    track.enabled = !muted;
  }
}

/**
 * The browser as a phone: it registers with Twilio under the user's own account, so calls the
 * assistant places ring here at once and calls to the user's number can be answered here.
 * It shares the conversation's microphone track instead of opening the microphone a second time.
 */
const ACCEPT_POLL_MS = 150;
const ACCEPT_WAIT_MAX_MS = 15_000;

export async function openPhoneLine(
  handlers: LineHandlers,
  micTrack: () => MediaStreamTrack | null,
  /** False while the page's own assistant is still speaking, so its words do not spill into the call. */
  canAccept: () => boolean = () => true,
  /** An audio element a tap has already started, which the call's sound is routed through. */
  sink: HTMLAudioElement | null = null,
): Promise<PhoneLine> {
  const { token } = await api.voiceToken();
  withoutWebAudio();
  const device = new Device(token, {
    // Web Audio on this page makes the assistant's speech click on iPhones, so no SDK sounds or meters
    disableAudioContextSounds: true,
    sounds: {},
    closeProtection: false,
    logLevel: "error",
    getUserMedia: async (constraints: MediaStreamConstraints) => {
      const track = micTrack();
      const stream = track ? new MediaStream([track.clone()]) : await navigator.mediaDevices.getUserMedia(constraints);
      // Callers hear the browser quietly otherwise: let the browser level the microphone for the call
      for (const t of stream.getAudioTracks()) {
        t.applyConstraints({ autoGainControl: true, noiseSuppression: true, echoCancellation: true }).catch(() => {});
      }
      callTracks = stream.getAudioTracks();
      applyMute(callTracks, muted);
      return stream;
    },
  });
  let current: Call | null = null;
  let status: LineStatus = "off";
  // The call's own microphone tracks (clones of the conversation's), silenced directly: the SDK's mute alone
  // did not stop the user's voice reaching the call, and a mute pressed before the call must hold through it
  let callTracks: MediaStreamTrack[] = [];
  let muted = false;
  const set = (next: LineStatus, who?: string) => {
    status = next;
    handlers.onStatus(next, who);
  };
  const attach = (call: Call) => {
    current = call;
    call.on("accept", () => {
      call.mute(muted);
      applyMute(callTracks, muted);
      set("connected", callerOf(call));
      if (sink) {
        playThrough(sink, call, handlers);
      }
      const conference = call.customParameters.get("conference");
      if (conference) {
        handlers.onConferenceJoined?.(conference);
      }
    });
    call.on("disconnect", () => {
      current = null;
      callTracks = [];
      if (sink) {
        sink.srcObject = null;
      }
      set("ready");
    });
    call.on("cancel", () => {
      current = null;
      set("ready");
    });
    call.on("reject", () => {
      current = null;
      set("ready");
    });
    call.on("error", (err: Error) => handlers.onActivity("error", `Phone line: ${err.message}`));
  };
  device.on("incoming", (call: Call) => {
    attach(call);
    // Our own conference legs carry the conference name; a caller parked in one ("incoming"), or any other call, rings
    if (call.customParameters.get("conference") && !call.customParameters.get("incoming")) {
      acceptWhenQuiet(call, canAccept);
    } else {
      set("ringing", callerOf(call));
    }
  });
  device.on("tokenWillExpire", async () => {
    try {
      device.updateToken((await api.voiceToken()).token);
    } catch (err) {
      handlers.onActivity("error", `Phone line token: ${err instanceof Error ? err.message : "failed"}`);
    }
  });
  device.on("error", (err: Error) => handlers.onActivity("error", `Phone line: ${err.message}`));
  // The SDK re-registers by itself after a network blip; follow it both ways so calls keep finding the page
  device.on("registered", () => {
    if (status !== "connected" && status !== "ringing") {
      set("ready");
    }
  });
  device.on("unregistered", () => {
    if (status !== "connected") {
      set("off");
    }
  });
  await device.register();
  set("ready");
  return {
    status: () => status,
    answer: () => current?.accept(),
    decline: () => current?.reject(),
    hangUp: () => current?.disconnect(),
    setMuted: (next) => {
      muted = next;
      current?.mute(next);
      applyMute(callTracks, next);
    },
    stop: () => {
      current?.disconnect();
      device.destroy();
      set("off");
    },
  };
}

/**
 * Routes the call's remote audio through the primed element and silences the SDK's own, so the call
 * is heard once, through an element the browser already lets play.
 */
function playThrough(sink: HTMLAudioElement, call: Call, handlers: LineHandlers): void {
  const remote = call.getRemoteStream();
  if (!remote) {
    return;
  }
  for (const other of document.querySelectorAll("audio")) {
    if (other !== sink && other.srcObject === remote) {
      other.muted = true;
    }
  }
  sink.srcObject = remote;
  sink.muted = false;
  const start = () => sink.play();
  start().catch(() => {
    handlers.onActivity("error", "The browser blocked the call's sound until you tap");
    handlers.onPlaybackBlocked?.(() => void start().catch(() => undefined));
  });
}

/** Answers the assistant's own conference leg as soon as the page's assistant has finished its sentence. */
function acceptWhenQuiet(call: Call, canAccept: () => boolean): void {
  const startedAt = Date.now();
  const attempt = () => {
    if (call.status() !== "pending") {
      return;
    }
    if (canAccept() || Date.now() - startedAt > ACCEPT_WAIT_MAX_MS) {
      call.accept();
      return;
    }
    window.setTimeout(attempt, ACCEPT_POLL_MS);
  };
  attempt();
}

/**
 * Who is calling, as Twilio tells it: a caller parked on the number (named by the server), the
 * caller's own number, or the conference the assistant opened.
 */
export function callerOf(call: Pick<Call, "parameters" | "customParameters">): string {
  const parked = call.customParameters.get("from");
  if (call.customParameters.get("incoming") && parked) {
    return parked;
  }
  const conference = call.customParameters.get("conference");
  if (conference) {
    return "the assistant's call";
  }
  const from = call.parameters.From ?? "";
  return from.replace(/^client:/, "") || "unknown number";
}

/**
 * The SDK creates an AudioContext for volume meters whenever the page has one; this page never
 * uses Web Audio (it clicks during speech on iPhones), so it is hidden before the Device is built.
 */
function withoutWebAudio(): void {
  const scope = window as Window & { AudioContext?: unknown; webkitAudioContext?: unknown };
  scope.AudioContext = undefined;
  scope.webkitAudioContext = undefined;
}
