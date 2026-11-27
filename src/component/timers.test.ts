/// <reference types="vite/client" />
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { defineQueue, toQueueDef } from "../client/index.js";
import type { Party } from "../shared.js";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import schema from "./schema.js";

/**
 * The lease timers write rows only the component can see, so these tests run at
 * the component root: they count the pending timer jobs and change a queue row
 * the way a dashboard edit would.
 */
const modules = import.meta.glob("./**/*.ts");
const SECOND = 1_000;
const MINUTE = 60_000;
const LEASE = 10 * MINUTE;
const LEAD: Party = { ref: "user:lead", kind: "human" };
const AGENT: Party = { ref: "agent:a", kind: "agent" };

afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  await t.mutation(api.mutations.sync, {
    queues: [toQueueDef("q", defineQueue({ policy: { leaseMs: LEASE, maxReturns: 99 } }))],
  });
  return t;
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function openAndClaim(t: Setup): Promise<{ ticketId: Id<"tickets">; claimSeq: number }> {
  const ticketId = await t.mutation(api.mutations.open, { queue: "q", actor: LEAD, title: "work" });
  const claim = await t.mutation(api.mutations.claim, { ticketId, actor: AGENT });
  if (!claim.ok) throw new Error(claim.reason);
  return { ticketId, claimSeq: claim.claimSeq };
}

async function askAndAnswer(t: Setup, ticketId: Id<"tickets">, claimSeq: number): Promise<void> {
  await t.mutation(api.mutations.requestInput, { ticketId, actor: AGENT, claimSeq, body: "which one?" });
  await t.mutation(api.mutations.reply, { ticketId, actor: LEAD, body: "this one" });
}

async function advance(t: Setup, ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await t.finishInProgressScheduledFunctions();
}

async function pendingLeaseTimers(t: Setup): Promise<number> {
  return await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.filter((job) => job.name.includes("expireLease") && job.state.kind === "pending").length;
  });
}

async function typesOf(t: Setup, ticketId: Id<"tickets">): Promise<string[]> {
  const page = await t.query(api.queries.listTransitions, { ticketId, paginationOpts: { cursor: null, numItems: 100 } });
  return page.page.map((row) => row.type);
}

describe("C: one lease keeps one timer chain", () => {
  test("a resume starts a new lease, and the timer of the old lease ends instead of chaining on", async () => {
    const t = await setup();
    const { ticketId, claimSeq } = await openAndClaim(t);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await advance(t, MINUTE);
      await askAndAnswer(t, ticketId, claimSeq);
    }
    expect(await pendingLeaseTimers(t)).toBe(4);

    await advance(t, LEASE - 3 * MINUTE + 1);
    await advance(t, MINUTE);
    await advance(t, MINUTE);

    expect(await pendingLeaseTimers(t)).toBe(1);
  });

  test("after several input cycles the lease expires once, when the last lease runs out", async () => {
    const t = await setup();
    const { ticketId, claimSeq } = await openAndClaim(t);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await advance(t, MINUTE);
      await askAndAnswer(t, ticketId, claimSeq);
    }
    const renewed = await t.mutation(api.mutations.renew, { ticketId, actor: AGENT, claimSeq });
    if (renewed.expiresAt === null) throw new Error("the queue has a lease, so renew returns an expiry");

    await advance(t, renewed.expiresAt - Date.now() - SECOND);
    expect((await typesOf(t, ticketId)).filter((type) => type === "lease_expired")).toEqual([]);
    await advance(t, 2 * SECOND);

    expect((await typesOf(t, ticketId)).filter((type) => type === "lease_expired")).toEqual(["lease_expired"]);
    expect(await pendingLeaseTimers(t)).toBe(0);
    const detail = await t.query(api.queries.get, { ticketId });
    expect(detail?.ticket).toMatchObject({ category: "unstarted", leaseExpiryCount: 1 });
  });
});

describe("B: a lease timer does nothing in a queue that no longer has a lease", () => {
  test("the timer leaves a started ticket with its holder when the queue's leaseMs is null", async () => {
    const t = await setup();
    const { ticketId, claimSeq } = await openAndClaim(t);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("queues")
        .withIndex("by_name", (q) => q.eq("name", "q"))
        .unique();
      if (!row) throw new Error("queue q was not synced");
      await ctx.db.patch("queues", row._id, { policy: { ...row.policy, leaseMs: null } });
    });

    await advance(t, LEASE + MINUTE);

    expect(await typesOf(t, ticketId)).toEqual(["opened", "claimed"]);
    const detail = await t.query(api.queries.get, { ticketId });
    expect(detail?.ticket).toMatchObject({ category: "started", assigneeRef: AGENT.ref, claimSeq });
  });
});
