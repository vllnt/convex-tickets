/// <reference types="vite/client" />
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { defineQueue, isTicketsError, toQueueDef } from "../client/index.js";
import type { Party } from "../shared.js";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import schema from "./schema.js";

/**
 * The engine reads rows it did not write in this version: rows from an older
 * deploy, or rows changed by hand in the dashboard. These tests write such rows
 * straight into the component's tables and check the engine tolerates them.
 */
const modules = import.meta.glob("./**/*.ts");
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
    queues: [toQueueDef("q", defineQueue({ fields: { kind: { type: "enum", options: ["a", "b"] } } }))],
  });
  return t;
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function open(t: Setup, title: string): Promise<Id<"tickets">> {
  return await t.mutation(api.mutations.open, { queue: "q", actor: LEAD, title });
}

describe("rows the API never writes", () => {
  test("a blocks link without a target is skipped when its blocker resolves, and unlinking it touches no ticket", async () => {
    const t = await setup();
    const blocker = await open(t, "blocker");
    const linkId = await t.run(
      async (ctx) =>
        await ctx.db.insert("links", { ticketId: blocker, relation: "blocks", createdByRef: LEAD.ref, createdAt: Date.now() }),
    );
    const claim = await t.mutation(api.mutations.claim, { ticketId: blocker, actor: AGENT });
    if (!claim.ok) throw new Error(claim.reason);
    await t.mutation(api.mutations.resolve, {
      ticketId: blocker,
      actor: AGENT,
      claimSeq: claim.claimSeq,
      resolution: "completed",
    });
    await t.mutation(api.mutations.unlink, { linkId });
    expect(await t.run(async (ctx) => await ctx.db.get("links", linkId))).toBeNull();
    const detail = await t.query(api.queries.get, { ticketId: blocker });
    expect(detail?.ticket.category).toBe("done");
  });

  test("a ticket whose blocker row is gone lists no blocker for it", async () => {
    const t = await setup();
    const blocker = await open(t, "blocker");
    const dependent = await t.mutation(api.mutations.open, { queue: "q", actor: LEAD, title: "dependent", blockedBy: [blocker] });
    await t.run(async (ctx) => {
      await ctx.db.delete("tickets", blocker);
    });
    const detail = await t.query(api.queries.get, { ticketId: dependent });
    expect(detail?.blockers).toEqual([]);
    expect(detail?.ticket.openBlockers).toBe(1);
  });

  test("an enum field stored without options refuses every value", async () => {
    const t = await setup();
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("queues")
        .withIndex("by_name", (q) => q.eq("name", "q"))
        .unique();
      if (!row) throw new Error("queue q was not synced");
      await ctx.db.patch("queues", row._id, { fields: row.fields.map(({ options: _options, ...def }) => def) });
    });
    const error: unknown = await t
      .mutation(api.mutations.open, { queue: "q", actor: LEAD, title: "x", fields: { kind: "a" } })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(isTicketsError(error, "INVALID_FIELD")).toBe(true);
    expect(String(error)).toContain("one of ");
  });
});
