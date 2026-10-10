import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { contextInstructions, loadContext } from "../src/memory";
import { APP, addUser, call, connectOpenai, json, mockUpstream, reply, resetDb, signIn } from "./helpers";

const DIGEST = {
  summary: "Andreas asked for the kitchen lights and they were switched on.",
  memories: [
    { op: "add", id: "", category: "preferences", content: "Likes the kitchen lights dimmed to 40% in the evening" },
    { op: "add", id: "", category: "people", content: "Lives with Maria" },
  ],
};

const responsesReply = (digest: unknown) =>
  reply(200, { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(digest) }] }] });

describe("conversations and memory", () => {
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
  });

  async function talk(): Promise<string> {
    const started = await json(`${APP}/api/conversations`, "POST", { source: "app" }, maria);
    expect(started.status).toBe(201);
    const { id } = (await started.json()) as { id: string };
    const turns = await json(
      `${APP}/api/conversations/${id}/turns`,
      "POST",
      {
        turns: [
          { at: 1000, role: "user", text: "Turn on the kitchen lights" },
          { at: 2000, role: "tool", text: 'set_lights {"match":"kitchen","on":true}' },
          { at: 3000, role: "assistant", text: "Done, both kitchen lights are on." },
        ],
      },
      maria,
    );
    expect(turns.status).toBe(204);
    return id;
  }

  it("records turns, lists newest first and reads a transcript back", async () => {
    const id = await talk();
    const list = (await (await call(`${APP}/api/conversations`, {}, maria)).json()) as {
      id: string;
      turn_count: number;
    }[];
    expect(list).toEqual([expect.objectContaining({ id, turn_count: 3, source: "app" })]);
    const one = (await (await call(`${APP}/api/conversations/${id}`, {}, maria)).json()) as {
      turns: { text: string }[];
    };
    expect(one.turns.map((t) => t.text)).toEqual([
      "Turn on the kitchen lights",
      'set_lights {"match":"kitchen","on":true}',
      "Done, both kitchen lights are on.",
    ]);
    const found = (await (await call(`${APP}/api/conversations?q=kitchen`, {}, maria)).json()) as unknown[];
    expect(found).toHaveLength(1);
    expect(await (await call(`${APP}/api/conversations?q=garage`, {}, maria)).json()).toEqual([]);
  });

  it("summarises an ended conversation and grows the memory with the user's own key", async () => {
    await connectOpenai(maria);
    const id = await talk();
    const upstream = mockUpstream({
      "POST https://api.openai.com/v1/responses": (req, body) => {
        expect(req.headers.get("authorization")).toBe("Bearer sk-test-0123456789abcdefghijklmnop");
        const sent = JSON.parse(body) as { model: string; input: string; text: { format: { name: string } } };
        expect(sent.model).toBe("gpt-6-luna");
        expect(sent.input).toContain("Turn on the kitchen lights");
        expect(sent.text.format.name).toBe("digest");
        return responsesReply(DIGEST);
      },
    });
    const ended = await call(`${APP}/api/conversations/${id}/end`, { method: "POST" }, maria);
    expect(ended.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 50));
    upstream.done();
    const row = await env.DB.prepare("SELECT summary, ended_at FROM conversations WHERE id = ?").bind(id).first();
    expect(row).toMatchObject({ summary: DIGEST.summary });
    const stored = (await (await call(`${APP}/api/memories`, {}, maria)).json()) as {
      category: string;
      content: string;
    }[];
    expect(stored.map((m) => m.category).sort()).toEqual(["people", "preferences"]);
  });

  it("feeds memories and recent conversations into the next session's instructions", async () => {
    await json(
      `${APP}/api/memories`,
      "POST",
      { category: "important", content: "Never switch off the hall light at night" },
      maria,
    );
    await json(`${APP}/api/memories`, "POST", { category: "people", content: "Lives with Maria" }, maria);
    const id = await talk();
    await env.DB.prepare("UPDATE conversations SET summary = ?, ended_at = ? WHERE id = ?")
      .bind("Kitchen lights were switched on.", 4000, id)
      .run();
    const text = contextInstructions(await loadContext(env.DB, "maria"), new Date("2026-10-11T10:00:00Z"));
    expect(text).toMatch(/^Today is 2026-10-11\./);
    expect(text).toMatch(/important:\n- Never switch off the hall light at night/);
    expect(text).toMatch(/people:\n- Lives with Maria/);
    expect(text).toMatch(/Recent conversations, newest first:\n- \d{4}-\d{2}-\d{2}: Kitchen lights were switched on\./);
    expect(text).toMatch(/How the last conversation ended:\nuser: Turn on the kitchen lights/);
    expect(text).toMatch(/Memory tools: remember/);
  });

  it("lets the user edit and delete memories", async () => {
    const created = await json(
      `${APP}/api/memories`,
      "POST",
      { category: "facts", content: "Birthday is 3 May" },
      maria,
    );
    const { id } = (await created.json()) as { id: string };
    expect((await json(`${APP}/api/memories/${id}`, "PATCH", { category: "important" }, maria)).status).toBe(204);
    const list = (await (await call(`${APP}/api/memories`, {}, maria)).json()) as { category: string }[];
    expect(list[0]?.category).toBe("important");
    expect((await call(`${APP}/api/memories/${id}`, { method: "DELETE" }, maria)).status).toBe(204);
    expect((await call(`${APP}/api/memories/${id}`, { method: "DELETE" }, maria)).status).toBe(404);
  });

  it("runs the memory and history tools through the tool endpoint", async () => {
    const id = await talk();
    const remembered = await json(
      `${APP}/api/tools/call`,
      "POST",
      { name: "remember", arguments: { category: "routines", content: "Wakes at seven" }, conversation_id: id },
      maria,
    );
    expect(await remembered.json()).toMatchObject({ output: { ok: true } });
    const listed = (await (
      await json(`${APP}/api/tools/call`, "POST", { name: "list_memories", arguments: {} }, maria)
    ).json()) as { output: { id: string; content: string }[] };
    expect(listed.output).toEqual([expect.objectContaining({ content: "Wakes at seven" })]);
    const forgotten = await json(
      `${APP}/api/tools/call`,
      "POST",
      { name: "forget", arguments: { id: listed.output[0]?.id } },
      maria,
    );
    expect(await forgotten.json()).toEqual({ output: { ok: true } });
    const recalled = (await (
      await json(
        `${APP}/api/tools/call`,
        "POST",
        { name: "recall_conversations", arguments: { query: "kitchen" } },
        maria,
      )
    ).json()) as { output: { id: string; summary: string }[] };
    expect(recalled.output).toEqual([expect.objectContaining({ id, summary: "(no summary yet)" })]);
    const read = await json(`${APP}/api/tools/call`, "POST", { name: "read_conversation", arguments: { id } }, maria);
    expect(await read.json()).toMatchObject({
      output: { turns: expect.arrayContaining(["user: Turn on the kitchen lights"]) },
    });
    expect(await (await json(`${APP}/api/tools/call`, "POST", { name: "dance", arguments: {} }, maria)).json()).toEqual(
      {
        output: { error: "unknown tool dance" },
      },
    );
  });

  it("runs the light tools server side with a clear error when Lightwave is missing", async () => {
    const res = await json(
      `${APP}/api/tools/call`,
      "POST",
      { name: "set_lights", arguments: { match: "kitchen", on: true } },
      maria,
    );
    expect(await res.json()).toEqual({ output: { error: "Lightwave is not connected" } });
  });
});
