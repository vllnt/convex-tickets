import { afterEach, describe, expect, test, vi } from "vitest";
import { Tickets, defineQueue } from "../../src/client/index.js";
import type { ClaimResult } from "../../src/client/index.js";
import { components, internal } from "./_generated/api.js";
import { A, B, LEAD, REQ, drain, events, expectCode, setup } from "./harness.helper.js";

afterEach(() => {
  vi.useRealTimers();
});

function seqOf(claim: ClaimResult): number {
  if (!claim.ok) throw new Error(`claim refused: ${claim.reason}`);
  return claim.claimSeq;
}

describe("refused guardrail calls stay bounded", () => {
  test("retrying a refused ping-pong handoff 60 times records one trip and never lets the handoff through", async () => {
    const t = setup();
    const desk = new Tickets(components.tickets, {
      queues: { q: defineQueue({ policy: { leaseMs: null, maxHops: 20 } }) },
      onEvent: internal.hooks.recordOnly,
    });
    const id = await t.run(async (ctx) => {
      await desk.sync(ctx);
      const ticketId = await desk.open(ctx, { queue: "q", actor: REQ, title: "bounce" });
      let seq = seqOf(await desk.claim(ctx, { ticketId, actor: A }));
      for (const [from, to] of [
        [A, B],
        [B, A],
        [A, B],
      ] as const) {
        const result = await desk.handoff(ctx, { ticketId, actor: from, claimSeq: seq, toParty: to });
        if (!result.ok) throw new Error(result.reason);
        seq = result.claimSeq;
      }
      return { ticketId, seq };
    });
    const outcomes = new Set<string>();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const result = await t.run((ctx) => desk.handoff(ctx, { ticketId: id.ticketId, actor: B, claimSeq: id.seq, toParty: A }));
      outcomes.add(result.ok ? "ok" : result.reason);
    }
    expect([...outcomes]).toEqual(["PING_PONG"]);
    const history = await t.run((ctx) =>
      desk.listTransitions(ctx, { ticketId: id.ticketId, paginationOpts: { cursor: null, numItems: 200 } }),
    );
    expect(history.page.filter((row) => row.type === "guardrail_tripped")).toHaveLength(1);
    await drain(t);
    const tripEvents = (await events(t)).filter((e) => e.ticketId === id.ticketId && e.type === "guardrail_tripped");
    expect(tripEvents).toHaveLength(1);
  });

  test("a new trip is recorded again after real work happens on the ticket", async () => {
    const t = setup();
    const desk = new Tickets(components.tickets, {
      queues: { q: defineQueue({ policy: { leaseMs: null, maxMessages: 1 } }) },
      onEvent: internal.hooks.recordOnly,
    });
    const ticketId = await t.run(async (ctx) => {
      await desk.sync(ctx);
      const id = await desk.open(ctx, { queue: "q", actor: REQ, title: "chatty", body: "first" });
      await desk.reply(ctx, { ticketId: id, actor: REQ, body: "again" });
      await desk.reply(ctx, { ticketId: id, actor: REQ, body: "and again" });
      await desk.claim(ctx, { ticketId: id, actor: A });
      await desk.reply(ctx, { ticketId: id, actor: REQ, body: "after the claim" });
      return id;
    });
    const history = await t.run((ctx) => desk.listTransitions(ctx, { ticketId, paginationOpts: { cursor: null, numItems: 50 } }));
    expect(history.page.map((row) => row.type)).toEqual(["opened", "guardrail_tripped", "claimed", "guardrail_tripped"]);
  });
});

test("interleaved refusals of different kinds record each kind once until real work happens", async () => {
  const t = setup();
  const desk = new Tickets(components.tickets, {
    queues: { q: defineQueue({ policy: { leaseMs: null, maxMessages: 1 } }) },
    onEvent: internal.hooks.recordOnly,
  });
  const ticketId = await t.run(async (ctx) => {
    await desk.sync(ctx);
    const id = await desk.open(ctx, { queue: "q", actor: REQ, title: "both", body: "first" });
    let seq = seqOf(await desk.claim(ctx, { ticketId: id, actor: A }));
    for (const [from, to] of [
      [A, B],
      [B, A],
      [A, B],
    ] as const) {
      const result = await desk.handoff(ctx, { ticketId: id, actor: from, claimSeq: seq, toParty: to });
      if (!result.ok) throw new Error(result.reason);
      seq = result.claimSeq;
    }
    for (let round = 0; round < 3; round += 1) {
      const reply = await desk.reply(ctx, { ticketId: id, actor: REQ, body: `again ${round}` });
      expect(reply.ok).toBe(false);
      const handoff = await desk.handoff(ctx, { ticketId: id, actor: B, claimSeq: seq, toParty: A });
      expect(handoff.ok).toBe(false);
    }
    return id;
  });
  const history = await t.run((ctx) => desk.listTransitions(ctx, { ticketId, paginationOpts: { cursor: null, numItems: 50 } }));
  const trips = history.page.filter((row) => row.type === "guardrail_tripped").map((row) => row.reason?.split(":")[0]);
  expect(trips).toEqual(["MESSAGE_LIMIT", "PING_PONG"]);
});

