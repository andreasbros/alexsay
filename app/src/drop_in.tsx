import { SpeakerLoudIcon, SpeakerOffIcon } from "@radix-ui/react-icons";
import { Button, Dialog, Flex, Text } from "@radix-ui/themes";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type DropInCall, type DropInEnd, type DropInStatus, openDropIn } from "./lib/drop_in";

export interface DropInTarget {
  id: string;
  name: string;
}

interface DropInContextValue {
  /** Opens the drop-in dialog on that speaker and starts it. */
  start: (target: DropInTarget) => void;
  /** True from the first ring until the drop-in has ended: the page's own assistant stays quiet meanwhile. */
  active: boolean;
}

const DropInContext = createContext<DropInContextValue>({ start: () => undefined, active: false });

export const useDropIn = (): DropInContextValue => useContext(DropInContext);

const ENDINGS: Record<DropInEnd, string> = {
  offline: "The speaker is offline.",
  busy: "The speaker is busy with another call.",
  rejected: "Declined at the speaker.",
  no_answer: "Nobody answered.",
  hung_up: "Hung up at the speaker.",
  silence: "Ended after 40 seconds of silence.",
  left: "Ended.",
  lost: "The connection was lost.",
  failed: "Could not start.",
};

interface State {
  target: DropInTarget;
  status: DropInStatus;
  reason?: DropInEnd;
  detail?: string;
  muted: boolean;
  connectedAt: number | null;
}

/**
 * One drop-in at a time, from any page: the Devices list and the assistant's `drop_in` tool both
 * come through here, so the dialog with its mute and hang up is the same wherever it was started.
 */
export function DropInProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State | null>(null);
  const call = useRef<DropInCall | null>(null);

  const start = useCallback((target: DropInTarget) => {
    if (call.current) {
      return;
    }
    setState({ target, status: "connecting", muted: false, connectedAt: null });
    openDropIn(target.id, {
      onStatus: (status, reason, detail) => {
        setState((current) =>
          current
            ? {
                ...current,
                status,
                reason,
                detail,
                connectedAt: status === "connected" ? (current.connectedAt ?? Date.now()) : current.connectedAt,
              }
            : current,
        );
        if (status === "ended") {
          call.current = null;
        }
      },
    })
      .then((opened) => {
        call.current = opened;
      })
      .catch((err: unknown) => {
        call.current = null;
        setState((current) =>
          current
            ? {
                ...current,
                status: "ended",
                reason: "failed",
                detail: err instanceof Error ? err.message : String(err),
              }
            : current,
        );
      });
  }, []);

  const hangUp = () => call.current?.hangUp();
  const toggleMute = () => {
    setState((current) => {
      if (!current) {
        return current;
      }
      call.current?.setMuted(!current.muted);
      return { ...current, muted: !current.muted };
    });
  };
  const close = () => {
    call.current?.hangUp();
    setState(null);
  };

  const value = useMemo(() => ({ start, active: state !== null && state.status !== "ended" }), [start, state]);

  return (
    <DropInContext.Provider value={value}>
      {children}
      {state && <DropInDialog state={state} onHangUp={hangUp} onToggleMute={toggleMute} onClose={close} />}
    </DropInContext.Provider>
  );
}

function DropInDialog({
  state,
  onHangUp,
  onToggleMute,
  onClose,
}: {
  state: State;
  onHangUp: () => void;
  onToggleMute: () => void;
  onClose: () => void;
}) {
  const ended = state.status === "ended";
  return (
    <Dialog.Root open onOpenChange={(open) => !open && ended && onClose()}>
      <Dialog.Content maxWidth="400px" aria-describedby={undefined}>
        <Dialog.Title>Drop in on {state.target.name}</Dialog.Title>
        <Flex direction="column" gap="3" mt="2">
          <Text size="2" color={ended ? "gray" : undefined}>
            <Status state={state} />
          </Text>
          <Flex gap="2" justify="end" mt="2">
            {ended ? (
              <Button variant="soft" color="gray" onClick={onClose}>
                Close
              </Button>
            ) : (
              <>
                <Button
                  variant={state.muted ? "solid" : "soft"}
                  color={state.muted ? "amber" : "gray"}
                  onClick={onToggleMute}
                  disabled={state.status !== "connected"}
                >
                  {state.muted ? <SpeakerOffIcon /> : <SpeakerLoudIcon />}
                  {state.muted ? "Unmute" : "Mute"}
                </Button>
                <Button color="red" onClick={onHangUp}>
                  Hang up
                </Button>
              </>
            )}
          </Flex>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function Status({ state }: { state: State }) {
  const elapsed = useElapsed(state.status === "connected" ? state.connectedAt : null);
  switch (state.status) {
    case "connecting":
      return <>Opening your microphone and reaching the speaker.</>;
    case "ringing":
      return <>The speaker is announcing you and asking whether to accept.</>;
    case "connected":
      return (
        <>
          Connected, {elapsed}. You hear the room and the room hears you. Say "Alexsay" there to ask the assistant
          something or to hang up.
        </>
      );
    case "ended":
      return (
        <>
          {ENDINGS[state.reason ?? "left"]}
          {state.detail ? ` ${state.detail}` : ""}
        </>
      );
    default:
      return null;
  }
}

/** "0:42" since the moment given, ticking once a second. */
function useElapsed(since: number | null): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (since === null) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [since]);
  if (since === null) {
    return "0:00";
  }
  const seconds = Math.max(0, Math.floor((now - since) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
