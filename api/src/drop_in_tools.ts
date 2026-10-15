import { defaultSpeaker } from "./alarms";
import { speakerOnline } from "./telephony";
import type { Tool } from "./tools";

const SPEAKER_NAME = (device: { id: string; name: string }) => device.name || `speaker ${device.id.slice(0, 8)}`;

/**
 * The assistant opens a drop-in from the app: it picks the speaker and the page does the rest (the
 * app's socket to the speaker's line bridge). From a speaker or a phone call there is no page to
 * carry the audio, so the tool says so instead of pretending.
 */
export const DROP_IN_TOOLS: Tool[] = [
  {
    definition: {
      type: "function",
      name: "drop_in",
      description:
        "Drops in on one of the home's speakers from the app: a two-way voice channel like an intercom. The " +
        "speaker announces who is dropping in and asks whether to accept; once accepted both sides hear each " +
        "other until someone hangs up or nobody has spoken for 40 seconds. Use it when the user asks to drop in " +
        "on, call, or talk through a speaker by name. With one speaker, pass nothing; with several, pass the " +
        "name the user said, and if they gave none the result lists them so you can ask. Confirm with `say`.",
      parameters: {
        type: "object",
        properties: { speaker: { type: "string", description: "The speaker's name as the user said it" } },
        additionalProperties: false,
      },
    },
    run: async (c, args) => {
      if (c.device || c.onCall) {
        return { error: "a drop-in opens from the app on a phone or computer, not from a speaker or a call" };
      }
      const named = typeof args.speaker === "string" ? args.speaker.trim() : "";
      const picked = await defaultSpeaker(c, c.user.home, undefined, named);
      if ("error" in picked) {
        return picked;
      }
      const name = SPEAKER_NAME(picked.device);
      if (!(await speakerOnline(c, picked.device.id))) {
        return { error: `${name} is offline: it is not running or has no connection to the server` };
      }
      return {
        ok: true,
        device_id: picked.device.id,
        speaker: name,
        say: `Dropping in on ${name}.`,
        note: "the app is opening the drop-in now; say nothing more until the user speaks again",
      };
    },
  },
];
