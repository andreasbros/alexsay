import { DurableObject } from "cloudflare:workers";
import { verifyAlarm } from "./alarms";
import { type JobRow, jobs, runAt } from "./jobs";
import { logFor } from "./log";
import { parseRule } from "./schedule";
import type { Scope } from "./types";

/** Runs a job: `occurrence` is when its rule fired (the run itself comes delay_ms later). Must be idempotent. */
export type JobHandler = (scope: Scope, job: JobRow, occurrence: number) => Promise<void>;

/** The router: which handler runs each topic. A skill adds its topics here. */
export const ROUTES: Record<string, JobHandler> = {
  "alarm.verify": verifyAlarm,
};

/** Jobs due this close together run in the same wake-up. */
const SLACK_MS = 500;

/**
 * One per user: keeps a single storage alarm at the user's earliest job, runs what is due through the
 * router when it fires, moves each job on, and sets the alarm again. Durable Object alarms are delivered
 * at least once, so handlers are idempotent; a handler that throws is logged and its job still moves on.
 */
export class Scheduler extends DurableObject<Env> {
  /** Sets the alarm to the user's earliest job, or clears it when nothing is scheduled. */
  async sync(username: string): Promise<void> {
    await this.ctx.storage.put("username", username);
    const earliest = await jobs.earliest(this.env.DB, username);
    if (earliest === null) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Math.max(earliest, Date.now()));
    }
  }

  async alarm(): Promise<void> {
    const username = await this.ctx.storage.get<string>("username");
    if (!username) {
      return;
    }
    await runDue({ env: this.env }, username, Date.now());
    await this.sync(username);
  }
}

/** Runs every job due by `now` and moves each to its next run. */
export async function runDue(scope: Scope, username: string, now: number): Promise<number> {
  const due = await jobs.due(scope.env.DB, username, now + SLACK_MS);
  for (const job of due) {
    const occurrence = (job.next_at ?? now) - job.delay_ms;
    const handler = ROUTES[job.topic];
    try {
      if (!handler) {
        throw new Error(`no handler for ${job.topic}`);
      }
      await handler(scope, job, occurrence);
    } catch (err) {
      await logFor(scope, username, "error", `scheduler: ${job.topic} job ${job.id} failed: ${String(err)}`);
    }
    const rule = parseRule(job.rule);
    await jobs.advance(scope.env.DB, job.id, rule ? runAt(rule, job.delay_ms, occurrence) : null, now);
  }
  return due.length;
}
