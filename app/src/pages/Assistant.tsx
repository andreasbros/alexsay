import { Badge, Button, Callout, Flex, Heading, Text } from "@radix-ui/themes";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ApiError, api } from "../api";
import { Bars } from "../components/Bars";
import { type LiveSession, type LiveStatus, startLive } from "../lib/live";

const LABELS: Record<LiveStatus | "idle", string> = {
  idle: "Tap to talk",
  connecting: "Connecting",
  listening: "Listening",
  speaking: "Speaking",
  closed: "Ended",
  error: "Error",
};

export function Assistant() {
  const connections = useQuery({ queryKey: ["connections"], queryFn: api.connections });
  const hasOpenai = connections.data?.some((c) => c.provider === "openai") ?? false;
  const session = useRef<LiveSession | null>(null);
  const [status, setStatus] = useState<LiveStatus | "idle">("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const [said, setSaid] = useState({ user: "", assistant: "" });
  const [activity, setActivity] = useState<string[]>([]);

  useEffect(() => () => session.current?.stop(), []);

  const start = async () => {
    setDetail(null);
    setSaid({ user: "", assistant: "" });
    setActivity([]);
    try {
      session.current = await startLive({
        onActivity: (line) => setActivity((lines) => [...lines.slice(-11), line]),
        onStatus: (next, info) => {
          setStatus(next);
          if (info) {
            setDetail(info);
          }
        },
        onTranscript: (role, delta) =>
          setSaid((s) =>
            role === "user" ? { user: s.user + delta, assistant: "" } : { ...s, assistant: s.assistant + delta },
          ),
      });
    } catch (err) {
      setStatus("error");
      setDetail(describe(err));
    }
  };
  const stop = () => {
    session.current?.stop();
    session.current = null;
    setStatus("idle");
  };
  const active = status === "connecting" || status === "listening" || status === "speaking";
  const level = () => {
    const live = session.current;
    if (!live) {
      return 0;
    }
    return status === "speaking" ? live.voiceLevel() : live.micLevel();
  };

  return (
    <Flex direction="column" gap="5" align="center">
      <Flex align="center" justify="between" width="100%">
        <Heading size="7">Assistant</Heading>
        <Badge color={status === "error" ? "red" : active ? "grass" : "gray"} size="2">
          {LABELS[status]}
        </Badge>
      </Flex>
      {connections.isSuccess && !hasOpenai && (
        <Callout.Root color="amber" size="1" style={{ width: "100%" }}>
          <Callout.Text>
            Add your OpenAI API key under <Link to="/connections">Connections</Link> first.
          </Callout.Text>
        </Callout.Root>
      )}
      <div className="stage">
        <Bars status={status} level={level} />
      </div>
      <Flex direction="column" align="center" gap="1" className="transcript">
        {said.user && (
          <Text size="2" color="gray">
            {said.user}
          </Text>
        )}
        {said.assistant && <Text size="3">{said.assistant}</Text>}
        {detail && (
          <Text size="2" color={status === "error" ? "red" : "gray"}>
            {detail}
          </Text>
        )}
      </Flex>
      {active ? (
        <Button size="3" color="red" variant="soft" onClick={stop}>
          End conversation
        </Button>
      ) : (
        <Button size="3" onClick={start} disabled={!hasOpenai}>
          Start talking
        </Button>
      )}
      {activity.length > 0 && (
        <Flex direction="column" gap="1" width="100%" style={{ maxWidth: 640 }}>
          <Text size="1" color="gray" weight="medium">
            Activity
          </Text>
          {activity.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: an append-only log
            <Text key={index} size="1" color="gray" className="mono" style={{ overflowWrap: "anywhere" }}>
              {line}
            </Text>
          ))}
        </Flex>
      )}
    </Flex>
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
