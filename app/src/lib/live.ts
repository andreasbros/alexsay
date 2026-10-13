import { api, type VoiceClient } from "../api";
import { brief, debugLog } from "./debug";
import { openMicrophone } from "./microphone";
import { functionCallOf, runTool } from "./tools";

export type LiveStatus = "connecting" | "listening" | "thinking" | "speaking" | "lost" | "closed" | "error";
export type ActivityKind = "info" | "tool" | "result" | "error";

export interface LiveHandlers {
  onStatus: (status: LiveStatus, detail?: string) => void;
  onTranscript: (role: "user" | "assistant", delta: string) => void;
  /** One entry per notable event: tool calls, their results, session end. */
  onActivity: (kind: ActivityKind, text: string) => void;
  /** Whether this page can take phone calls itself right now; tells the server where a call should ring. */
  voiceClient?: () => VoiceClient;
}

export interface LiveSession {
  /** GPT-Live's id for this session, the handle a later resume forks from. */
  readonly id: string;
  /** The history record this call writes to. */
  readonly conversationId: string | null;
  /** 0 to 1, how loud the microphone is right now. */
  micLevel: () => number;
  /** 0 to 1, how loud the assistant is right now. */
  voiceLevel: () => number;
  /** Silences the microphone locally and tells GPT-Live, so it stops listening too. */
  setMuted: (muted: boolean) => void;
  /** The live microphone track, for a phone call to share instead of opening the microphone again. */
  micTrack: () => MediaStreamTrack | null;
  /** Hands the assistant a note from the app (a call report) and has it respond, as if the user had spoken. */
  tell: (note: string) => void;
  stop: () => void;
}

