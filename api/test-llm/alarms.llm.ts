import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { localParts, nextOccurrence, type Rule } from "../src/schedule";
import { APP, addUser, call, DEVICE_ID, json, resetDb, signIn } from "../test/helpers";

/**
 * The real model with the real session: the instructions, locale and tools a speaker gets from
 * `/v1/device/session`, sent to OpenAI's Responses API exactly as GPT-Live delegates to it. Every
 * function call runs through our own tool endpoint, so this checks the model can drive our tools.
 */

const KEY = (env as unknown as { E2E_OPENAI_API_KEY: string }).E2E_OPENAI_API_KEY;
const TZ = "Europe/London";
const BEDROOM = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const MINUTE = 60_000;

type Item = { type: string; name?: string; arguments?: string; call_id?: string; content?: { text?: string }[] };
type Delegation = Record<string, unknown>;
type AlarmView = {
  id: string;
  kind: string;
  label: string;
  message: string;
  next_at: number | null;
  repeat: string | null;
  speaker: string | null;
};

interface Turn {
  reply: string;
  calls: { name: string; args: Record<string, unknown>; output: Record<string, unknown> }[];
}

/** A conversation with the model, from a speaker (its id sent with every tool call) or from the web app. */
class Conversation {
  private previous: string | undefined;

  constructor(
    private readonly delegation: Delegation,
    private readonly runTool: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) {}

  async say(text: string): Promise<Turn> {
    const turn: Turn = { reply: "", calls: [] };
    let input: unknown = [{ role: "user", content: text }];
    for (let round = 0; round < 6; round++) {
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ ...this.delegation, input, previous_response_id: this.previous }),
      });
      const body = (await res.json()) as { id: string; output?: Item[]; error?: { message: string } };
      if (!res.ok) {
        throw new Error(`OpenAI ${res.status}: ${body.error?.message ?? ""}`);
      }
      this.previous = body.id;
      const calls = (body.output ?? []).filter((item) => item.type === "function_call");
      turn.reply += (body.output ?? [])
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content ?? [])
        .map((part) => part.text ?? "")
        .join(" ");
      if (calls.length === 0) {
        return turn;
      }
      const outputs = [];
      for (const fn of calls) {
        const args = JSON.parse(fn.arguments ?? "{}") as Record<string, unknown>;
        const output = await this.runTool(fn.name ?? "", args);
        turn.calls.push({ name: fn.name ?? "", args, output });
        outputs.push({ type: "function_call_output", call_id: fn.call_id, output: JSON.stringify(output) });
      }
      input = outputs;
    }
    throw new Error("the model kept calling tools");
  }
}

const deviceSession = async (): Promise<Delegation> => {
  const res = await call(`${APP}/v1/device/session`, { headers: { "x-device-id": DEVICE_ID } });
  const { session } = (await res.json()) as { session: { delegation: { responses: Delegation } } };
  return session.delegation.responses;
};

const fromSpeaker = async () =>
  new Conversation(await deviceSession(), async (name, args) => {
    const res = await call(`${APP}/v1/device/tools/call`, {
      method: "POST",
      headers: { "x-device-id": DEVICE_ID },
      body: JSON.stringify({ name, arguments: args }),
    });
    return ((await res.json()) as { output: Record<string, unknown> }).output;
  });

const fromWeb = async (cookie: string) =>
  new Conversation(await deviceSession(), async (name, args) => {
    const res = await json(`${APP}/api/tools/call`, "POST", { name, arguments: args }, cookie);
    return ((await res.json()) as { output: Record<string, unknown> }).output;
  });

const listAlarms = async (cookie: string) =>
  ((await (await call(`${APP}/api/alarms`, {}, cookie)).json()) as { alarms: AlarmView[] }).alarms;

const memories = async (cookie: string) => (await (await call(`${APP}/api/memories`, {}, cookie)).json()) as unknown[];

/** Tomorrow at hh:mm on the London clock. */
const tomorrowAt = (time: string) => {
  const next = nextLocal(time);
  return localClock(Date.now()) < time ? next + 86_400_000 : next;
};

