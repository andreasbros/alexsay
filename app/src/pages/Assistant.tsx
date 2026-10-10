import { SpeakerLoudIcon, SpeakerOffIcon } from "@radix-ui/react-icons";
import { Badge, Button, Callout, Flex, Heading, Select, Text } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { ApiError, api, type OpenAiSettings } from "../api";
import { Activity, type ActivityEntry } from "../components/Activity";
import { Bars } from "../components/Bars";
import { appendTurn, Transcript, type Turn } from "../components/Transcript";
import { startDemo } from "../lib/demo";
import { type LiveSession, type LiveStatus, startLive } from "../lib/live";
import { DEFAULT_OPENAI, VOICES } from "../voices";

const LABELS: Record<LiveStatus | "idle", string> = {
  idle: "Ready",
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  closed: "Ended",
  error: "Error",
};

const COLOURS: Record<LiveStatus | "idle", "gray" | "grass" | "amber" | "red" | "indigo"> = {
  idle: "gray",
  connecting: "amber",
  listening: "grass",
  thinking: "amber",
  speaking: "indigo",
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

  const start = async () => {
    setDetail(null);
    setTurns([]);
    setMuted(false);
    const handlers = {
      onActivity: log,
      onStatus: (next: LiveStatus, info?: string) => {
        setStatus(next);
        if (info) {
          setDetail(info);
        }
        if (next === "closed") {
          session.current = null;
        }
      },
      onTranscript: (role: Turn["role"], delta: string) => setTurns((current) => appendTurn(current, role, delta)),
    };
    try {
      session.current = demo ? startDemo(handlers) : await startLive(handlers);
    } catch (err) {
      setStatus("error");
      setDetail(describe(err));
      log("error", describe(err));
    }
  };
  const stop = () => {
    session.current?.stop();
    session.current = null;
    setStatus("idle");
  };
  const active = status === "connecting" || status === "listening" || status === "thinking" || status === "speaking";

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
        await start();
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
      <Flex align="center" justify="between" gap="3" wrap="wrap">
        <Flex align="center" gap="3">
          <Heading size="6">Assistant</Heading>
          <Badge color={COLOURS[status]} size="2">
            {LABELS[status]}
          </Badge>
        </Flex>
        <Flex align="center" gap="2">
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
        ) : (
          <Button size="4" onClick={start} disabled={!ready} style={{ minWidth: 220 }}>
            Start talking
          </Button>
        )}
        <Activity entries={activity} />
      </Flex>
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
