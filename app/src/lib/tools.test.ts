import { describe, expect, it, vi } from "vitest";
import type { Light } from "../api";
import { functionCallOf, runTool } from "./tools";

const kitchen: Light = {
  id: "fs1",
  name: "Kitchen",
  device: "Dimmer",
  switch: "f-switch",
  dim: "f-dim",
  on: false,
  dim_level: 20,
};

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

  it("switches and dims a light", async () => {
    const api = { lights: vi.fn(async () => [kitchen]), setFeature: vi.fn(async () => undefined) };
    const output = await runTool(
      { call_id: "c1", name: "set_light", arguments: JSON.stringify({ id: "fs1", on: true, dim_level: 55.4 }) },
      api,
    );
    expect(JSON.parse(output)).toEqual({ ok: true, light: "Kitchen" });
    expect(api.setFeature.mock.calls).toEqual([
      ["f-dim", 55],
      ["f-switch", 1],
    ]);
  });

  it("finds a light by the name the model heard", async () => {
    const bedroom = { ...kitchen, id: "fs2", name: "Bedroom Light 1", dim: null, dim_level: null };
    const api = { lights: vi.fn(async () => [kitchen, bedroom]), setFeature: vi.fn(async () => undefined) };
    const output = await runTool(
      { call_id: "c1", name: "set_light", arguments: JSON.stringify({ name: "bedroom light 1", on: true }) },
      api,
    );
    expect(JSON.parse(output)).toEqual({ ok: true, light: "Bedroom Light 1" });
    expect(api.setFeature.mock.calls).toEqual([["f-switch", 1]]);
    const loose = await runTool(
      { call_id: "c2", name: "set_light", arguments: '{"id":"the kitchen","on":false}' },
      api,
    );
    expect(JSON.parse(loose)).toEqual({ ok: true, light: "Kitchen" });
  });

  it("reports unknown lights and tools without throwing", async () => {
    const api = { lights: vi.fn(async () => [kitchen]), setFeature: vi.fn(async () => undefined) };
    expect(JSON.parse(await runTool({ call_id: "c", name: "set_light", arguments: '{"id":"zz"}' }, api))).toEqual({
      error: "no such light",
      available: [{ id: "fs1", name: "Kitchen" }],
    });
    expect(JSON.parse(await runTool({ call_id: "c", name: "dance", arguments: "nope" }, api))).toEqual({
      error: "unknown tool dance",
    });
  });
});
