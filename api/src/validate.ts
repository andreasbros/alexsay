import type { Context } from "hono";
import type { z } from "zod";

export class BadRequest extends Error {
  constructor(readonly issues: unknown) {
    super("bad_request");
  }
}

export async function jsonBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const body: unknown = await c.req.json().catch(() => undefined);
  return parse(schema, body);
}

export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequest(result.error.issues);
  }
  return result.data;
}
