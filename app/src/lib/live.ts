import { api } from "../api";
import { functionCallOf, runTool } from "./tools";

export type LiveStatus = "connecting" | "listening" | "speaking" | "closed" | "error";

export interface LiveHandlers {
  onStatus: (status: LiveStatus, detail?: string) => void;
  onTranscript: (role: "user" | "assistant", delta: string) => void;
}

export interface LiveSession {
  /** 0 to 1, how loud the microphone is right now. */
  micLevel: () => number;
  /** 0 to 1, how loud the assistant is right now. */
  voiceLevel: () => number;
  stop: () => void;
}

const SPEAKING_HOLD_MS = 350;

/**
 * One conversation: microphone and speaker travel over WebRTC straight to GPT-Live, the JSON
 * events over the `oai-events` data channel. The Worker only brokers the SDP exchange.
 */
export async function startLive(handlers: LiveHandlers): Promise<LiveSession> {
  handlers.onStatus("connecting");
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const pc = new RTCPeerConnection();
  const audioContext = new AudioContext();
  const micMeter = meter(audioContext, mic);
  let voiceMeter: Meter | null = null;
  const speaker = new Audio();
  speaker.autoplay = true;
  let ticker = 0;

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream) {
      speaker.srcObject = stream;
      voiceMeter = meter(audioContext, stream);
    }
  };
  for (const track of mic.getTracks()) {
    pc.addTrack(track, mic);
  }

  // The channel must exist before the offer so it is part of the negotiated SDP.
  const events = pc.createDataChannel("oai-events");
  let lastAssistantAudio = 0;
  events.onmessage = (message) => {
    const event = parse(message.data);
    if (!event) {
      return;
    }
    const type = String(event.type);
    if (type === "session.output_transcript.delta") {
      lastAssistantAudio = Date.now();
      handlers.onTranscript("assistant", String(event.delta ?? ""));
    } else if (type === "session.input_transcript.delta") {
      handlers.onTranscript("user", String(event.delta ?? ""));
    } else if (type === "session.closed") {
      handlers.onStatus("closed", String(event.reason ?? ""));
    } else if (type === "error") {
      const error = event.error as { message?: string } | undefined;
      handlers.onStatus("error", error?.message ?? "GPT-Live error");
    }
    const call = functionCallOf(event);
    if (call) {
      void runTool(call, api).then((output) => {
        send(events, {
          type: "response.item.create",
          item: { type: "function_call_output", call_id: call.call_id, output },
        });
        send(events, { type: "response.create" });
      });
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
  } catch (err) {
    cleanup();
    throw err;
  }

  ticker = window.setInterval(() => {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      handlers.onStatus("error", "connection lost");
      return;
    }
    if (events.readyState !== "open") {
      return;
    }
    const speaking = (voiceMeter?.level() ?? 0) > 0.04 || Date.now() - lastAssistantAudio < SPEAKING_HOLD_MS;
    handlers.onStatus(speaking ? "speaking" : "listening");
  }, 120);

  function cleanup() {
    window.clearInterval(ticker);
    for (const track of mic.getTracks()) {
      track.stop();
    }
    pc.close();
    speaker.srcObject = null;
    void audioContext.close();
  }

  return {
    micLevel: () => micMeter.level(),
    voiceLevel: () => voiceMeter?.level() ?? 0,
    stop: () => {
      if (events.readyState === "open") {
        send(events, { type: "session.close" });
      }
      cleanup();
      handlers.onStatus("closed");
    },
  };
}

interface Meter {
  level: () => number;
}

function meter(context: AudioContext, stream: MediaStream): Meter {
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  return {
    level: () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) {
        const centred = (s - 128) / 128;
        sum += centred * centred;
      }
      return Math.min(1, Math.sqrt(sum / samples.length) * 3);
    },
  };
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