/** The next time the London clock shows hh:mm on one of these days (all days by default). */
const nextLocal = (time: string, days = [0, 1, 2, 3, 4, 5, 6]) =>
  nextOccurrence({ kind: "repeat", time, days, tz: TZ } satisfies Rule, Date.now()) ?? 0;

const localClock = (ms: number) => {
  const p = localParts(ms, TZ);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

describe.skipIf(!KEY)("the model sets alarms through our tools", () => {
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
    await json(`${APP}/api/devices`, "POST", { id: DEVICE_ID, name: "Kitchen" }, maria);
    await json(`${APP}/api/connections/openai`, "PUT", { api_key: KEY }, maria);
    await json(`${APP}/api/session/settings`, "PATCH", { locale: "en-GB", timezone: TZ }, maria);
  });

  /** The one alarm the conversation set; on failure, what the model said and called. */
  const only = async (turn?: Turn) => {
    const alarms = await listAlarms(maria);
    expect(alarms, JSON.stringify({ alarms, reply: turn?.reply, calls: turn?.calls })).toHaveLength(1);
    return alarms[0] as AlarmView;
  };

  const oneOff: [string, () => number, string][] = [
    ["Set an alarm for 9pm", () => nextLocal("21:00"), "alarm"],
    ["Wake me up at 6:45 in the morning", () => nextLocal("06:45"), "alarm"],
    ["Set an alarm for ten past seven this Friday", () => nextLocal("07:10", [5]), "alarm"],
    [
      "Alarm for half past eight tomorrow morning",
      () => nextLocal("08:30") + (localClock(Date.now()) < "08:30" ? 86_400_000 : 0),
      "alarm",
    ],
    ["Set an alarm for 8am on the 25th of December", () => christmas(), "alarm"],
  ];

  it.each(oneOff)("one-off: %s", async (utterance, expected, kind) => {
    const turn = await (await fromSpeaker()).say(utterance);
    const alarm = await only(turn);
    expect(alarm, JSON.stringify(turn.calls)).toMatchObject({
      kind,
      next_at: expected(),
      repeat: null,
      speaker: "Kitchen",
    });
    expect(turn.reply.length).toBeGreaterThan(0);
  });

  // A timer always gets a label (its length by default); a plain alarm may have none
  const relative: [string, number, string, RegExp | null][] = [
    ["Set a timer for 10 minutes", 10 * MINUTE, "timer", /./],
    ["Set a pasta timer for an hour and a half", 90 * MINUTE, "timer", /pasta/i],
    ["Timer, 45 seconds", 45_000, "timer", /./],
    ["Wake me up in 20 minutes", 20 * MINUTE, "alarm|timer", null],
  ];

  it.each(relative)("relative: %s", async (utterance, after, kind, label) => {
    const start = Date.now();
    const turn = await (await fromSpeaker()).say(utterance);
    const alarm = await only(turn);
    expect(alarm.kind, JSON.stringify(turn.calls)).toMatch(new RegExp(`^(${kind})$`));
    if (label) {
      expect(alarm.label).toMatch(label);
    }
    expect(alarm.next_at ?? 0).toBeGreaterThanOrEqual(start + after - 2_000);
    expect(alarm.next_at ?? 0).toBeLessThanOrEqual(Date.now() + after + 2_000);
  });

  it("a reminder with its message", async () => {
    const start = Date.now();
    const turn = await (await fromSpeaker()).say("Remind me in 2 hours to take the bins out");
    const alarm = await only(turn);
    expect(alarm.kind, JSON.stringify(turn.calls)).toBe("reminder");
    expect(`${alarm.message} ${alarm.label}`).toMatch(/bin/i);
    expect(alarm.next_at ?? 0).toBeGreaterThanOrEqual(start + 120 * MINUTE - 2_000);
    expect(alarm.next_at ?? 0).toBeLessThanOrEqual(Date.now() + 120 * MINUTE + 2_000);
    expect(await memories(maria)).toEqual([]);
  });

  it("a reminder at a clock time is an alarm, not a memory", async () => {
    const turn = await (await fromSpeaker()).say("Remind me to call Mum tomorrow at 10am");
    const alarm = await only(turn);
    expect(alarm, JSON.stringify(turn.calls)).toMatchObject({ kind: "reminder", next_at: tomorrowAt("10:00") });
    expect(`${alarm.message} ${alarm.label}`).toMatch(/mum/i);
    expect(turn.calls.map((c) => c.name)).not.toContain("remember");
    expect(await memories(maria)).toEqual([]);
  });

  it("asks when for a reminder without a time, and sets nothing yet", async () => {
    const turn = await (await fromSpeaker()).say("Remind me to buy milk");
    expect(await listAlarms(maria)).toEqual([]);
    expect(await memories(maria)).toEqual([]);
    expect(turn.reply).toMatch(/when|what time/i);
  });

  const repeating: [string, string, string][] = [
    ["Set an alarm for 7:30 every weekday", "07:30", "weekdays at 07:30"],
    ["Wake me at 9 on weekends", "09:00", "weekends at 09:00"],
    ["Set a daily alarm for 6am", "06:00", "daily at 06:00"],
    ["Set an alarm for 6:15 on Mondays and Thursdays", "06:15", "Mon, Thu at 06:15"],
    ["Alarm every Wednesday at quarter to eight in the evening", "19:45", "Wed at 19:45"],
  ];

  it.each(repeating)("repeating: %s", async (utterance, _time, repeat) => {
    const turn = await (await fromSpeaker()).say(utterance);
    const alarm = await only(turn);
    expect(alarm, JSON.stringify(turn.calls)).toMatchObject({ repeat, speaker: "Kitchen" });
  });

  it("confirms with the day and time the server worked out", async () => {
    const turn = await (await fromSpeaker()).say("Set an alarm for 9pm");
    const set = turn.calls.find((c) => c.name === "set_alarm")?.output as { say: string };
    // Within the hour the server says "in 50 minutes (today at 21:00)", so the day may sit in brackets
    expect(set.say).toMatch(/(^|\()(today|tomorrow) at 21:00\)?$/);
    expect(turn.reply).toMatch(/\b(9|21)[:. ]?(00)?\s*(pm|p\.m\.)?/i);
    const day = /(today|tomorrow)/.exec(set.say)?.[1] ?? "today";
    const reply = turn.reply.toLowerCase();
    expect(reply.includes(day) || /\bin \d+ minutes?\b/.test(reply) || reply.includes("tonight")).toBe(true);
  });

  it("asks which speaker from the web when the home has two, then sets it on the one named", async () => {
    await json(`${APP}/api/devices`, "POST", { id: BEDROOM, name: "Bedroom" }, maria);
    const chat = await fromWeb(maria);
    const first = await chat.say("Set an alarm for 9pm");
    expect(await listAlarms(maria)).toEqual([]);
    expect(first.reply).toMatch(/kitchen|bedroom|which/i);
    const second = await chat.say("The bedroom one");
    const alarm = await only();
    expect(alarm, JSON.stringify(second.calls)).toMatchObject({ speaker: "Bedroom", next_at: nextLocal("21:00") });
  });

  it("sets it on the only speaker from the web without asking", async () => {
    const turn = await (await fromWeb(maria)).say("Set an alarm for 9pm");
    const alarm = await only();
    expect(alarm, JSON.stringify(turn.calls)).toMatchObject({ speaker: "Kitchen", next_at: nextLocal("21:00") });
  });

  it("moves an alarm it has just set", async () => {
    const chat = await fromSpeaker();
    await chat.say("Set an alarm for 9pm");
    const turn = await chat.say("Actually make it 9:30");
    const alarm = await only();
    expect(alarm.next_at, JSON.stringify(turn.calls)).toBe(nextLocal("21:30"));
  });
});

function christmas(): number {
  const year = localParts(Date.now(), TZ).year;
  const thisYear = nextOccurrence({ kind: "at", at: Date.UTC(year, 11, 25, 8) }, Date.now());
  return thisYear ?? Date.UTC(year + 1, 11, 25, 8);
}