const SPEAKING_HOLD_MS = 300;
const LEVEL_POLL_MS = 50;
/** After the assistant asked to hang up, how long its goodbye may trail off before the line closes. */
const HANGUP_QUIET_MS = 1500;
/** What the user says to end the call; the app hangs up itself if the model forgets its tool. */
export const USER_FAREWELL =
  /\b(end (the |this )?conversation|stop (the |this )?conversation|good ?bye|bye( bye)?|see you( later| soon)?|good ?night|that'?s (all|it)( for now)?|talk (to you )?later|speak (to you )?later|i'?m done|thanks,? that'?s (all|it))\b/i;
/** What the assistant says when it is signing off. */
export const ASSISTANT_FAREWELL =
  /\b(good ?bye|bye( bye| for now)?|take care|talk (to you )?(later|soon)|speak (to you )?(later|soon)|see you( later| soon)?|good ?night|sleep well|have a (good|great|nice|lovely) (day|evening|night|one))\b/i;
/** A farewell in a reply this short is a sign-off, not a passing phrase. */
const SHORT_REPLY_WORDS = 16;
const USER_FAREWELL_WINDOW_MS = 25_000;

/** Both sides said their goodbyes, or the reply is a short sign-off: the call should end after it. */
export function isSignOff(reply: string, userFarewellAgoMs: number | null): boolean {
  if (!ASSISTANT_FAREWELL.test(reply)) {
    return false;
  }
  const words = reply.trim().split(/\s+/).filter(Boolean).length;
  return words <= SHORT_REPLY_WORDS || (userFarewellAgoMs !== null && userFarewellAgoMs < USER_FAREWELL_WINDOW_MS);
}

/**
 * One conversation: microphone and speaker travel over WebRTC straight to GPT-Live, the JSON
 * events over the `oai-events` data channel. The Worker only brokers the SDP exchange.
 * Levels for the sphere come from WebRTC stats, so nothing taps the audio path itself.
 */
export async function startLive(handlers: LiveHandlers, resumeFrom?: string): Promise<LiveSession> {
  handlers.onStatus("connecting");
  debugLog(`start resumeFrom=${resumeFrom ?? "none"} ua=${navigator.userAgent}`);
  const conversationId = await api
    .startConversation()
    .then((r) => r.id)
    .catch(() => null);
  const recorder = new Recorder(conversationId);
  const mic = await openMicrophone();
  const pc = new RTCPeerConnection();
  // In the document, so the browser never garbage-collects a playing element it cannot see
  const speaker = document.createElement("audio");
  speaker.autoplay = true;
  speaker.hidden = true;
  document.body.append(speaker);
  const levels = { mic: 0, voice: 0 };
  const micGate = new NoiseGate();
  const voiceGate = new NoiseGate();
  // Levels come from WebRTC statistics only: any Web Audio tap on these streams clicks on iOS
  const statsSeen = { mic: false, voice: false };
  const raw = { mic: -1, voice: -1 };
  let lastUserWords = 0;
  let ticker = 0;

  pc.ontrack = (event) => {
    speaker.srcObject = new MediaStream([event.track]);
    speaker.play().catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : "playback blocked";
      handlers.onActivity("error", `Speaker playback refused: ${reason}`);
    });
  };
  for (const track of mic.getTracks()) {
    pc.addTrack(track, mic);
  }

  // The channel must exist before the offer so it is part of the negotiated SDP.
  const events = pc.createDataChannel("oai-events");
  // Set by the end_conversation tool or by the user's own goodbye: close once the reply has been spoken
  let hangingUp = false;
  let hangUpAskedAt = 0;
  let recentUserWords = "";
  let userFarewellAt = 0;
  let currentReply = "";
  const armHangUp = (why: string) => {
    if (!hangingUp) {
      hangingUp = true;
      hangUpAskedAt = Date.now();
      handlers.onActivity("info", why);
    }
  };
  const tools = new ToolRunner(events, handlers, conversationId, () =>
    armHangUp("The assistant is ending the conversation"),
  );
  tools.recorder = recorder;
  let lastAssistantAudio = 0;
  // The backend model is working on an answer: between the user's turn and the first spoken word
  let thinking = false;
  events.onmessage = (message) => {
    const event = parse(message.data);
    if (!event) {
      debugLog(`event unparsable ${String(message.data).slice(0, 120)}`);
      return;
    }
    const type = String(event.type);
    debugLog(`event ${brief(event)}`);
    if (type === "session.output_transcript.delta") {
      lastAssistantAudio = Date.now();
      thinking = false;
      handlers.onTranscript("assistant", String(event.delta ?? ""));
      recorder.add("assistant", String(event.delta ?? ""));
      currentReply = `${currentReply}${String(event.delta ?? "")}`.slice(-400);
      if (isSignOff(currentReply, userFarewellAt ? Date.now() - userFarewellAt : null)) {
        armHangUp("The assistant signed off: ending after it finishes");
      }
    } else if (type === "session.input_transcript.delta") {
      lastUserWords = Date.now();
      handlers.onTranscript("user", String(event.delta ?? ""));
      recorder.add("user", String(event.delta ?? ""));
      recentUserWords = `${recentUserWords}${String(event.delta ?? "")}`.slice(-200);
      currentReply = "";
      if (USER_FAREWELL.test(recentUserWords)) {
        userFarewellAt = Date.now();
        recentUserWords = "";
        armHangUp("You said goodbye: ending after the reply");
      }
    } else if (type === "session.closed") {
      const reason = String(event.reason ?? "no reason");
      handlers.onActivity("info", `Session closed (${reason})`);
      if (reason === "connection_lost" || reason === "expired") {
        cleanup();
        handlers.onStatus("lost", "Connection lost. Tap Resume to carry on where you left off.");
      } else {
        handlers.onStatus("closed", reason);
      }
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
  let openedAt = 0;
  let diagnosed = false;
  let lastLevelLog = 0;
  let lastStatus: LiveStatus = "connecting";
  events.onopen = () => {
    openedAt = Date.now();
    debugLog("data channel open");
    handlers.onStatus("listening");
  };
  pc.onconnectionstatechange = () => debugLog(`connection ${pc.connectionState}`);
  pc.oniceconnectionstatechange = () => debugLog(`ice ${pc.iceConnectionState}`);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await iceGathered(pc);
  const localSdp = pc.localDescription?.sdp;
  if (!localSdp) {
    throw new Error("no local SDP");
  }
  let sessionId = "";
  try {
    const answer = await api.assistantSession(localSdp, resumeFrom);
    await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    sessionId = answer.session_id;
    const how = answer.resumed ? "Resumed with the conversation so far" : "Connected";
    handlers.onActivity("info", answer.tools.length > 0 ? `${how}, tools: ${answer.tools.join(", ")}` : how);
  } catch (err) {
    cleanup();
    throw err;
  }

  ticker = window.setInterval(() => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      // The phone slept or the network went: keep the id, so Resume forks this conversation
      handlers.onActivity("info", "Connection lost");
      cleanup();
      handlers.onStatus("lost", "Connection lost. Tap Resume to carry on where you left off.");
      return;
    }
    void readLevels(pc, levels, statsSeen, { mic: micGate, voice: voiceGate }, raw);
    if (events.readyState !== "open") {
      return;
    }
    if (!diagnosed && Date.now() - openedAt > 5000) {
      diagnosed = true;
      handlers.onActivity(
        "info",
        `Levels: you via ${statsSeen.mic ? "stats" : "transcript"}; assistant via ${statsSeen.voice ? "stats" : "transcript"}`,
      );
    }
    const now = Date.now();
    // Measured audio is the only thing that extends the assistant's speaking time; the
    // transcript fallback below must never feed back into it, or it keeps itself alive
    if (statsSeen.voice && levels.voice > 0.02) {
      lastAssistantAudio = now;
    }
    const talkingByTranscript = now - lastAssistantAudio < SPEAKING_HOLD_MS;
    // Only a browser that reports no level at all gets the words-as-level stand-in
    if (!statsSeen.mic && now - lastUserWords < SPEAKING_HOLD_MS) {
      levels.mic = 0.3 + 0.3 * Math.abs(Math.sin(now / 90));
    }
    if (!statsSeen.voice && talkingByTranscript) {
      levels.voice = 0.3 + 0.3 * Math.abs(Math.sin(now / 90));
    }
    const speaking = levels.voice > 0.02 || talkingByTranscript;
    if (Date.now() - lastLevelLog > 250) {
      lastLevelLog = Date.now();
      debugLog(
        `levels rawMic=${raw.mic.toFixed(3)} rawVoice=${raw.voice.toFixed(3)} mic=${levels.mic.toFixed(2)} ` +
          `voice=${levels.voice.toFixed(2)} speaking=${speaking} thinking=${thinking} byTranscript=${talkingByTranscript}`,
      );
    }
    // Give the reply a moment to start, then close once it has been quiet for a while
    const quietFor = Math.min(now - lastAssistantAudio, now - hangUpAskedAt);
    if (hangingUp && !speaking && quietFor > HANGUP_QUIET_MS) {
      handlers.onActivity("info", "Conversation ended");
      session.stop();
      return;
    }
    const next: LiveStatus = speaking ? "speaking" : thinking ? "thinking" : "listening";
    if (next !== lastStatus) {
      lastStatus = next;
      handlers.onStatus(next);
    }
  }, LEVEL_POLL_MS);

  function cleanup() {
    window.clearInterval(ticker);
    for (const track of mic.getTracks()) {
      track.stop();
    }
    pc.close();
    speaker.srcObject = null;
    speaker.remove();
    void recorder.finish();
  }

  const session: LiveSession = {
    id: sessionId,
    conversationId,
    micLevel: () => levels.mic,
    voiceLevel: () => levels.voice,
    micTrack: () => mic.getAudioTracks()[0] ?? null,
    setMuted: (muted) => {
      for (const track of mic.getAudioTracks()) {
        track.enabled = !muted;
      }
      if (events.readyState === "open") {
        send(events, { type: muted ? "session.input_audio.mute" : "session.input_audio.unmute" });
      }
      handlers.onActivity("info", muted ? "Microphone muted" : "Microphone live");
    },
    tell: (note) => {
      if (events.readyState !== "open") {
        return;
      }
      send(events, {
        type: "response.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: note }] },
      });
      send(events, { type: "response.create" });
      recorder.tool(`note: ${note}`);
      handlers.onActivity("info", `Told the assistant: ${note.slice(0, 120)}`);
    },
    stop: () => {
      if (events.readyState === "open") {
        send(events, { type: "session.close" });
      }
      cleanup();
      handlers.onStatus("closed");
    },
  };
  return session;
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
  recorder: Recorder | null = null;

  constructor(
    private readonly channel: RTCDataChannel,
    private readonly handlers: LiveHandlers,
    private readonly conversationId: string | null,
    private readonly onHangUp: () => void,
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
    this.recorder?.tool(`${call.name} ${call.arguments}`);
    if (call.name === "end_conversation") {
      this.onHangUp();
    }
    void runTool(call, api, this.conversationId, this.handlers.voiceClient?.()).then((output) => {
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

/** Microphone and assistant loudness from the peer connection's own statistics, where reported. */
async function readLevels(
  pc: RTCPeerConnection,
  levels: { mic: number; voice: number },
  seen: { mic: boolean; voice: boolean },
  gates: { mic: NoiseGate; voice: NoiseGate },
  raw: { mic: number; voice: number },
): Promise<void> {
  const stats = await pc.getStats().catch(() => null);
  if (!stats) {
    return;
  }
  stats.forEach((report: { type: string; kind?: string; audioLevel?: number }) => {
    if (report.kind !== "audio" || typeof report.audioLevel !== "number") {
      return;
    }
    if (report.type === "inbound-rtp") {
      raw.voice = report.audioLevel;
      levels.voice = gates.voice.pass(report.audioLevel);
      seen.voice = true;
    } else if (report.type === "media-source") {
      raw.mic = report.audioLevel;
      levels.mic = gates.mic.pass(report.audioLevel);
      seen.mic = true;
    }
  });
}

/**
 * Turns a raw audio level into bar energy: everything up to the room's noise floor is silence.
 * The floor follows the quietest recent level, so a fan or a fridge never moves the bars, and
 * automatic gain control cannot inflate silence into speech.
 */
export class NoiseGate {
  private floor = 0.02;
  private above = 0;

  pass(raw: number): number {
    // The floor drops at once to a quieter reading and creeps up slowly, so speech never raises it
    this.floor = raw < this.floor ? raw : Math.min(raw, this.floor + 0.0005);
    const threshold = Math.max(this.floor * 2.2 + 0.03, 0.06);
    // A single reading above the line is a click or a breath, not speech
    this.above = raw > threshold ? this.above + 1 : 0;
    if (this.above < 2) {
      return 0;
    }
    return Math.min(1, ((raw - threshold) / (0.35 - threshold)) * 1.1);
  }
}

/** Buffers transcript fragments into whole turns and ships them to the history in small batches. */
class Recorder {
  private current: { role: "user" | "assistant"; text: string; at: number } | null = null;
  private pending: { at: number; role: "user" | "assistant" | "tool"; text: string }[] = [];
  private timer = 0;

  constructor(private readonly conversationId: string | null) {}

  add(role: "user" | "assistant", delta: string): void {
    if (this.current && this.current.role === role) {
      this.current.text += delta;
      return;
    }
    this.closeTurn();
    this.current = { role, text: delta, at: Date.now() };
  }

  tool(text: string): void {
    this.closeTurn();
    this.pending.push({ at: Date.now(), role: "tool", text });
    this.schedule();
  }

  async finish(): Promise<void> {
    this.closeTurn();
    window.clearTimeout(this.timer);
    await this.flush();
    if (this.conversationId) {
      await api.endConversation(this.conversationId).catch(() => undefined);
    }
  }

  private closeTurn(): void {
    if (this.current?.text.trim()) {
      this.pending.push({ at: this.current.at, role: this.current.role, text: this.current.text.trim() });
      this.schedule();
    }
    this.current = null;
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), 4000);
  }

  private async flush(): Promise<void> {
    if (!this.conversationId || this.pending.length === 0) {
      return;
    }
    const batch = this.pending.splice(0, this.pending.length);
    await api.addTurns(this.conversationId, batch).catch(() => this.pending.unshift(...batch));
  }
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
  debugLog(`send ${brief(event)}`);
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