describe("blockers on sealed tickets", () => {
  const sealing = (): Tickets<{ jobs: ReturnType<typeof defineQueue>; open: ReturnType<typeof defineQueue> }> =>
    new Tickets(components.strictTickets, {
      queues: {
        jobs: defineQueue({ policy: { reopenWindowMs: 0 } }),
        open: defineQueue({ policy: { reopenWindowMs: null } }),
      },
    });

  test("a dependent can still drop a link to a blocker that failed and sealed, and becomes claimable", async () => {
    const t = setup();
    const q = sealing();
    await t.run(async (ctx) => {
      await q.sync(ctx);
      const blocker = await q.open(ctx, { queue: "jobs", actor: LEAD, title: "blocker" });
      const dependent = await q.open(ctx, { queue: "open", actor: LEAD, title: "dependent", blockedBy: [blocker] });
      const seq = seqOf(await q.claim(ctx, { ticketId: blocker, actor: A }));
      await q.resolve(ctx, { queue: "jobs", ticketId: blocker, actor: A, claimSeq: seq, resolution: "failed" });
      const detail = await q.get(ctx, { ticketId: dependent });
      const link = detail?.blockers[0];
      if (!link) throw new Error("the dependent lost its blocker link");
      await q.unlink(ctx, { linkId: link.linkId });
      const claim = await q.claim(ctx, { ticketId: dependent, actor: B });
      expect(claim.ok).toBe(true);
    });
  });

  test("open with blockedBy and hold refuse a sealed blocker with SEALED, as link does", async () => {
    const t = setup();
    const q = sealing();
    await t.run(async (ctx) => {
      await q.sync(ctx);
      const done = await q.open(ctx, { queue: "jobs", actor: LEAD, title: "done" });
      const seq = seqOf(await q.claim(ctx, { ticketId: done, actor: A }));
      await q.resolve(ctx, { queue: "jobs", ticketId: done, actor: A, claimSeq: seq, resolution: "completed" });
      await expectCode(q.open(ctx, { queue: "open", actor: LEAD, title: "late", blockedBy: [done] }), "SEALED");
      const holder = await q.open(ctx, { queue: "open", actor: LEAD, title: "holder" });
      const holderSeq = seqOf(await q.claim(ctx, { ticketId: holder, actor: B }));
      await expectCode(q.hold(ctx, { ticketId: holder, actor: B, claimSeq: holderSeq, blockers: [done] }), "SEALED");
      await expectCode(q.link(ctx, { ticketId: done, actor: LEAD, relation: "blocks", toTicketId: holder }), "SEALED");
    });
  });

  test("unlinking a blocks link whose dependent is sealed is still SEALED", async () => {
    const t = setup();
    const q = sealing();
    await t.run(async (ctx) => {
      await q.sync(ctx);
      const blocker = await q.open(ctx, { queue: "open", actor: LEAD, title: "blocker" });
      const dependent = await q.open(ctx, { queue: "jobs", actor: LEAD, title: "dependent", blockedBy: [blocker] });
      await q.cancel(ctx, { ticketId: dependent, actor: LEAD });
      const detail = await q.get(ctx, { ticketId: dependent });
      const link = detail?.blockers[0];
      if (!link) throw new Error("no blocker link");
      await expectCode(q.unlink(ctx, { linkId: link.linkId }), "SEALED");
    });
  });
});

describe("field key length", () => {
  test("a field key of 1024 characters is accepted and one of 1025 is refused with INVALID_QUEUE", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      const ok = new Tickets(components.tickets, { queues: { q: defineQueue({ fields: { ["k".repeat(1024)]: { type: "string" } } }) } });
      await ok.sync(ctx);
      const long = new Tickets(components.strictTickets, {
        queues: { q: defineQueue({ fields: { ["k".repeat(1025)]: { type: "string" } } }) },
      });
      await expectCode(long.sync(ctx), "INVALID_QUEUE");
    });
  });
});
