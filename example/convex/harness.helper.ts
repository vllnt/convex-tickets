/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, vi } from "vitest";
import { Tickets, defineQueue, isTicketsError } from "../../src/client/index.js";
import type { Party, TicketsErrorCode } from "../../src/client/index.js";
import { deskQueue, projectQueue } from "../../src/client/presets.js";
import { register } from "../../src/test.js";
import { components, internal } from "./_generated/api.js";
import schema from "./schema.js";

/**
 * Shared test setup. This file has two dots in its name, so the Convex bundler
 * skips it and it never deploys; vitest only runs `*.test.ts`.
 */
export const modules = import.meta.glob("./**/*.ts");

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A fresh backend with fake timers and both mounts registered. Call `vi.useRealTimers()` in afterEach. */
export function setup() {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  register(t, "tickets");
  register(t, "strictTickets");
  return t;
}
export type T = ReturnType<typeof setup>;

/**
 * Run every scheduled function that is due within `ms` (default: now), repeatedly,
 * so hooks that schedule more work also run. Long timers (leases, due times,
 * seals) only fire when `ms` reaches them.
 */
export async function drain(t: T, ms = 1): Promise<void> {
  vi.advanceTimersByTime(ms);
  for (let i = 0; i < 25; i += 1) {
    await t.finishInProgressScheduledFunctions();
    vi.advanceTimersByTime(1);
  }
  await t.finishInProgressScheduledFunctions();
}

/** Parties used across the tests. */
export const A: Party = { ref: "agent:a", kind: "agent" };
export const B: Party = { ref: "agent:b", kind: "agent" };
export const C: Party = { ref: "agent:c", kind: "agent" };
export const HUMAN: Party = { ref: "user:h", kind: "human" };
export const LEAD: Party = { ref: "user:lead", kind: "human" };
export const REQ: Party = { ref: "agent:requester", kind: "agent" };

/**
 * A client for library tests, on the `tickets` mount, with a hook that only
 * records events (no agent waking). Covers lease on and off, default and custom
 * states, an escalation target and a queue that seals at once.
 */
export const lab = new Tickets(components.tickets, {
  queues: {
    agent: defineQueue({
      fields: {
        amount: { type: "number", required: true },
        currency: { type: "enum", options: ["EUR", "USD"] },
        note: { type: "string" },
        urgent: { type: "boolean" },
      },
      result: { ok: { type: "boolean", required: true }, ref: { type: "string" } },
      policy: { escalateTo: "humans", maxHops: 6, maxReturns: 3 },
    }),
    people: defineQueue({ policy: { leaseMs: null } }),
    humans: defineQueue(deskQueue()),
    proj: defineQueue(projectQueue({ fields: { estimate: { type: "number" } } })),
    instant: defineQueue({ policy: { reopenWindowMs: 0 } }),
  },
  onEvent: internal.hooks.recordOnly,
});

/** Sync `lab` into the backend. */
export async function syncLab(t: T): Promise<void> {
  await t.run(async (ctx) => {
    await lab.sync(ctx);
  });
}

/** Assert a promise rejects with one coded tickets error. */
export async function expectCode(promise: Promise<unknown>, code: TicketsErrorCode): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isTicketsError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
}

/** Read every hook event the app recorded, in arrival order. */
export async function events(t: T) {
  return await t.run(async (ctx) => await ctx.db.query("ticketEvents").collect());
}
