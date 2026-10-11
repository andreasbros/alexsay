import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  parseArguments,
  realtimeFunctionCall,
  realtimeSocketUrl,
  runCallTool,
  transcriptLine,
} from "../src/call_agent";
import { APP, addUser, json, resetDb, signIn } from "./helpers";

describe("call agent", () => {
  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
  });

  it("recognises a function call in either realtime event shape", () => {
    expect(
      realtimeFunctionCall({
        type: "response.function_call_arguments.done",
        call_id: "c1",
        name: "end_call",
        arguments: "{}",
      }),
    ).toEqual({ call_id: "c1", name: "end_call", arguments: "{}" });
    expect(
      realtimeFunctionCall({
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "c2", name: "add_to_call", arguments: '{"name":"Dad"}' },
      }),
    ).toEqual({ call_id: "c2", name: "add_to_call", arguments: '{"name":"Dad"}' });
    expect(realtimeFunctionCall({ type: "response.output_audio.delta", delta: "..." })).toBeNull();
    expect(realtimeFunctionCall("nonsense")).toBeNull();
    expect(parseArguments("not json")).toEqual({});
  });

  it("keeps what was said on the call: the assistant's words and everyone else's", () => {
    expect(transcriptLine({ type: "response.output_audio_transcript.done", transcript: " Hello, Mum. " })).toEqual({
      speaker: "assistant",
      text: "Hello, Mum.",
    });
    expect(
      transcriptLine({ type: "conversation.item.input_audio_transcription.completed", transcript: "Who is this?" }),
    ).toEqual({ speaker: "line", text: "Who is this?" });
    expect(transcriptLine({ type: "response.output_audio_transcript.delta", delta: "Hel" })).toBeNull();
    expect(
      transcriptLine({ type: "conversation.item.input_audio_transcription.completed", transcript: " " }),
    ).toBeNull();
  });

  it("opens the realtime socket over https, which is how Workers upgrade to a WebSocket", () => {
    expect(realtimeSocketUrl("https://api.openai.com/v1", "rtc_1")).toBe(
      "https://api.openai.com/v1/realtime?call_id=rtc_1",
    );
    expect(realtimeSocketUrl("wss://api.openai.com/v1", "rtc 2")).toBe(
      "https://api.openai.com/v1/realtime?call_id=rtc%202",
    );
  });

  it("runs the registry's tools for the user on the call and turns failures into results", async () => {
    const maria = await signIn("maria", "maria-pass");
    await json(`${APP}/api/contacts`, "POST", { name: "Mum", phone: "07700900123", note: "Sister" }, maria);
    const context = { env, user: { username: "maria", role: "user" as const }, origin: APP, voice: "browser" as const };
    const found = JSON.parse(
      await runCallTool(context, { call_id: "c1", name: "find_contact", arguments: '{"query":"mum"}' }),
    ) as { name: string }[];
    expect(found).toEqual([expect.objectContaining({ name: "Mum", note: "Sister" })]);
    expect(JSON.parse(await runCallTool(context, { call_id: "c2", name: "end_call", arguments: "{}" }))).toEqual({
      error: "Twilio is not connected",
    });
    expect(JSON.parse(await runCallTool(context, { call_id: "c3", name: "dance", arguments: "{}" }))).toEqual({
      error: "unknown tool dance",
    });
  });
});
