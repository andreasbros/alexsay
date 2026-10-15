import { debugLog } from "./debug";
import { openMicrophone } from "./microphone";
import {
  decodeFrame,
  encodeFrame,
  Framer,
  fromBase64,
  LINE_RATE,
  Resampler,
  toBase64,
  toFloat,
  toInt16,
} from "./mulaw";

/** Why a drop-in ended: the bridge's reasons, plus the browser's own. */
export type DropInEnd =
  | "offline"
  | "busy"
  | "rejected"
  | "no_answer"
  | "hung_up"
  | "silence"
  | "left"
  | "lost"
  | "failed";

export type DropInStatus = "connecting" | "ringing" | "connected" | "ended";

export interface DropInHandlers {
  onStatus: (status: DropInStatus, reason?: DropInEnd, detail?: string) => void;
}

export interface DropInCall {
  hangUp: () => void;
  setMuted: (muted: boolean) => void;
}

/** How far behind live the far side's audio may queue before the oldest of it is dropped. */
const MAX_BEHIND_S = 0.4;
/** A little ahead of now, so a scheduled buffer never starts in the past and clicks. */
const LEAD_S = 0.06;

/**
 * The page's own Web Audio, taken at load: the Assistant page hides the constructor from the Twilio
 * SDK (its meters click during speech on iPhones), and a drop-in opened later still needs it.
 */
const scope = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
const captured: typeof AudioContext | undefined = scope.AudioContext ?? scope.webkitAudioContext;
const webAudio = (): typeof AudioContext | undefined => captured ?? scope.AudioContext ?? scope.webkitAudioContext;

/** Whether this browser can carry a drop-in: a microphone, Web Audio and a WebSocket. */
export function dropInSupported(): boolean {
  return (
    webAudio() !== undefined && typeof WebSocket !== "undefined" && navigator.mediaDevices?.getUserMedia !== undefined
  );
}

/** The drop-in socket for a speaker, on this app's own host, secure when the app is. */
export function dropInUrl(deviceId: string, location: { protocol: string; host: string } = window.location): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/api/devices/${encodeURIComponent(deviceId)}/drop-in`;
}

/** The worklet that hands the microphone's samples to the page, 128 at a time. */
const TAP_WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      this.port.postMessage(channel.slice());
    }
    return true;
  }
}
registerProcessor("alexsay-tap", Tap);
`;

/**
 * Drops in on a speaker: opens the microphone, then the socket; the speaker announces who it is
 * and asks. Once accepted, the microphone goes out as 8 kHz mu-law frames and the room's audio
 * plays back through Web Audio.
 */
export async function openDropIn(deviceId: string, handlers: DropInHandlers): Promise<DropInCall> {
  const WebAudio = webAudio();
  if (!WebAudio) {
    throw new Error("this browser has no Web Audio");
  }
  handlers.onStatus("connecting");
  const stream = await openMicrophone();
  const context = new WebAudio();
  await context.resume().catch(() => undefined);
  const socket = new WebSocket(dropInUrl(deviceId));
  let status: DropInStatus = "connecting";
  let muted = false;
  let capture: (() => void) | null = null;
  let nextPlayAt = 0;

  const finish = (reason: DropInEnd, detail?: string) => {
    if (status === "ended") {
      return;
    }
    status = "ended";
    capture?.();
    capture = null;
    for (const track of stream.getTracks()) {
      track.stop();
    }
    void context.close().catch(() => undefined);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
    handlers.onStatus("ended", reason, detail);
  };

  const send = (message: Record<string, unknown>) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  const play = (payload: string) => {
    const samples = toFloat(decodeFrame(fromBase64(payload)));
    const buffer = context.createBuffer(1, samples.length, LINE_RATE);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const now = context.currentTime;
    // Too far behind (a stall, a tab in the background): start afresh rather than lag for the rest of the call
    if (nextPlayAt < now + LEAD_S || nextPlayAt > now + MAX_BEHIND_S) {
      nextPlayAt = now + LEAD_S;
    }
    source.start(nextPlayAt);
    nextPlayAt += buffer.duration;
  };

  const startCapture = async () => {
    const source = context.createMediaStreamSource(stream);
    const resampler = new Resampler(context.sampleRate, LINE_RATE);
    const framer = new Framer();
    const onSamples = (samples: Float32Array) => {
      if (muted || status !== "connected") {
        return;
      }
      for (const frame of framer.push(resampler.push(samples))) {
        send({ type: "audio", payload: toBase64(encodeFrame(toInt16(frame))) });
      }
    };
    if (context.audioWorklet) {
      const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "application/javascript" }));
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const tap = new AudioWorkletNode(context, "alexsay-tap", { numberOfOutputs: 0 });
      tap.port.onmessage = (event: MessageEvent<Float32Array>) => onSamples(event.data);
      source.connect(tap);
      capture = () => {
        tap.port.onmessage = null;
        source.disconnect();
        tap.disconnect();
      };
    } else {
      // Older WebKit: the deprecated processor node still delivers the samples
      const processor = context.createScriptProcessor(1_024, 1, 1);
      processor.onaudioprocess = (event) => onSamples(event.inputBuffer.getChannelData(0).slice());
      source.connect(processor);
      processor.connect(context.destination);
      capture = () => {
        processor.onaudioprocess = null;
        source.disconnect();
        processor.disconnect();
      };
    }
    debugLog(`drop-in capture at ${context.sampleRate} Hz`);
  };

  socket.onmessage = (event: MessageEvent<string>) => {
    let message: { type?: string; reason?: DropInEnd; payload?: string };
    try {
      message = JSON.parse(event.data) as typeof message;
    } catch {
      return;
    }
    switch (message.type) {
      case "ringing":
        status = "ringing";
        handlers.onStatus("ringing");
        break;
      case "accepted":
        status = "connected";
        handlers.onStatus("connected");
        startCapture().catch((err: unknown) => finish("failed", err instanceof Error ? err.message : String(err)));
        break;
      case "audio":
        if (message.payload && status === "connected") {
          play(message.payload);
        }
        break;
      case "ended":
        finish(message.reason ?? "left");
        break;
      default:
        break;
    }
  };
  socket.onerror = () => finish("failed", "the connection to the server failed");
  socket.onclose = () => finish("lost");

  return {
    hangUp: () => {
      send({ type: "hangup" });
      finish("left");
    },
    setMuted: (next) => {
      muted = next;
      for (const track of stream.getAudioTracks()) {
        track.enabled = !next;
      }
    },
  };
}
