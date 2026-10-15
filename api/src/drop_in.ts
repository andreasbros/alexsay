/**
 * Drop-in: a two-way voice channel from the app to one speaker, like an intercom. The rules that
 * decide when one ends live here, pure, so the line bridge only applies them.
 */

import { decodeMuLaw } from "./mulaw";

/** How long the speaker gets to announce the caller and hear yes or no. */
export const RING_MS = 30_000;
/** Nobody has said anything on either side for this long: the drop-in hangs up by itself. */
export const SILENCE_HANGUP_MS = 40_000;
/** A 20 ms frame with an RMS above this (0 to 1) counts as someone talking. Room noise sits well under 1%. */
export const SPEECH_RMS = 0.01;

/** Ended: the bridge closed the socket itself and nothing more is to be said. */
export type DropInState = "ringing" | "open" | "ended";

/** Why a drop-in ended, as the app and the speaker are told. */
export type DropInEnd = "offline" | "busy" | "rejected" | "no_answer" | "hung_up" | "silence" | "left";

/** What the bridge keeps on the guest's socket, so it survives the object going idle. */
export interface DropIn {
  id: string;
  /** The username of the person dropping in. */
  from: string;
  state: DropInState;
  /** When the offer went to the speaker. */
  since: number;
  /** When either side last sent a frame with speech in it. */
  lastSpeechAt: number;
}

/** Whether the check that runs every few seconds should end the drop-in, and why. */
export function dueToEnd(dropIn: DropIn, now: number): DropInEnd | null {
  if (dropIn.state === "ringing") {
    return now - dropIn.since > RING_MS ? "no_answer" : null;
  }
  if (dropIn.state === "open") {
    return now - dropIn.lastSpeechAt > SILENCE_HANGUP_MS ? "silence" : null;
  }
  return null;
}

/** The loudness (RMS, 0 to 1) of a base64 mu-law frame as the speaker and the app send them. */
export function frameLevel(payload: string): number {
  let bytes: string;
  try {
    bytes = atob(payload);
  } catch {
    return 0;
  }
  if (bytes.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const sample = decodeMuLaw(bytes.charCodeAt(i)) / 32_768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / bytes.length);
}

/** True when the frame carries speech rather than room noise. */
export const hasSpeech = (payload: string): boolean => frameLevel(payload) > SPEECH_RMS;
