import { beforeEach, describe, expect, it } from "vitest";
import { APP, addUser, call, json, resetDb, signIn } from "./helpers";

const tool = async (cookie: string, name: string, args: Record<string, unknown>) =>
  (
    (await (await json(`${APP}/api/tools/call`, "POST", { name, arguments: args }, cookie)).json()) as {
      output: unknown;
    }
  ).output;

describe("server log", () => {
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
  });

  it("is off until the user allows it, then shows the assistant what the server did", async () => {
    expect(await (await call(`${APP}/api/session/me`, {}, maria)).json()).toMatchObject({ ai_log_access: false });
    expect(await tool(maria, "read_log", {})).toEqual({ error: "the user has not allowed log access in Settings" });

    const allowed = await json(`${APP}/api/session/settings`, "PATCH", { ai_log_access: true }, maria);
    expect(await allowed.json()).toEqual({ ai_log_access: true, ai_call_test: false });
    expect(await (await call(`${APP}/api/session/me`, {}, maria)).json()).toMatchObject({ ai_log_access: true });

    await tool(maria, "list_memories", {});
    await tool(maria, "set_lights", { match: "kitchen", on: true });
    const read = (await tool(maria, "read_log", {})) as { position: string; lines: string[] };
    expect(read.position).toBe("tail");
    expect(read.lines).toHaveLength(2);
    expect(read.lines[0]).toMatch(/^\d\d:\d\d:\d\d info tool list_memories \{\} -> \[\]$/);
    expect(read.lines[1]).toMatch(/^\d\d:\d\d:\d\d error tool set_lights .*Lightwave is not connected/);
  });

  it("caps at a hundred lines, defaults to five, and reads from either end", async () => {
    await json(`${APP}/api/session/settings`, "PATCH", { ai_log_access: true }, maria);
    for (let i = 0; i < 120; i++) {
      await tool(maria, "list_memories", {});
    }
    const tail = (await tool(maria, "read_log", {})) as { lines: string[] };
    expect(tail.lines).toHaveLength(5);
    const head = (await tool(maria, "read_log", { position: "head", lines: 500 })) as { lines: string[] };
    expect(head.lines).toHaveLength(100);
    const everything = (await tool(maria, "read_log", { position: "tail", lines: 100 })) as { lines: string[] };
    expect(everything.lines).toHaveLength(100);
  });

  it("keeps each user's log private", async () => {
    await addUser("tom", "tom-pass-123", "user");
    const tom = await signIn("tom", "tom-pass-123");
    await json(`${APP}/api/session/settings`, "PATCH", { ai_log_access: true }, tom);
    await tool(maria, "list_memories", {});
    expect(await tool(tom, "read_log", {})).toEqual({ position: "tail", lines: [] });
  });
});
