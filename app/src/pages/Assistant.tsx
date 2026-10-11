import { SpeakerLoudIcon, SpeakerOffIcon } from "@radix-ui/react-icons";
import { Badge, Button, Callout, Flex, Select, Text } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { ApiError, api, type OpenAiSettings } from "../api";
import { Activity, type ActivityEntry } from "../components/Activity";
import { Bars } from "../components/Bars";
import { DebugPanel } from "../components/DebugPanel";
import { appendTurn, Transcript, type Turn } from "../components/Transcript";
import { debugLog, isDebug, subscribeDebug } from "../lib/debug";
import { startDemo } from "../lib/demo";
import { type LiveSession, type LiveStatus, startLive } from "../lib/live";
import { playEnd, playStart, primeSounds } from "../lib/sounds";
import { DEFAULT_OPENAI, VOICES } from "../voices";

const LABELS: Record<LiveStatus | "idle", string> = {
  idle: "Ready",
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  lost: "Connection lost",
  closed: "Ended",
  error: "Error",
};

const COLOURS: Record<LiveStatus | "idle", "gray" | "grass" | "amber" | "red" | "indigo"> = {
  idle: "gray",
  connecting: "amber",
  listening: "grass",
  thinking: "amber",
  speaking: "indigo",
  lost: "amber",
  closed: "gray",
  error: "red",
};

