import { beforeEach, describe, expect, it } from "vitest";
import { assistantCallSession, liveCallSession, sessionConfig } from "../src/providers/openai";
import { openaiSettings } from "../src/schemas";
import { toolDefinitions } from "../src/tools";
import {
  APP,
  addUser,
  connectLightwave,
  connectOpenai,
  json,
  mockUpstream,
  OPENAI_KEY,
  reply,
  resetDb,
  signIn,
} from "./helpers";

const OFFER = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
const LIVE = "POST https://api.openai.com/v1/live/sessions";

interface LiveRequest {
  session: { model: string; audio: unknown; delegation: { responses: { tools: unknown } } };
  transport: { type: string; sdp: string };
}

describe("assistant sessions", () => {
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
  });

  it("needs an OpenAI connection first", async () => {
    const res = await json(`${APP}/api/assistant/sessions`, "POST", { sdp: OFFER }, maria);
    expect(res.status).toBe(412);
    expect(await res.json()).toEqual({ error: "no_openai_connection" });
  });

  it("exchanges the offer for GPT-Live's answer using the stored key", async () => {
    await connectOpenai(maria, { voice: "cedar" });
    let sent: LiveRequest | undefined;
    const upstream = mockUpstream({
      [LIVE]: (req, body) => {
        expect(req.headers.get("authorization")).toBe(`Bearer ${OPENAI_KEY}`);
        sent = JSON.parse(body) as LiveRequest;
        return reply(200, { session: { id: "sess_1" }, transport: { type: "webrtc", sdp: "v=0\r\nanswer" } });
      },
    });
    const res = await json(`${APP}/api/assistant/sessions`, "POST", { sdp: OFFER }, maria);
    upstream.done();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session_id: "sess_1", sdp: "v=0\r\nanswer", tools: [], resumed: false });
    expect(sent?.transport).toEqual({ type: "webrtc", sdp: OFFER });
    expect(sent?.session).toMatchObject({ model: "gpt-live-1", audio: { output: { voice: "cedar" } } });
  });

  it("offers the light tools once Lightwave is connected", async () => {
    await connectOpenai(maria);
    await connectLightwave(maria);
    let sent: LiveRequest | undefined;
    const upstream = mockUpstream({
      [LIVE]: (_req, body) => {
        sent = JSON.parse(body) as LiveRequest;
        return reply(200, { session: { id: "sess_2" }, transport: { type: "webrtc", sdp: "answer" } });
      },
    });
    const res = await json(`${APP}/api/assistant/sessions`, "POST", { sdp: OFFER }, maria);
    upstream.done();
    expect(await res.json()).toMatchObject({ tools: ["lights"] });
    expect(sent?.session.delegation.responses.tools).toEqual([
      { type: "web_search" },
      ...toolDefinitions(true, false, false, false, new Set(["alarms"])),
    ]);
    expect(toolDefinitions(true).map((t) => t.name)).toEqual(
      expect.arrayContaining(["list_lights", "set_light", "set_lights", "dim_light", "dim_lights"]),
    );
    const switchTool = toolDefinitions(true).find((t) => t.name === "set_lights");
    const parameters = switchTool ? (switchTool.parameters as { properties: object }) : { properties: {} };
    expect(Object.keys(parameters.properties)).toEqual(["match", "on"]);
    expect(toolDefinitions(false).map((t) => t.name)).not.toContain("set_lights");
  });

  it("forks the previous session on resume and falls back to a fresh one when it is gone", async () => {
    await connectOpenai(maria);
    const forked = mockUpstream({
      "POST https://api.openai.com/v1/live/sessions/sess_old/fork": (_req, body) => {
        expect((JSON.parse(body) as LiveRequest).transport.sdp).toBe(OFFER);
        return reply(200, { session: { id: "sess_new" }, transport: { type: "webrtc", sdp: "answer" } });
      },
    });
    const res = await json(`${APP}/api/assistant/sessions`, "POST", { sdp: OFFER, resume_from: "sess_old" }, maria);
    forked.done();
    expect(await res.json()).toMatchObject({ session_id: "sess_new", resumed: true });

    const gone = mockUpstream({
      "POST https://api.openai.com/v1/live/sessions/sess_old/fork": () =>
        reply(404, { error: { message: "No such session" } }),
      [LIVE]: () => reply(200, { session: { id: "sess_fresh" }, transport: { type: "webrtc", sdp: "answer" } }),
    });
    const fallback = await json(
      `${APP}/api/assistant/sessions`,
      "POST",
      { sdp: OFFER, resume_from: "sess_old" },
      maria,
    );
    gone.done();
    expect(await fallback.json()).toMatchObject({ session_id: "sess_fresh", resumed: false });
  });

  it("passes GPT-Live's refusal through", async () => {
    await connectOpenai(maria);
    const upstream = mockUpstream({ [LIVE]: () => reply(403, { error: { message: "gpt-live-1 needs a paid tier" } }) });
    const res = await json(`${APP}/api/assistant/sessions`, "POST", { sdp: OFFER }, maria);
    upstream.done();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "provider", status: 403 });
  });

  it("leaves web search out when the user switched it off", () => {
    const config = sessionConfig(openaiSettings.parse({ web_search: false }), []) as {
      delegation: { responses: { tools: unknown[] } };
      instructions: string;
    };
    expect(config.delegation.responses.tools).toEqual([]);
    expect(toolDefinitions(false).map((t) => t.name)).toEqual([
      "end_conversation",
      "remember",
      "forget",
      "list_memories",
      "recall_conversations",
      "read_conversation",
      "find_contact",
      "list_contacts",
      "favourite_contact",
      "update_contact",
      "add_contact",
      "drop_in",
      "list_notifications",
      "mark_notifications_read",
    ]);
    expect(config.instructions).not.toMatch(/search the web/);
  });

  it("tells the model to ignore the room unless addressed, when asked to", () => {
    const quiet = sessionConfig(openaiSettings.parse({ respond_when_addressed: true }), []);
    expect(String(quiet.instructions)).toMatch(/Only respond when someone addresses you by name/);
    const chatty = sessionConfig(openaiSettings.parse({}), []);
    expect(String(chatty.instructions)).not.toMatch(/addresses you by name/);
  });

  it("offers test calls only when allowed, and never the test agent's own tool", () => {
    expect(toolDefinitions(false, true).map((t) => t.name)).not.toContain("call_test");
    const names = toolDefinitions(false, true, false, true).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["call_test", "add_test_agent", "call_report", "call_status"]));
    expect(names).not.toContain("leave_call");
  });

  it("tells a phone-capable assistant that a call exists only as a tool result", () => {
    const withPhone = sessionConfig(openaiSettings.parse({}), toolDefinitions(false, true));
    expect(String(withPhone.instructions)).toMatch(/never say a call is being placed/);
    expect(String(withPhone.instructions)).toMatch(/call call_status/);
    expect(String(sessionConfig(openaiSettings.parse({}), toolDefinitions(false)).instructions)).not.toMatch(
      /place_call/,
    );
  });

  it("tells a music-capable assistant to play through the music tools, never to decline", () => {
    const withMusic = sessionConfig(
      openaiSettings.parse({}),
      toolDefinitions(false, false, false, false, undefined, true),
    );
    expect(String(withMusic.instructions)).toMatch(/call play_music with X at once/);
    expect(String(sessionConfig(openaiSettings.parse({}), toolDefinitions(false)).instructions)).not.toMatch(
      /play_music/,
    );
  });

  it("seats the assistant on a call with its persona, the user's instructions and web search, minus the room rules", () => {
    const settings = openaiSettings.parse({ web_search: true, instructions: "Always answer in Welsh." });
    const tools = toolDefinitions(false, true, false, false, undefined, true);
    const session = assistantCallSession(settings, tools, "You have just joined a phone call with Mum.") as {
      instructions: string;
      audio: { format: unknown };
      delegation: { responses: { tools: { type: string }[]; instructions: string } };
    };
    expect(session.instructions).toContain("Your name is Alexsay");
    expect(session.instructions).toContain("Always answer in Welsh.");
    expect(session.instructions).toContain("You can search the web");
    expect(session.instructions).toContain("call play_music with X at once");
    expect(session.instructions).toMatch(/phone call with Mum\.$/);
    expect(session.instructions).not.toContain("end_conversation");
    expect(session.instructions).not.toContain("background sound");
    expect(session.delegation.responses.tools[0]).toEqual({ type: "web_search" });
    expect(session.audio.format).toEqual({ type: "audio/pcmu", rate: 8000 });
    // A scripted agent keeps its part alone
    const agent = liveCallSession(settings, [], "You are a dentist's receptionist.") as { instructions: string };
    expect(agent.instructions).toBe("You are a dentist's receptionist.");
  });

  it("builds a Responses delegation with the user's instructions appended", () => {
    const tools = toolDefinitions(true);
    const config = sessionConfig(
      openaiSettings.parse({ instructions: "Call me Andreas." }),
      tools,
      "Today is 2026-10-11.",
    );
    expect(config).toMatchObject({
      model: "gpt-live-1",
      delegation: {
        type: "responses",
        responses: {
          model: "gpt-6-luna",
          tool_choice: "auto",
          tools: [{ type: "web_search" }, ...tools],
          reasoning: { effort: "low" },
          text: { verbosity: "low" },
        },
      },
    });
    expect(String(config.instructions)).toMatch(/Call me Andreas\.\n\nToday is 2026-10-11\.$/);
    expect(String(config.instructions)).toMatch(/pronounced "Aleksey"/);
    // GPT-Live's speech layer only ends a session by delegating to the tool, so it must be told to
    expect(String(config.instructions)).toContain("ends only through the end_conversation tool");
  });
});
