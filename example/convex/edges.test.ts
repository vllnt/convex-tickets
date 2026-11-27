import { componentsGeneric } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Tickets, defineQueue, isTicketsError, toQueueDef } from "../../src/client/index.js";
import type { ClaimResult } from "../../src/client/index.js";
import { ticketTools } from "../../src/client/tools.js";
import { api, components, internal } from "./_generated/api.js";
import { A, B, DAY, HOUR, LEAD, MINUTE, drain, events, expectCode, lab, setup, syncLab } from "./harness.helper.js";
import type { T } from "./harness.helper.js";
import { parties, strictTickets, tickets } from "./tickets.js";

afterEach(() => {
  vi.useRealTimers();
});

function seqOf(claim: ClaimResult): number {
  if (!claim.ok) throw new Error(`claim refused: ${claim.reason}`);
  return claim.claimSeq;
}

function purgeRef() {
  const ref = componentsGeneric().strictTickets?.internal_mutations?.purge;
  if (!ref) throw new Error("the strictTickets mount has no purge function");
  return ref;
}

async function purgeAll(t: T): Promise<void> {
  for (let pass = 0; pass < 20; pass += 1) {
    const result = await t.mutation(purgeRef(), {});
    if (!result.more) return;
  }
}

describe("the example agent and inbox on unusual tickets", () => {
  test("the billing agent leaves a refund alone when its claim is refused because the refund is blocked", async () => {
    const t = setup();
    await t.mutation(internal.example.syncTickets, {});
    const refundId = await t.mutation(api.example.openRefund, {
      conversationId: "blocked",
      customerRef: "customer:9",
      amount: 3,
      currency: "EUR",
    });
    await t.run(async (ctx) => {
      const blockerId = await tickets.open(ctx, { queue: "approvals", actor: parties.lead, title: "first", fields: { amount: 1 } });
      await tickets.link(ctx, { ticketId: blockerId, actor: parties.lead, relation: "blocks", toTicketId: refundId });
    });
    await t.mutation(internal.example.runBillingAgent, { ticketId: refundId });
    const detail = await t.run((ctx) => tickets.get(ctx, { ticketId: refundId }));
    expect(detail?.ticket).toMatchObject({ category: "unstarted", openBlockers: 1 });
    expect(detail?.ticket.assigneeRef).toBeUndefined();
  });

  test("a refund handed in without an amount or currency asks for an approval of 0", async () => {
    const t = setup();
    await t.mutation(internal.example.syncTickets, {});
    const ticketId = await t.run(async (ctx) => {
      const id = await tickets.open(ctx, { queue: "eng", actor: parties.lead, title: "customer wants money back" });
      const seq = seqOf(await tickets.claim(ctx, { ticketId: id, actor: parties.coder }));
      await tickets.handoff(ctx, {
        ticketId: id,
        actor: parties.coder,
        claimSeq: seq,
        toQueue: "billing",
        fields: { orderId: "C-1" },
      });
      return id;
    });
    expect(await t.query(api.example.refundOutcome, { ticketId })).toEqual({
      state: "open",
      refunded: undefined,
      refundId: undefined,
    });
    await drain(t);
    const inbox = await t.query(api.example.approvalsInbox, { paginationOpts: { cursor: null, numItems: 10 } });
    expect(inbox).toEqual([expect.objectContaining({ title: "Approve a refund of 0 ", amount: 0 })]);
  });

  test("the approvals inbox shows 0 for a ticket handed in without an amount", async () => {
    const t = setup();
    await t.mutation(internal.example.syncTickets, {});
    await t.run(async (ctx) => {
      const id = await tickets.open(ctx, { queue: "eng", actor: parties.lead, title: "approve this" });
      const seq = seqOf(await tickets.claim(ctx, { ticketId: id, actor: parties.coder }));
      await tickets.handoff(ctx, { ticketId: id, actor: parties.coder, claimSeq: seq, toQueue: "approvals" });
    });
    const inbox = await t.query(api.example.approvalsInbox, { paginationOpts: { cursor: null, numItems: 10 } });
    expect(inbox).toEqual([expect.objectContaining({ title: "approve this", amount: 0 })]);
  });

  test("the approvals inbox skips a ticket whose fields do not fit the app's queue definition", async () => {
    const t = setup();
    const stale = new Tickets(components.tickets, {
      queues: { approvals: defineQueue({ fields: { amount: { type: "string" } } }) },
    });
    await t.run(async (ctx) => {
      await stale.sync(ctx);
      await stale.open(ctx, { queue: "approvals", actor: LEAD, title: "typed by an older deploy", fields: { amount: "lots" } });
    });
    const inbox = await t.query(api.example.approvalsInbox, { paginationOpts: { cursor: null, numItems: 10 } });
    expect(inbox).toEqual([]);
  });
});