export function Assistant() {
  const client = useQueryClient();
  const demo = new URLSearchParams(useLocation().search).has("demo");
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  const openai = connections.data?.find((c) => c.provider === "openai");
  const settings: OpenAiSettings = { ...DEFAULT_OPENAI, ...openai?.settings };
  const session = useRef<LiveSession | null>(null);
  const [status, setStatus] = useState<LiveStatus | "idle">("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [debug, setDebugOn] = useState(isDebug);
  useEffect(() => subscribeDebug(() => setDebugOn(isDebug())), []);
  // The last GPT-Live session, kept so a dropped call can be forked and carried on
  const lastSessionId = useRef<string | null>(null);
  const log = (kind: ActivityEntry["kind"], text: string) =>
    setActivity((entries) => [...entries.slice(-49), { at: new Date(), kind, text }]);

  useEffect(() => () => session.current?.stop(), []);
  useEffect(() => {
    // Anything that blows up in the browser lands in the activity card instead of vanishing
    const onError = (event: ErrorEvent) => log("error", `Browser: ${event.message}`);
    const onRejection = (event: PromiseRejectionEvent) =>
      log("error", `Browser: ${event.reason instanceof Error ? event.reason.message : String(event.reason)}`);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  const start = async (resume = false) => {
    primeSounds();
    setDetail(null);
    if (!resume) {
      setTurns([]);
    }
    setMuted(false);
    const handlers = {
      onActivity: log,
      onStatus: (next: LiveStatus, info?: string) => {
        debugLog(`status ${next}${info ? ` (${info})` : ""}`);
        setStatus((previous) => {
          if (previous === "connecting" && next === "listening") {
            playStart();
          }
          if (next === "closed" && previous !== "closed" && previous !== "idle") {
            playEnd();
          }
          return next;
        });
        if (info) {
          setDetail(info);
        }
        if (next === "closed" || next === "lost") {
          session.current = null;
        }
        if (next === "closed") {
          setTurns([]);
        }
      },
      onTranscript: (role: Turn["role"], delta: string) => setTurns((current) => appendTurn(current, role, delta)),
    };
    try {
      const resumeFrom = resume ? (lastSessionId.current ?? undefined) : undefined;
      session.current = demo ? startDemo(handlers) : await startLive(handlers, resumeFrom);
      lastSessionId.current = session.current.id || lastSessionId.current;
    } catch (err) {
      setStatus("error");
      setDetail(describe(err));
      log("error", describe(err));
    }
  };
  const stop = () => {
    const wasActive = session.current !== null;
    session.current?.stop();
    session.current = null;
    if (wasActive) {
      playEnd();
    }
    setStatus("idle");
    setTurns([]);
  };
  const active = status === "connecting" || status === "listening" || status === "thinking" || status === "speaking";

  // Back from the lock screen or another app: pick the conversation up again by itself
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && status === "lost") {
        void start(true);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  });

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    session.current?.setMuted(next);
  };

  // GPT-Live fixes the voice when a session starts, so a change mid-conversation reconnects
  const changeVoice = useMutation({
    mutationFn: (voice: string) => api.connectOpenai("", { ...settings, voice }),
    onSuccess: async (_result, voice) => {
      await client.invalidateQueries({ queryKey: ["connections"] });
      log("info", `Voice changed to ${voice}`);
      if (active) {
        stop();
        await start(true);
      }
    },
  });

  const level = () => {
    const live = session.current;
    if (!live) {
      return 0;
    }
    return status === "speaking" ? live.voiceLevel() : live.micLevel();
  };
  const ready = demo || !!openai;

  return (
    <div className="assistant">
      <Flex align="center" justify="between" gap="2" wrap="nowrap" className="assistant-bar">
        <Badge color={COLOURS[status]} size="2" className="assistant-status" role="status">
          {LABELS[status]}
        </Badge>
        <Flex align="center" gap="2" wrap="nowrap">
          <Select.Root
            size="2"
            value={settings.voice}
            onValueChange={(voice) => changeVoice.mutate(voice)}
            disabled={!openai || demo}
          >
            <Select.Trigger aria-label="Voice" variant="soft" />
            <Select.Content>
              <Select.Group>
                <Select.Label>Male</Select.Label>
                {VOICES.male.map((v) => (
                  <Select.Item key={v} value={v}>
                    {v}
                  </Select.Item>
                ))}
              </Select.Group>
              <Select.Group>
                <Select.Label>Female</Select.Label>
                {VOICES.female.map((v) => (
                  <Select.Item key={v} value={v}>
                    {v}
                  </Select.Item>
                ))}
              </Select.Group>
            </Select.Content>
          </Select.Root>
          <Button
            size="2"
            variant={muted ? "solid" : "soft"}
            color={muted ? "amber" : "gray"}
            onClick={toggleMute}
            disabled={!active}
          >
            {muted ? <SpeakerOffIcon /> : <SpeakerLoudIcon />}
            {muted ? "Unmute" : "Mute"}
          </Button>
        </Flex>
      </Flex>
      {connections.isSuccess && !ready && (
        <Callout.Root color="amber" size="1">
          <Callout.Text>
            Add your OpenAI API key under <Link to="/connections">Connections</Link> first.
          </Callout.Text>
        </Callout.Root>
      )}
      <div className="stage">
        <Bars status={status} level={level} />
      </div>
      <Transcript turns={turns} thinking={status === "thinking"} />
      {detail && (
        <Text size="2" color={status === "error" ? "red" : "gray"} align="center">
          {detail}
        </Text>
      )}
      <Flex direction="column" align="center" gap="3">
        {active ? (
          <Button size="4" color="red" variant="soft" onClick={stop} style={{ minWidth: 220 }}>
            End conversation
          </Button>
        ) : status === "lost" ? (
          <Button size="4" color="amber" onClick={() => start(true)} style={{ minWidth: 220 }}>
            Resume conversation
          </Button>
        ) : (
          <Button size="4" onClick={() => start()} disabled={!ready} style={{ minWidth: 220 }}>
            Start talking
          </Button>
        )}
        <div className="activity-slot">
          <Activity entries={activity} />
        </div>
      </Flex>
      {debug && <DebugPanel />}
    </div>
  );
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "no_openai_connection") {
      return "No OpenAI connection.";
    }
    return err.detail ? `${err.code}: ${err.detail}` : err.code;
  }
  if (err instanceof DOMException && err.name === "NotAllowedError") {
    return "Microphone access was refused.";
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}
