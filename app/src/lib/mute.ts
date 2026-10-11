/** What the user asked for and whether a phone call is connected right now. */
export interface MuteState {
  muted: boolean;
  onCall: boolean;
}

interface Mutable {
  setMuted: (muted: boolean) => void;
}

/** The conversation's microphone is off during a call (the assistant on the line hears the call) and when the user muted. */
export const sessionMuted = ({ muted, onCall }: MuteState): boolean => muted || onCall;

/** The call's microphone follows the user alone. */
export const lineMuted = ({ muted }: MuteState): boolean => muted;

/**
 * One place that sets both microphones from the state, so a toggle, a call connecting or ending, and
 * a conversation starting or resuming all leave them exactly as they should be.
 */
export function applyMuteState(state: MuteState, session: Mutable | null, line: Mutable | null): void {
  session?.setMuted(sessionMuted(state));
  line?.setMuted(lineMuted(state));
}