describe("the list tool's title search", () => {
  test("by: search finds tickets by title words, in one queue and category when given", async () => {
    const t = setup();
    await syncLab(t);
    await t.run(async (ctx) => {
      await lab.open(ctx, { queue: "people", actor: LEAD, title: "printer on fire" });
      await lab.open(ctx, { queue: "humans", actor: LEAD, title: "printer jammed" });
      await lab.open(ctx, { queue: "people", actor: LEAD, title: "coffee machine" });
    });
    const list = ticketTools(lab, { party: A }).list;
    const all = await t.run((ctx) => list.handler(ctx, { by: "search", value: "printer" }));
    expect(all.isDone).toBe(true);
    expect(all.continueCursor).toBe("");
    expect(all.page.map((row) => row.title).sort()).toEqual(["printer jammed", "printer on fire"]);
    const one = await t.run((ctx) =>
      list.handler(ctx, { by: "search", value: "printer", queue: "people", category: "unstarted", numItems: 500 }),
    );
    expect(one.page.map((row) => row.title)).toEqual(["printer on fire"]);
  });
});

describe("a mount without a hook", () => {
  test("transitions still record history, and nothing is scheduled for the host", async () => {
    const t = setup();
    const quiet = new Tickets(components.tickets, { queues: { q: defineQueue({}) } });
    const ticketId = await t.run(async (ctx) => {
      await quiet.sync(ctx);
      const id = await quiet.open(ctx, { queue: "q", actor: LEAD, title: "silent" });
      await quiet.claim(ctx, { ticketId: id, actor: A });
      return id;
    });
    await drain(t);
    expect(await events(t)).toEqual([]);
    const history = await t.run((ctx) => quiet.listTransitions(ctx, { ticketId, paginationOpts: { cursor: null, numItems: 10 } }));
    expect(history.page.map((row) => row.type)).toEqual(["opened", "claimed"]);
  });
});

describe("configuration edges", () => {
  test("before any sync a mount has no queues, so open is UNKNOWN_QUEUE", async () => {
    const t = setup();
    await expectCode(
      t.run((ctx) => strictTickets.open(ctx, { queue: "jobs", actor: LEAD, title: "too early" })),
      "UNKNOWN_QUEUE",
    );
  });

  test("hold is NO_LANDING_STATE in a queue whose only waiting state waits on the requester", async () => {
    const t = setup();
    const askOnly = new Tickets(components.tickets, {
      queues: {
        ask: defineQueue({
          states: {
            open: { category: "unstarted" },
            doing: { category: "started" },
            asked: { category: "waiting", on: "requester" },
            done: { category: "done" },
            dropped: { category: "canceled" },
          },
        }),
      },
    });
    await t.run(async (ctx) => {
      await askOnly.sync(ctx);
      const id = await askOnly.open(ctx, { queue: "ask", actor: LEAD, title: "x" });
      const seq = seqOf(await askOnly.claim(ctx, { ticketId: id, actor: A }));
      await expectCode(askOnly.hold(ctx, { ticketId: id, actor: A, claimSeq: seq, waitingOn: "external" }), "NO_LANDING_STATE");
    });
  });
});

