import { api } from "../api";
import { functionCallOf, runTool } from "./tools";

export type LiveStatus = "connecting" | "listening" | "thinking" | "speaking" | "closed" | "error";
export type ActivityKind = "info" | "tool" | "result" | "error";

export interface LiveHandlers {
  onStatus: (status: LiveStatus, detail?: string) => void;
  onTranscript: (role: "user" | "assistant", delta: string) => void;
  /** One entry per notable event: tool calls, their results, session end. */
  onActivity: (kind: ActivityKind, text: string) => void;
}

export interface LiveSession {
  /** 0 to 1, how loud the microphone is right now. */
  micLevel: () => number;
  /** 0 to 1, how loud the assistant is right now. */
  voiceLevel: () => number;
  /** Silences the microphone locally and tells GPT-Live, so it stops listening too. */
  setMuted: (muted: boolean) => void;
  stop: () => void;
}

const SPEAKING_HOLD_MS = 300;
const LEVEL_POLL_MS = 50;

/**
 * One conversation: microphone and speaker travel over WebRTC straight to GPT-Live, the JSON
 * events over the `oai-events` data channel. The Worker only brokers the SDP exchange.
 * Levels for the sphere come from WebRTC stats, so nothing taps the audio path itself.
 */
export async function startLive(handlers: LiveHandlers): Promise<LiveSession> {
  handlers.onStatus("connecting");
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const pc = new RTCPeerConnection();
  const speaker = new Audio();
  speaker.autoplay = true;
  const levels = { mic: 0, voice: 0 };
  let ticker = 0;

  pc.ontrack = (event) => {
    speaker.srcObject = new MediaStream([event.track]);
  };
  for (const track of mic.getTracks()) {
    pc.addTrack(track, mic);
  }

  // The channel must exist before the offer so it is part of the negotiated SDP.
  const events = pc.createDataChannel("oai-events");
  const tools = new ToolRunner(events, handlers);
  let lastAssistantAudio = 0;
  // The backend model is working on an answer: between the user's turn and the first spoken word
  let thinking = false;
  events.onmessage = (message) => {
    const event = parse(message.data);
    if (!event) {
      return;
    }
    const type = String(event.type);
    if (type === "session.output_transcript.delta") {
      lastAssistantAudio = Date.now();
      thinking = false;
      handlers.onTranscript("assistant", String(event.delta ?? ""));
    } else if (type === "session.input_transcript.delta") {
      handlers.onTranscript("user", String(event.delta ?? ""));
    } else if (type === "session.closed") {
      handlers.onActivity("info", `Session closed (${String(event.reason ?? "no reason")})`);
      handlers.onStatus("closed", String(event.reason ?? ""));
    } else if (type === "error") {
      const error = event.error as { message?: string } | undefined;
      handlers.onActivity("error", error?.message ?? "GPT-Live error");
      handlers.onStatus("error", error?.message ?? "GPT-Live error");
    } else if (type === "response.event") {
      const nested = event.event as { type?: string } | undefined;
      if (nested?.type === "response.created") {
        thinking = true;
      } else if (nested?.type === "response.completed" || nested?.type === "response.done") {
        thinking = false;
      }
      tools.onResponseEvent(event);
    }
  };
  events.onopen = () => handlers.onStatus("listening");

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await iceGathered(pc);
  const localSdp = pc.localDescription?.sdp;
  if (!localSdp) {
    throw new Error("no local SDP");
  }
  try {
    const answer = await api.assistantSession(localSdp);
    await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    handlers.onActivity("info", answer.tools.length > 0 ? `Connected, tools: ${answer.tools.join(", ")}` : "Connected");
  } catch (err) {
    cleanup();
    throw err;
  }

  ticker = window.setInterval(() => {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      handlers.onStatus("error", "connection lost");
      return;
    }
    void readLevels(pc, levels);
    if (events.readyState !== "open") {
      return;
    }
    const speaking = levels.voice > 0.02 || Date.now() - lastAssistantAudio < SPEAKING_HOLD_MS;
    handlers.onStatus(speaking ? "speaking" : thinking ? "thinking" : "listening");
  }, LEVEL_POLL_MS);

  function cleanup() {
    window.clearInterval(ticker);
    for (const track of mic.getTracks()) {
      track.stop();
    }
    pc.close();
    speaker.srcObject = null;
  }

  return {
    micLevel: () => levels.mic,
    voiceLevel: () => levels.voice,
    setMuted: (muted) => {
      for (const track of mic.getAudioTracks()) {
        track.enabled = !muted;
      }
      if (events.readyState === "open") {
        send(events, { type: muted ? "session.input_audio.mute" : "session.input_audio.unmute" });
      }
      handlers.onActivity("info", muted ? "Microphone muted" : "Microphone live");
    },
    stop: () => {
      if (events.readyState === "open") {
        send(events, { type: "session.close" });
      }
      cleanup();
      handlers.onStatus("closed");
    },
  };
}

/**
 * Runs the backend model's function calls and answers them. Several calls can arrive in one
 * response; every output goes back as its own item and `response.create` follows once, after
 * the last one, so the backend resumes exactly once.
 */
class ToolRunner {
  private pending = 0;
  private answered = 0;
  private responseDone = false;

  constructor(
    private readonly channel: RTCDataChannel,
    private readonly handlers: LiveHandlers,
  ) {}

  onResponseEvent(envelope: Record<string, unknown>): void {
    const nested = envelope.event as { type?: string } | undefined;
    if (nested?.type === "response.created") {
      this.responseDone = false;
      this.answered = 0;
    }
    if (nested?.type === "response.completed" || nested?.type === "response.done") {
      this.responseDone = true;
      this.resumeIfReady();
    }
    const call = functionCallOf(envelope);
    if (!call) {
      return;
    }
    this.pending += 1;
    this.handlers.onActivity("tool", `${call.name} ${call.arguments}`);
    void runTool(call, api).then((output) => {
      this.handlers.onActivity(
        output.includes('"error"') ? "error" : "result",
        `${call.name}: ${output.slice(0, 160)}`,
      );
      send(this.channel, {
        type: "response.item.create",
        item: { type: "function_call_output", call_id: call.call_id, output },
      });
      this.pending -= 1;
      this.answered += 1;
      this.resumeIfReady();
    });
  }

  private resumeIfReady(): void {
    if (this.pending === 0 && this.answered > 0 && this.responseDone) {
      this.answered = 0;
      send(this.channel, { type: "response.create" });
    }
  }
}

/** Microphone and assistant loudness from the peer connection's own statistics. */
async function readLevels(pc: RTCPeerConnection, levels: { mic: number; voice: number }): Promise<void> {
  const stats = await pc.getStats().catch(() => null);
  if (!stats) {
    return;
  }
  stats.forEach((report: { type: string; kind?: string; audioLevel?: number }) => {
    if (report.kind !== "audio" || typeof report.audioLevel !== "number") {
      return;
    }
    const level = Math.min(1, report.audioLevel * 4);
    if (report.type === "inbound-rtp") {
      levels.voice = level;
    } else if (report.type === "media-source") {
      levels.mic = level;
    }
  });
}

function iceGathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    pc.addEventListener("icegatheringstatechange", check);
    window.setTimeout(done, 2000);
  });
}

function send(channel: RTCDataChannel, event: Record<string, unknown>): void {
  channel.send(JSON.stringify(event));
}

function parse(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
