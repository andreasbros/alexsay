import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { CallAgent as CloudCallAgent } from "../call_agent";
import { hashPassword } from "../crypto";
import { purgeExpired } from "../db";
import api from "../index";
import { LineBridge as CloudLineBridge } from "../line_bridge";
import { Scheduler as CloudScheduler } from "../scheduler";
import { assetsBinding } from "./assets";
import { D1Shim, type D1Store } from "./d1";

export { D1Store } from "./d1";

/**
 * The self-hosted server's entry: the same Worker that runs on Cloudflare, given D1 (on a Durable
 * Object's SQLite), the app's assets (from disk) and its secrets by workerd. Nothing in the API knows
 * which of the two it runs on.
 */
interface SelfHostEnv extends Omit<Env, "DB" | "ASSETS"> {
  D1_STORE: DurableObjectNamespace<D1Store>;
  ASSETS_DISK: Fetcher;
  ADMIN_TOKEN: string;
}

const envs = new WeakMap<object, Env>();

export function envFor(raw: SelfHostEnv): Env {
  let env = envs.get(raw);
  if (!env) {
    env = {
      ...raw,
      DB: new D1Shim(raw.D1_STORE) as unknown as D1Database,
      ASSETS: assetsBinding(raw.ASSETS_DISK),
    } as unknown as Env;
    envs.set(raw, env);
  }
  return env;
}

export class CallAgent extends CloudCallAgent {
  constructor(ctx: DurableObjectState, env: SelfHostEnv) {
    super(ctx, envFor(env));
  }
}

export class LineBridge extends CloudLineBridge {
  constructor(ctx: DurableObjectState, env: SelfHostEnv) {
    super(ctx, envFor(env));
  }
}

export class Scheduler extends CloudScheduler {
  constructor(ctx: DurableObjectState, env: SelfHostEnv) {
    super(ctx, envFor(env));
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

const NewUser = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_.-]{2,32}$/),
  password: z.string().min(8),
  role: z.enum(["admin", "user"]).default("user"),
});

/**
 * Housekeeping for the `alexsay-server` command, on a socket bound to the loopback address only and
 * guarded by a token the launcher generates: accounts and the nightly purge.
 */
export class Admin extends WorkerEntrypoint<SelfHostEnv> {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("authorization") !== `Bearer ${this.env.ADMIN_TOKEN}` || !this.env.ADMIN_TOKEN) {
      return json({ error: "forbidden" }, 403);
    }
    const env = envFor(this.env);
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") {
      await env.DB.prepare("SELECT 1").first();
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/scheduled") {
      await purgeExpired(env.DB, Date.now());
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/users") {
      const parsed = NewUser.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return json({ error: "username: 2-32 of a-z 0-9 _ . -; password: at least 8 characters" }, 400);
      }
      const { username, password, role } = parsed.data;
      const hash = await hashPassword(password);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (username) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role`,
        ).bind(username, hash, role, Date.now()),
        env.DB.prepare("DELETE FROM sessions WHERE username = ?").bind(username),
      ]);
      return json({ ok: true, username, role });
    }
    return json({ error: "not_found" }, 404);
  }
}

export default {
  fetch(request: Request, env: SelfHostEnv, ctx: ExecutionContext) {
    return api.fetch(request, envFor(env), ctx);
  },
} satisfies ExportedHandler<SelfHostEnv>;