describe("queue definitions", () => {
  test("states given as an array are refused with INVALID_QUEUE instead of becoming states named 0, 1, 2", () => {
    const error: unknown = (() => {
      try {
        toQueueDef("arr", { states: [{ category: "unstarted" }, { category: "started" }] });
        return undefined;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(isTicketsError(error, "INVALID_QUEUE")).toBe(true);
    expect(String(error)).toContain("not an array");
  });
});

describe("retention edges", () => {
  test("a due timer for a ticket the purge already deleted does nothing", async () => {
    const t = setup();
    const due = new Tickets(components.strictTickets, {
      queues: { due: defineQueue({ policy: { dueInMs: 2 * DAY, reopenWindowMs: 0 } }) },
      retentionMs: HOUR,
    });
    const ticketId = await t.run(async (ctx) => {
      await due.sync(ctx);
      const id = await due.open(ctx, { queue: "due", actor: LEAD, title: "gone before due" });
      await due.cancel(ctx, { ticketId: id, actor: LEAD });
      return id;
    });
    vi.advanceTimersByTime(HOUR + MINUTE);
    await purgeAll(t);
    expect(await t.run((ctx) => due.get(ctx, { ticketId }))).toBeNull();
    await drain(t, 2 * DAY);
    expect(await t.run((ctx) => due.get(ctx, { ticketId }))).toBeNull();
  });

  test("purging a blocker drops its link to a sealed dependent and the links other tickets made to it", async () => {
    const t = setup();
    const keep = new Tickets(components.strictTickets, {
      queues: { jobs: defineQueue({ policy: { reopenWindowMs: 0 } }), open: defineQueue({ policy: { reopenWindowMs: null } }) },
      retentionMs: HOUR,
    });
    const ids = await t.run(async (ctx) => {
      await keep.sync(ctx);
      const blocker = await keep.open(ctx, { queue: "jobs", actor: LEAD, title: "blocker" });
      const dependent = await keep.open(ctx, { queue: "jobs", actor: LEAD, title: "dependent", blockedBy: [blocker] });
      const watcher = await keep.open(ctx, { queue: "open", actor: LEAD, title: "watcher" });
      await keep.link(ctx, { ticketId: watcher, actor: LEAD, relation: "relates", toTicketId: blocker });
      const seq = seqOf(await keep.claim(ctx, { ticketId: blocker, actor: A }));
      await keep.resolve(ctx, { queue: "jobs", ticketId: blocker, actor: A, claimSeq: seq, resolution: "completed" });
      return { blocker, dependent, watcher };
    });
    vi.advanceTimersByTime(MINUTE);
    await t.run(async (ctx) => {
      const seq = seqOf(await keep.claim(ctx, { ticketId: ids.dependent, actor: B }));
      await keep.resolve(ctx, { queue: "jobs", ticketId: ids.dependent, actor: B, claimSeq: seq, resolution: "completed" });
    });
    vi.advanceTimersByTime(HOUR + MINUTE);
    const first = await t.mutation(purgeRef(), {});
    expect(first.more).toBe(true);
    expect(await t.run((ctx) => keep.get(ctx, { ticketId: ids.blocker }))).toBeNull();
    const dependent = await t.run((ctx) => keep.get(ctx, { ticketId: ids.dependent }));
    expect(dependent?.ticket).toMatchObject({ category: "done", openBlockers: 0 });
    expect(dependent?.blockers).toEqual([]);
    const watcher = await t.run((ctx) => keep.get(ctx, { ticketId: ids.watcher }));
    expect(watcher?.links).toEqual([]);
    await purgeAll(t);
    expect(await t.run((ctx) => keep.get(ctx, { ticketId: ids.dependent }))).toBeNull();
    expect(await t.run((ctx) => keep.get(ctx, { ticketId: ids.watcher }))).not.toBeNull();
  });
});
