import { MobileIcon, SpeakerLoudIcon, SpeakerOffIcon } from "@radix-ui/react-icons";
import { Badge, Button, Callout, Dialog, Flex, Select, Text, TextField } from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { ApiError, api, type Contact, type OpenAiSettings } from "../api";
import { Activity, type ActivityEntry } from "../components/Activity";
import { Bars } from "../components/Bars";
import { DebugPanel } from "../components/DebugPanel";
import { appendTurn, Transcript, type Turn } from "../components/Transcript";
import { callReportNote } from "../lib/call_report";
import { debugLog, isDebug, subscribeDebug } from "../lib/debug";
import { startDemo } from "../lib/demo";
import { type LiveSession, type LiveStatus, startLive } from "../lib/live";
import { type LineStatus, openPhoneLine, type PhoneLine } from "../lib/phone_line";
import { callSink, playEnd, preloadSounds, primeCallAudio, primeSounds, startConnecting } from "../lib/sounds";
import { DEFAULT_OPENAI, VOICES } from "../voices";

const QUIET_BEFORE_CALL_MS = 800;
/** How long the page waits for the assistant's leg to close before it hands over a possibly short report. */
const REPORT_WAIT_MS = 8000;
const REPORT_POLL_MS = 600;

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
  const mutedRef = useRef(false);
  const line = useRef<PhoneLine | null>(null);
  const lineStatusRef = useRef<LineStatus>("off");
  const statusRef = useRef<LiveStatus | "idle">("idle");
  const lastSpokeAt = useRef(0);
  const stopRing = useRef<(() => void) | null>(null);
  // The conference the page is in, so its report can be fetched the moment the leg drops
  const conferenceRef = useRef<string | null>(null);
  const [lineStatus, setLineStatus] = useState<LineStatus>("off");
  const [lineError, setLineError] = useState<string | null>(null);
  const [resumeAudio, setResumeAudio] = useState<(() => void) | null>(null);
  const [caller, setCaller] = useState<string | null>(null);
  const hasPhone = connections.data?.some((c) => c.provider === "twilio") ?? false;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [debug, setDebugOn] = useState(isDebug);
  useEffect(() => subscribeDebug(() => setDebugOn(isDebug())), []);
  // The last GPT-Live session, kept so a dropped call can be forked and carried on
  const lastSessionId = useRef<string | null>(null);
  const log = useCallback(
    (kind: ActivityEntry["kind"], text: string) =>
      setActivity((entries) => [...entries.slice(-49), { at: new Date(), kind, text }]),
    [],
  );

  useEffect(
    () => () => {
      session.current?.stop();
      line.current?.stop();
    },
    [],
  );
  useEffect(preloadSounds, []);
  // Closing the tab mid-call: tell the server to end the conference, since no event follows the page's death
  useEffect(() => {
    const onHide = () => {
      if (lineStatusRef.current === "connected") {
        navigator.sendBeacon("/api/twilio/calls/end");
      }
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);
  // The page is the user's phone while it is open: calls to their number ring here even between conversations
  // biome-ignore lint/correctness/useExhaustiveDependencies: openLine only touches refs; run when Twilio becomes available
  useEffect(() => {
    if (hasPhone && !demo && !line.current) {
      void openLine();
    }
  }, [hasPhone, demo]);
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
  }, [log]);

  const start = async (resume = false) => {
    primeSounds();
    primeCallAudio();
    // Rings from the tap until the line is ready; stopped by the first listening status or a failure
    const stopRinging = startConnecting();
    setDetail(null);
    if (!resume) {
      setTurns([]);
    }
    setMuted(false);
    mutedRef.current = false;
    const handlers = {
      onActivity: log,
      voiceClient: () => (line.current && line.current.status() !== "off" ? ("browser" as const) : ("mobile" as const)),
      onStatus: (next: LiveStatus, info?: string) => {
        debugLog(`status ${next}${info ? ` (${info})` : ""}`);
        if (next !== "connecting") {
          stopRinging();
        }
        statusRef.current = next;
        if (next === "speaking" || next === "thinking") {
          lastSpokeAt.current = Date.now();
        }
        setStatus((previous) => {
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
      if (hasPhone && !demo && !line.current) {
        await openLine();
      }
    } catch (err) {
      stopRinging();
      setStatus("error");
      setDetail(describe(err));
      log("error", describe(err));
    }
  };
  /** Registers this page as the user's phone, so calls ring here while the conversation is open. */
  const openLine = async () => {
    setLineError(null);
    try {
      line.current = await openPhoneLine(
        {
          onActivity: log,
          onPlaybackBlocked: (resume) => setResumeAudio(() => resume),
          // Tell the server the page is on, so the person is dialled even if Twilio's callback is late or lost
          onConferenceJoined: (conference) => {
            conferenceRef.current = conference;
            api.hostAnswered(conference).catch((err) => log("error", `Could not start dialling: ${describe(err)}`));
          },
          onStatus: (next, who) => {
            const wasOnCall = lineStatusRef.current === "connected";
            lineStatusRef.current = next;
            setLineStatus(next);
            setCaller(who ?? null);
            if (next !== "connected") {
              setResumeAudio(null);
            }
            stopRing.current?.();
            stopRing.current = next === "ringing" ? startConnecting() : null;
            if (next === "connected") {
              // The assistant on the line hears the call; the one in this page stays quiet until it ends
              session.current?.setMuted(true);
              log("info", `On a call with ${who ?? "unknown"}`);
            } else if (next === "ready" && wasOnCall) {
              session.current?.setMuted(mutedRef.current);
              log("info", "Call ended");
              const conference = conferenceRef.current;
              conferenceRef.current = null;
              if (conference) {
                void handBackCall(conference);
              }
            } else if (next === "ringing") {
              log("info", `Incoming call from ${who ?? "unknown"}`);
            }
          },
        },
        () => session.current?.micTrack() ?? null,
        // Let the page's assistant finish "Calling now" before the line opens, or it talks over the call
        () => statusRef.current !== "speaking" && Date.now() - lastSpokeAt.current > QUIET_BEFORE_CALL_MS,
        callSink(),
      );
    } catch (err) {
      line.current = null;
      setLineError(describe(err));
      log("error", `Phone line unavailable: ${describe(err)}`);
    }
  };
  /**
   * The call is over: fetch its report and hand it to the assistant in this page. The report is asked
   * for until the assistant's leg has closed too, so the transcript is whole; failing that, after a
   * few seconds the assistant gets what there is rather than nothing.
   */
  const handBackCall = async (conference: string) => {
    const deadline = Date.now() + REPORT_WAIT_MS;
    for (;;) {
      try {
        const report = await api.callReport(conference);
        if (report.ready || Date.now() > deadline) {
          session.current?.tell(callReportNote(report));
          return;
        }
      } catch (err) {
        log("error", `Call report: ${describe(err)}`);
        if (Date.now() > deadline) {
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, REPORT_POLL_MS));
    }
  };
  /** Ends the phone call with the conversation, so no conference keeps running (and billing) unheard. */
  const hangUpCall = () => {
    if (lineStatusRef.current !== "connected") {
      return;
    }
    line.current?.hangUp();
    void api.endCall().catch(() => undefined);
  };
  const stop = () => {
    const wasActive = session.current !== null;
    hangUpCall();
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
    mutedRef.current = next;
    if (lineStatus === "connected") {
      line.current?.setMuted(next);
    } else {
      session.current?.setMuted(next);
    }
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
        <Badge
          color={lineStatus === "connected" ? "indigo" : COLOURS[status]}
          size="2"
          className="assistant-status"
          role="status"
        >
          {lineStatus === "connected" ? "On a call" : LABELS[status]}
        </Badge>
        <Flex align="center" gap="2" wrap="nowrap">
          {hasPhone && !demo && (
            <Badge
              color={lineStatus === "off" ? "amber" : "grass"}
              size="2"
              variant="soft"
              className="assistant-line"
              aria-label={lineStatus === "off" ? "Phone line off" : "Phone line ready"}
              title={lineStatus === "off" ? "Calls cannot open here until the line is up" : "Calls open on this page"}
            >
              <MobileIcon />
            </Badge>
          )}
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
      {lineError && (
        <Callout.Root color="amber" size="1" role="alert">
          <Flex align="center" justify="between" gap="3" wrap="wrap">
            <Callout.Text>Phone line unavailable: {lineError}. Calls cannot open on this page.</Callout.Text>
            <Button size="1" variant="soft" onClick={() => void openLine()}>
              Retry
            </Button>
          </Flex>
        </Callout.Root>
      )}
      {lineStatus === "ringing" && (
        <Callout.Root color="amber" size="1" role="alert">
          <Flex align="center" justify="between" gap="3" wrap="wrap">
            <Callout.Text>Incoming call from {caller}</Callout.Text>
            <Flex gap="2">
              <Button size="1" color="grass" onClick={() => line.current?.answer()}>
                Answer
              </Button>
              <Button size="1" variant="soft" color="red" onClick={() => line.current?.decline()}>
                Decline
              </Button>
            </Flex>
          </Flex>
        </Callout.Root>
      )}
      {lineStatus === "connected" && (
        <Callout.Root color="indigo" size="1" role="status">
          <Flex align="center" justify="between" gap="3" wrap="wrap">
            <Callout.Text>On a call with {caller}</Callout.Text>
            <Flex gap="2">
              {resumeAudio && (
                <Button
                  size="1"
                  color="amber"
                  onClick={() => {
                    resumeAudio();
                    setResumeAudio(null);
                  }}
                >
                  Tap to hear the call
                </Button>
              )}
              <AddToCall onAdded={(name) => log("info", `Dialling ${name} into the call`)} />
              <Button size="1" color="red" onClick={hangUpCall}>
                Hang up
              </Button>
            </Flex>
          </Flex>
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

/** Brings one more person into the call: a contact found by name, or a number typed in. */
function AddToCall({ onAdded }: { onAdded: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const matches = useQuery({
    queryKey: ["contacts", query, false, 1],
    queryFn: () => api.contacts(query, 1, false),
    enabled: open && query.trim().length > 0,
  });
  const add = useMutation({
    mutationFn: (ref: { contact_id?: string; to?: string }) => api.addToCall(ref),
    onSuccess: (placed) => {
      onAdded(placed.contact ?? placed.phone);
      setOpen(false);
      setQuery("");
    },
  });
  const looksLikeNumber = /^[+\d][\d\s()-]{5,}$/.test(query.trim());
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button size="1" variant="soft">
          Add person
        </Button>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="420px">
        <Dialog.Title>Add someone to the call</Dialog.Title>
        <Dialog.Description size="2" color="gray">
          A contact by name, or a number. They are dialled straight into this call.
        </Dialog.Description>
        <Flex direction="column" gap="2" mt="4">
          <TextField.Root
            autoFocus
            aria-label="Name or number"
            placeholder="Name or number"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {looksLikeNumber && (
            <Button variant="soft" onClick={() => add.mutate({ to: query.trim() })} loading={add.isPending}>
              Dial {query.trim()}
            </Button>
          )}
          {matches.data?.contacts.slice(0, 6).map((contact: Contact) => (
            <Button
              key={contact.id}
              variant="soft"
              color="gray"
              onClick={() => add.mutate({ contact_id: contact.id })}
              loading={add.isPending && add.variables?.contact_id === contact.id}
              style={{ justifyContent: "space-between" }}
            >
              <span>
                {contact.name}
                {contact.label ? ` (${contact.label})` : ""}
              </span>
              <span className="mono">{contact.phone}</span>
            </Button>
          ))}
          {add.error && (
            <Text size="2" color="red">
              {describe(add.error)}
            </Text>
          )}
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
