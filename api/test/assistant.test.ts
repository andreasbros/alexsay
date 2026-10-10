import { beforeEach, describe, expect, it } from "vitest";
import { sessionConfig } from "../src/providers/openai";
import { LIGHT_TOOLS } from "../src/routes/assistant";
import { openaiSettings } from "../src/schemas";
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
    expect(await res.json()).toEqual({ session_id: "sess_1", sdp: "v=0\r\nanswer", tools: [] });
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
    expect(sent?.session.delegation.responses.tools).toEqual(LIGHT_TOOLS);
  });

  it("passes GPT-Live's refusal through", async () => {
    await connectOpenai(maria);
    const upstream = mockUpstream({ [LIVE]: () => reply(403, { error: { message: "gpt-live-1 needs a paid tier" } }) });
    const res = await json(`${APP}/api/assistant/sessions`, "POST", { sdp: OFFER }, maria);
    upstream.done();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "provider", status: 403 });
  });

  it("builds a Responses delegation with the user's instructions appended", () => {
    const config = sessionConfig(openaiSettings.parse({ instructions: "Call me Andreas." }), LIGHT_TOOLS);
    expect(config).toMatchObject({
      model: "gpt-live-1",
      delegation: { type: "responses", responses: { model: "gpt-5.5", tool_choice: "auto", tools: LIGHT_TOOLS } },
    });
    expect(String(config.instructions)).toMatch(/Call me Andreas\.$/);
  });
});
