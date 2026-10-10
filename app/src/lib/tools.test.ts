import { describe, expect, it, vi } from "vitest";
import { functionCallOf, runTool } from "./tools";

const envelope = (item: unknown) => ({
  type: "response.event",
  delegation_id: "d1",
  event: { type: "response.output_item.done", item },
});

describe("tools", () => {
  it("recognises a function call inside a response.event envelope", () => {
    const call = functionCallOf(envelope({ type: "function_call", call_id: "c1", name: "set_light", arguments: "{}" }));
    expect(call).toEqual({ call_id: "c1", name: "set_light", arguments: "{}" });
    expect(functionCallOf(envelope({ type: "message" }))).toBeNull();
    expect(functionCallOf({ type: "session.output_transcript.delta", delta: "hi" })).toBeNull();
  });

  it("relays the call to the server with parsed arguments and the conversation id", async () => {
    const api = { callTool: vi.fn(async () => ({ output: { ok: true, light: "Kitchen" } })) };
    const output = await runTool(
      { call_id: "c1", name: "set_light", arguments: JSON.stringify({ name: "kitchen", on: true }) },
      api,
      "conv-1",
    );
    expect(JSON.parse(output)).toEqual({ ok: true, light: "Kitchen" });
    expect(api.callTool).toHaveBeenCalledWith("set_light", { name: "kitchen", on: true }, "conv-1");
  });

  it("turns a failed relay into an error the model can read", async () => {
    const api = { callTool: vi.fn(async () => Promise.reject(new Error("offline"))) };
    expect(JSON.parse(await runTool({ call_id: "c", name: "remember", arguments: "nope" }, api, null))).toEqual({
      error: "offline",
    });
    expect(api.callTool).toHaveBeenCalledWith("remember", {}, null);
  });
});
