import { openaiConnection } from "./connections";
import { connections, conversations, type NewTurn, users } from "./db";
import { logFor } from "./log";
import { contextInstructions, digestConversation, loadContext } from "./memory";
import { ProviderError, sessionConfig } from "./providers/openai";
import { toolByName, toolDefinitions } from "./tools";
import type { ConversationSource, ToolContext, User } from "./types";

export interface Caller {
  env: Env;
  user: User;
  origin: string;
}

export interface BuiltSession {
  apiKey: string;
  session: Record<string, unknown>;
  hasLights: boolean;
  hasPhone: boolean;
}

/** The GPT-Live session body for this user, exactly as the web page gets it, or null without an OpenAI key. */
export async function sessionFor(caller: Caller): Promise<BuiltSession | null> {
  const { env, user } = caller;
  const connection = await openaiConnection({ env }, user.username);
  if (!connection) {
    return null;
  }
  const [hasLights, hasPhone, logAccess, callTest] = await Promise.all([
    connections.get(env.DB, user.username, "lightwave").then((row) => row !== null),
    connections.get(env.DB, user.username, "twilio").then((row) => row !== null),
    users.logAccess(env.DB, user.username),
    users.callTest(env.DB, user.username),
  ]);
  const context = contextInstructions(await loadContext(env.DB, user.username));
  return {
    apiKey: connection.apiKey,
    session: sessionConfig(connection.settings, toolDefinitions(hasLights, hasPhone, logAccess, callTest), context),
    hasLights,
    hasPhone,
  };
}

/** Runs one tool as the user and returns what the model should hear; failures are results too. */
export async function runToolFor(
  context: ToolContext,
  name: string,
  args: Record<string, unknown>,
  conversationId: string | null,
): Promise<unknown> {
  const tool = toolByName(name);
  if (!tool) {
    return { error: `unknown tool ${name}` };
  }
  const scope = { env: context.env };
  try {
    const output = await tool.run(context, args, conversationId);
    if (name !== "read_log") {
      const summary = JSON.stringify(output);
      const failed = summary.includes('"error"');
      void logFor(
        scope,
        context.user.username,
        failed ? "warn" : "info",
        `tool ${name} ${summarise(args)} -> ${summary}`,
      );
    }
    return output;
  } catch (err) {
    const detail = err instanceof ProviderError ? err.detail : err instanceof Error ? err.message : "tool failed";
    console.warn(JSON.stringify({ tool: name, user: context.user.username, error: detail }));
    void logFor(scope, context.user.username, "error", `tool ${name} ${summarise(args)} failed: ${detail}`);
    return { error: detail };
  }
}

const summarise = (args: Record<string, unknown>) => JSON.stringify(args).slice(0, 120);

export async function startConversation(
  env: Env,
  username: string,
  source: ConversationSource,
  deviceId: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  await conversations.create(env.DB, { id, username, source, device_id: deviceId });
  return id;
}

export async function addTurns(env: Env, username: string, id: string, turns: NewTurn[]): Promise<boolean> {
  const row = await conversations.get(env.DB, username, id);
  if (!row) {
    return false;
  }
  await conversations.addTurns(env.DB, row.id, turns);
  return true;
}

/** Closes the record; the summary and memory update run after the response with the user's own key. */
export async function endConversation(
  env: Env,
  executionCtx: Pick<ExecutionContext, "waitUntil">,
  username: string,
  id: string,
): Promise<boolean> {
  const row = await conversations.get(env.DB, username, id);
  if (!row) {
    return false;
  }
  await conversations.end(env.DB, row.id, Date.now());
  const connection = await openaiConnection({ env }, username);
  if (connection && row.summary === null) {
    executionCtx.waitUntil(
      digestConversation(
        env.DB,
        { baseUrl: env.OPENAI_BASE_URL, apiKey: connection.apiKey, model: connection.settings.backend_model },
        username,
        row.id,
      ).catch((err: unknown) => console.warn(JSON.stringify({ digest: row.id, error: String(err) }))),
    );
  }
  return true;
}
