/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from "vitest";
import { LIMIT_CEILINGS, Tickets, defineQueue } from "../../src/client/index.js";
import type { Limits, Party, QueueMap } from "../../src/client/index.js";
import { components, internal } from "./_generated/api.js";
import { A, B, C, HOUR, LEAD, MINUTE, REQ, drain, events, expectCode, setup } from "./harness.helper.js";
import type { T } from "./harness.helper.js";

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Regression tests for one batch of review findings (A to L). Each describe
 * block names its finding. The lease timer chain tests (C) and the stale
 * lease-mode timer (B) read component tables, so they live in
 * `src/component/timers.test.ts`.
 */
const PAGE = { cursor: null, numItems: 100 };

function mount<Q extends QueueMap>(queues: Q, limits?: Partial<Limits>): Tickets<Q> {
  return new Tickets(components.tickets, { queues, limits, onEvent: internal.hooks.recordOnly });
}

async function ready<Q extends QueueMap>(client: Tickets<Q>): Promise<T> {
  const t = setup();
  await t.run((ctx) => client.sync(ctx));
  return t;
}

async function take<Q extends QueueMap>(t: T, client: Tickets<Q>, ticketId: string, actor: Party): Promise<number> {
  const result = await t.run((ctx) => client.claim(ctx, { ticketId, actor }));
  if (!result.ok) throw new Error(`claim of ${ticketId} refused: ${result.reason}`);
  return result.claimSeq;
}

async function ticketOf<Q extends QueueMap>(t: T, client: Tickets<Q>, ticketId: string) {
  const detail = await t.run((ctx) => client.get(ctx, { ticketId }));
  if (!detail) throw new Error(`ticket ${ticketId} is missing`);
  return detail;
}

async function history<Q extends QueueMap>(t: T, client: Tickets<Q>, ticketId: string) {
  const page = await t.run((ctx) => client.listTransitions(ctx, { ticketId, paginationOpts: PAGE }));
  return page.page;
}

async function typesOf<Q extends QueueMap>(t: T, client: Tickets<Q>, ticketId: string): Promise<string[]> {
  return (await history(t, client, ticketId)).map((row) => row.type);
}

async function hookTypes(t: T, ticketId: string): Promise<string[]> {
  await drain(t);
  return (await events(t))
    .filter((row) => row.ticketId === ticketId)
    .sort((x, y) => x.seq - y.seq)
    .map((row) => row.type);
}

describe("A: graph limits have ceilings, and lowering one never hides existing links", () => {
  const blocking = defineQueue({ policy: { leaseMs: null } });
  const wide = mount({ q: blocking });

  test("LIMIT_CEILINGS names the three graph limits at their defaults", () => {
    expect(LIMIT_CEILINGS).toEqual({ maxBlockers: 20, maxBlocked: 100, maxGraphWalk: 200 });
  });

  test.each([
    ["maxBlockers", { maxBlockers: 21 }],
    ["maxBlocked", { maxBlocked: 101 }],
    ["maxGraphWalk", { maxGraphWalk: 201 }],
  ] as const)("sync refuses %s above its ceiling with INVALID_ARGUMENT", async (_key, limits) => {
    const t = setup();
    const client = mount({ q: blocking }, limits);
    await expectCode(
      t.run((ctx) => client.sync(ctx)),
      "INVALID_ARGUMENT",
    );
  });

  test("sync accepts every graph limit at its ceiling", async () => {
    const t = setup();
    const client = mount({ q: blocking }, { maxBlockers: 20, maxBlocked: 100, maxGraphWalk: 200 });
    expect(await t.run((ctx) => client.sync(ctx))).toEqual({ created: ["q"], updated: [], unchanged: [] });
  });

  test("lowering maxBlocked after links exist still releases every dependent when the blocker completes", async () => {
    const t = await ready(wide);
    const narrow = mount({ q: blocking }, { maxBlocked: 2 });
    const blocker = await t.run((ctx) => wide.open(ctx, { queue: "q", actor: LEAD, title: "blocker" }));
    const dependents: string[] = [];
    for (const title of ["one", "two", "three"]) {
      dependents.push(await t.run((ctx) => wide.open(ctx, { queue: "q", actor: LEAD, title, blockedBy: [blocker] })));
    }
    await t.run((ctx) => narrow.sync(ctx));

    const extra = await t.run((ctx) => narrow.open(ctx, { queue: "q", actor: LEAD, title: "extra" }));
    await expectCode(
      t.run((ctx) => narrow.link(ctx, { ticketId: blocker, actor: LEAD, relation: "blocks", toTicketId: extra })),
      "TOO_MANY_BLOCKED",
    );

    const claimSeq = await take(t, narrow, blocker, A);
    await t.run((ctx) => narrow.resolve(ctx, { ticketId: blocker, actor: A, claimSeq, resolution: "completed" }));
    for (const id of dependents) {
      expect((await ticketOf(t, narrow, id)).ticket.openBlockers, `dependent ${id}`).toBe(0);
    }
  });

  test("lowering maxBlockers after links exist does not let a cycle through, and new caps use the lower limit", async () => {
    const t = await ready(wide);
    const narrow = mount({ q: blocking }, { maxBlockers: 1 });
    const first = await t.run((ctx) => wide.open(ctx, { queue: "q", actor: LEAD, title: "first" }));
    const second = await t.run((ctx) => wide.open(ctx, { queue: "q", actor: LEAD, title: "second" }));
    const top = await t.run((ctx) => wide.open(ctx, { queue: "q", actor: LEAD, title: "top", blockedBy: [first, second] }));
    await t.run((ctx) => narrow.sync(ctx));

    await expectCode(
      t.run((ctx) => narrow.link(ctx, { ticketId: top, actor: LEAD, relation: "blocks", toTicketId: second })),
      "CYCLE",
    );
    const third = await t.run((ctx) => narrow.open(ctx, { queue: "q", actor: LEAD, title: "third" }));
    await expectCode(
      t.run((ctx) => narrow.link(ctx, { ticketId: third, actor: LEAD, relation: "blocks", toTicketId: top })),
      "TOO_MANY_BLOCKERS",
    );
  });
});

describe("B: a queue's lease mode cannot flip while a ticket is started", () => {
  const leased = (leaseMs: number | null) => mount({ q: defineQueue({ policy: { leaseMs } }) });

  test.each([
    ["a number to null", 300_000, null],
    ["null to a number", null, 300_000],
  ] as const)("sync refuses to change leaseMs from %s while a ticket is started", async (_name, from, to) => {
    const before = leased(from);
    const t = await ready(before);
    const ticketId = await t.run((ctx) => before.open(ctx, { queue: "q", actor: LEAD, title: "in work" }));
    await take(t, before, ticketId, A);
    const after = leased(to);

    await expectCode(
      t.run((ctx) => after.sync(ctx)),
      "INVALID_QUEUE",
    );
    expect((await t.run((ctx) => before.getQueue(ctx, { name: "q" })))?.policy.leaseMs).toBe(from);
  });

  test.each([
    ["a number to null", 300_000, null],
    ["null to a number", null, 300_000],
  ] as const)("sync may change leaseMs from %s while no ticket is started", async (_name, from, to) => {
    const before = leased(from);
    const t = await ready(before);
    const ticketId = await t.run((ctx) => before.open(ctx, { queue: "q", actor: LEAD, title: "was in work" }));
    const claimSeq = await take(t, before, ticketId, A);
    await t.run((ctx) => before.release(ctx, { ticketId, actor: A, claimSeq }));
    const after = leased(to);

    expect(await t.run((ctx) => after.sync(ctx))).toEqual({ created: [], updated: ["q"], unchanged: [] });
    expect((await t.run((ctx) => after.getQueue(ctx, { name: "q" })))?.policy.leaseMs).toBe(to);
    const claim = await t.run((ctx) => after.claim(ctx, { ticketId, actor: B }));
    expect(claim.ok && claim.leaseExpiresAt !== undefined).toBe(to !== null);
  });

  test("a different lease length is not a flip and is allowed while a ticket is started", async () => {
    const before = leased(300_000);
    const t = await ready(before);
    const ticketId = await t.run((ctx) => before.open(ctx, { queue: "q", actor: LEAD, title: "in work" }));
    await take(t, before, ticketId, A);
    const after = leased(60_000);

    expect(await t.run((ctx) => after.sync(ctx))).toEqual({ created: [], updated: ["q"], unchanged: [] });
  });
});

describe("D: field and result keys must be storable as record keys", () => {
  test.each(["prix€", "$total", "_x", "a\u007Fb"])("sync refuses the field key %j with INVALID_QUEUE", async (key) => {
    const t = setup();
    const client = mount({ q: defineQueue({ fields: { [key]: { type: "string" } } }) });
    await expectCode(
      t.run((ctx) => client.sync(ctx)),
      "INVALID_QUEUE",
    );
  });

  test.each(["prix€", "$total", "_x", "a\u007Fb"])("sync refuses the result key %j with INVALID_QUEUE", async (key) => {
    const t = setup();
    const client = mount({ q: defineQueue({ result: { [key]: { type: "string" } } }) });
    await expectCode(
      t.run((ctx) => client.sync(ctx)),
      "INVALID_QUEUE",
    );
  });

  test("keys such as order-id, with a space, or with a $ or _ after the first character are accepted and stored", async () => {
    const keyed = mount({
      q: defineQueue({
        fields: { "order-id": { type: "string" }, "a b": { type: "number" }, "x$y_z": { type: "boolean" } },
        result: { "ref-id": { type: "string" } },
      }),
    });
    const t = await ready(keyed);
    const ticketId = await t.run((ctx) =>
      keyed.open(ctx, { queue: "q", actor: LEAD, title: "keys", fields: { "order-id": "A-1", "a b": 2, "x$y_z": true } }),
    );
    const claimSeq = await take(t, keyed, ticketId, A);
    await t.run((ctx) =>
      keyed.resolve(ctx, { ticketId, actor: A, claimSeq, resolution: "completed", result: { "ref-id": "R-1" } }),
    );

    const { ticket } = await ticketOf(t, keyed, ticketId);
    expect(ticket.fields).toEqual({ "order-id": "A-1", "a b": 2, "x$y_z": true });
    expect(ticket.result).toEqual({ "ref-id": "R-1" });
  });
});

describe("E: a guardrail trip that does not escalate is recorded", () => {
  const rails = mount({
    bare: defineQueue({ policy: { leaseMs: null } }),
    tight: defineQueue({ policy: { leaseMs: null, maxHops: 1 } }),
    small: defineQueue({ policy: { leaseMs: null, maxMessages: 2 } }),
    guarded: defineQueue({ policy: { leaseMs: null, maxHops: 1, maxMessages: 2, escalateTo: "desk" } }),
    desk: defineQueue({ policy: { leaseMs: null, maxHops: 1, maxMessages: 2 } }),
  });

  async function trips(t: T, ticketId: string): Promise<number> {
    return (await hookTypes(t, ticketId)).filter((type) => type === "guardrail_tripped").length;
  }

  test("HOP_LIMIT without an escalation target writes one guardrail_tripped transition and changes nothing else", async () => {
    const t = await ready(rails);
    const ticketId = await t.run((ctx) => rails.open(ctx, { queue: "tight", actor: REQ, title: "hops" }));
    const first = await take(t, rails, ticketId, A);
    await t.run((ctx) => rails.handoff(ctx, { ticketId, actor: A, claimSeq: first, toParty: B }));
    const before = (await ticketOf(t, rails, ticketId)).ticket;

    const refused = await t.run((ctx) => rails.handoff(ctx, { ticketId, actor: B, claimSeq: before.claimSeq, toParty: C }));

    expect(refused).toEqual({ ok: false, reason: "HOP_LIMIT", escalated: false });
    const after = (await ticketOf(t, rails, ticketId)).ticket;
    expect(after).toMatchObject({ queue: "tight", category: "started", assigneeRef: B.ref, claimSeq: before.claimSeq, hopCount: 1 });
    const rows = await history(t, rails, ticketId);
    expect(rows.map((row) => row.type)).toEqual(["opened", "claimed", "handed_off", "guardrail_tripped"]);
    expect(rows.at(-1)).toMatchObject({ actorRef: B.ref, fromState: "working", toState: "working" });
    expect(rows.at(-1)?.reason).toMatch(/^HOP_LIMIT: /);
    expect(await trips(t, ticketId)).toBe(1);
  });

  test("PING_PONG without an escalation target writes one guardrail_tripped transition and changes nothing else", async () => {
    const t = await ready(rails);
    const ticketId = await t.run((ctx) => rails.open(ctx, { queue: "bare", actor: REQ, title: "ping" }));
    let claimSeq = await take(t, rails, ticketId, A);
    const route: [Party, Party][] = [
      [A, B],
      [B, A],
      [A, B],
    ];
    for (const [from, to] of route) {
      const result = await t.run((ctx) => rails.handoff(ctx, { ticketId, actor: from, claimSeq, toParty: to }));
      if (!result.ok) throw new Error(`handoff refused: ${result.reason}`);
      claimSeq = result.claimSeq;
    }

    const refused = await t.run((ctx) => rails.handoff(ctx, { ticketId, actor: B, claimSeq, toParty: A }));

    expect(refused).toEqual({ ok: false, reason: "PING_PONG", escalated: false });
    expect((await ticketOf(t, rails, ticketId)).ticket).toMatchObject({ category: "started", assigneeRef: B.ref, claimSeq, hopCount: 3 });
    const rows = await history(t, rails, ticketId);
    expect(rows.map((row) => row.type)).toEqual(["opened", "claimed", "handed_off", "handed_off", "handed_off", "guardrail_tripped"]);
    expect(rows.at(-1)?.reason).toMatch(/^PING_PONG: /);
    expect(await trips(t, ticketId)).toBe(1);
  });

  test("MESSAGE_LIMIT in reply without an escalation target writes one guardrail_tripped transition", async () => {
    const t = await ready(rails);
    const ticketId = await t.run((ctx) => rails.open(ctx, { queue: "small", actor: REQ, title: "chatter" }));
    for (const body of ["one", "two"]) {
      await t.run((ctx) => rails.reply(ctx, { ticketId, actor: REQ, body }));
    }

    const refused = await t.run((ctx) => rails.reply(ctx, { ticketId, actor: REQ, body: "three" }));

    expect(refused).toEqual({ ok: false, reason: "MESSAGE_LIMIT", escalated: false });
    expect((await ticketOf(t, rails, ticketId)).ticket).toMatchObject({ queue: "small", category: "unstarted", claimSeq: 0, messageCount: 2 });
    const rows = await history(t, rails, ticketId);
    expect(rows.map((row) => row.type)).toEqual(["opened", "guardrail_tripped"]);
    expect(rows.at(-1)).toMatchObject({ actorRef: REQ.ref });
    expect(rows.at(-1)?.reason).toMatch(/^MESSAGE_LIMIT: /);
    expect(await trips(t, ticketId)).toBe(1);
  });

  test("a trip that escalates keeps the single escalated transition, and a second trip on the escalated ticket is recorded", async () => {
    const t = await ready(rails);
    const ticketId = await t.run((ctx) => rails.open(ctx, { queue: "guarded", actor: REQ, title: "hops twice" }));
    const first = await take(t, rails, ticketId, A);
    const moved = await t.run((ctx) => rails.handoff(ctx, { ticketId, actor: A, claimSeq: first, toParty: B }));
    if (!moved.ok) throw new Error(`handoff refused: ${moved.reason}`);

    const escalating = await t.run((ctx) => rails.handoff(ctx, { ticketId, actor: B, claimSeq: moved.claimSeq, toParty: C }));
    expect(escalating).toEqual({ ok: false, reason: "HOP_LIMIT", escalated: true });
    expect(await typesOf(t, rails, ticketId)).toEqual(["opened", "claimed", "handed_off", "escalated"]);

    const second = await take(t, rails, ticketId, C);
    const again = await t.run((ctx) => rails.handoff(ctx, { ticketId, actor: C, claimSeq: second, toParty: A }));
    expect(again).toEqual({ ok: false, reason: "HOP_LIMIT", escalated: false });
    expect(await typesOf(t, rails, ticketId)).toEqual(["opened", "claimed", "handed_off", "escalated", "claimed", "guardrail_tripped"]);
    expect((await ticketOf(t, rails, ticketId)).ticket).toMatchObject({ queue: "desk", category: "started", assigneeRef: C.ref, claimSeq: second });
    expect(await trips(t, ticketId)).toBe(1);
  });

  test("a message cap that escalates keeps the single escalated transition, and the next trip on the escalated ticket is recorded", async () => {
    const t = await ready(rails);
    const ticketId = await t.run((ctx) => rails.open(ctx, { queue: "guarded", actor: REQ, title: "chatter" }));
    for (const body of ["one", "two"]) {
      await t.run((ctx) => rails.reply(ctx, { ticketId, actor: REQ, body }));
    }

    const escalating = await t.run((ctx) => rails.reply(ctx, { ticketId, actor: REQ, body: "three" }));
    expect(escalating).toEqual({ ok: false, reason: "MESSAGE_LIMIT", escalated: true });
    expect(await typesOf(t, rails, ticketId)).toEqual(["opened", "escalated"]);

    const again = await t.run((ctx) => rails.reply(ctx, { ticketId, actor: REQ, body: "four" }));
    expect(again).toEqual({ ok: false, reason: "MESSAGE_LIMIT", escalated: false });
    expect(await typesOf(t, rails, ticketId)).toEqual(["opened", "escalated", "guardrail_tripped"]);
    expect(await trips(t, ticketId)).toBe(1);
  });

  test("a message cap reached on an ended ticket cannot escalate it and is recorded", async () => {
    const t = await ready(rails);
    const ticketId = await t.run((ctx) => rails.open(ctx, { queue: "guarded", actor: REQ, title: "finished chatter" }));
    for (const body of ["one", "two"]) {
      await t.run((ctx) => rails.reply(ctx, { ticketId, actor: REQ, body }));
    }
    const claimSeq = await take(t, rails, ticketId, A);
    await t.run((ctx) => rails.resolve(ctx, { ticketId, actor: A, claimSeq, resolution: "completed" }));

    const refused = await t.run((ctx) => rails.reply(ctx, { ticketId, actor: REQ, body: "after the end" }));

    expect(refused).toEqual({ ok: false, reason: "MESSAGE_LIMIT", escalated: false });
    expect(await typesOf(t, rails, ticketId)).toEqual(["opened", "claimed", "resolved", "guardrail_tripped"]);
    expect((await ticketOf(t, rails, ticketId)).ticket).toMatchObject({ queue: "guarded", category: "done", claimSeq });
  });
});

describe("F: a blocker that already ended without completing is refused", () => {
  const flow = mount({ q: defineQueue({ policy: { leaseMs: null, reopenWindowMs: null } }) });
  const ENDINGS = ["failed", "rejected", "canceled"] as const;

  async function openOne(t: T, title: string): Promise<string> {
    return await t.run((ctx) => flow.open(ctx, { queue: "q", actor: LEAD, title }));
  }

  async function end(t: T, ticketId: string, how: "completed" | (typeof ENDINGS)[number]): Promise<void> {
    if (how === "canceled") {
      await t.run((ctx) => flow.cancel(ctx, { ticketId, actor: LEAD }));
      return;
    }
    const claimSeq = await take(t, flow, ticketId, B);
    await t.run((ctx) => flow.resolve(ctx, { ticketId, actor: B, claimSeq, resolution: how }));
  }

  test.each(ENDINGS)("hold refuses a blocker that ended as %s with INVALID_ARGUMENT and changes nothing", async (how) => {
    const t = await ready(flow);
    const holder = await openOne(t, "holder");
    const claimSeq = await take(t, flow, holder, A);
    const dead = await openOne(t, "dead");
    await end(t, dead, how);

    await expectCode(
      t.run((ctx) => flow.hold(ctx, { ticketId: holder, actor: A, claimSeq, blockers: [dead] })),
      "INVALID_ARGUMENT",
    );

    const view = await ticketOf(t, flow, holder);
    expect(view.ticket).toMatchObject({ category: "started", openBlockers: 0 });
    expect(view.blockers).toEqual([]);
  });

  test.each(ENDINGS)("link blocks refuses a blocker that ended as %s with INVALID_ARGUMENT and changes nothing", async (how) => {
    const t = await ready(flow);
    const dependent = await openOne(t, "dependent");
    const dead = await openOne(t, "dead");
    await end(t, dead, how);

    await expectCode(
      t.run((ctx) => flow.link(ctx, { ticketId: dead, actor: LEAD, relation: "blocks", toTicketId: dependent })),
      "INVALID_ARGUMENT",
    );

    const view = await ticketOf(t, flow, dependent);
    expect(view.ticket.openBlockers).toBe(0);
    expect(view.blockers).toEqual([]);
  });

  test("open with blockedBy refuses a blocker that already failed, since all three paths share one check", async () => {
    const t = await ready(flow);
    const dead = await openOne(t, "dead");
    await end(t, dead, "failed");

    await expectCode(
      t.run((ctx) => flow.open(ctx, { queue: "q", actor: LEAD, title: "late", blockedBy: [dead] })),
      "INVALID_ARGUMENT",
    );
  });

  test("a completed blocker is still accepted by hold and by link, and counts as not open", async () => {
    const t = await ready(flow);
    const holder = await openOne(t, "holder");
    const claimSeq = await take(t, flow, holder, A);
    const finished = await openOne(t, "finished");
    await end(t, finished, "completed");
    const pending = await openOne(t, "pending");

    await t.run((ctx) => flow.hold(ctx, { ticketId: holder, actor: A, claimSeq, blockers: [finished, pending] }));
    expect((await ticketOf(t, flow, holder)).ticket).toMatchObject({ category: "waiting", waitingOn: "blockers", openBlockers: 1 });

    const dependent = await openOne(t, "dependent");
    await t.run((ctx) => flow.link(ctx, { ticketId: finished, actor: LEAD, relation: "blocks", toTicketId: dependent }));
    const view = await ticketOf(t, flow, dependent);
    expect(view.ticket.openBlockers).toBe(0);
    expect(view.blockers).toMatchObject([{ ticketId: finished, completed: true }]);
  });
});

describe("G: reopen respects the open cap", () => {
  const capped = mount({ q: defineQueue({ policy: { leaseMs: null, reopenWindowMs: null, maxOpenPerRequester: 2 } }) });

  test("reopen is allowed up to maxOpenPerRequester active tickets and refused past it, for the ticket's requester", async () => {
    const t = await ready(capped);
    const openOne = (title: string) => t.run((ctx) => capped.open(ctx, { queue: "q", actor: REQ, title }));
    const cancel = (ticketId: string) => t.run((ctx) => capped.cancel(ctx, { ticketId, actor: REQ }));
    const first = await openOne("first");
    const second = await openOne("second");
    await cancel(first);
    await cancel(second);
    const third = await openOne("third");

    await t.run((ctx) => capped.reopen(ctx, { ticketId: first, actor: REQ }));
    expect((await ticketOf(t, capped, first)).ticket.category).toBe("unstarted");

    await expectCode(
      t.run((ctx) => capped.reopen(ctx, { ticketId: second, actor: LEAD, trusted: true })),
      "TOO_MANY_OPEN",
    );
    expect((await ticketOf(t, capped, second)).ticket).toMatchObject({ category: "canceled", claimSeq: 0 });
    expect(await typesOf(t, capped, second)).toEqual(["opened", "canceled"]);

    await cancel(third);
    await t.run((ctx) => capped.reopen(ctx, { ticketId: second, actor: REQ }));
    expect((await ticketOf(t, capped, second)).ticket.category).toBe("unstarted");
  });
});

describe("H: reopen sets the due timer again", () => {
  const timed = mount({ q: defineQueue({ policy: { leaseMs: null, dueInMs: HOUR } }) });

  async function resolved(t: T): Promise<string> {
    const ticketId = await t.run((ctx) => timed.open(ctx, { queue: "q", actor: REQ, title: "due soon" }));
    const claimSeq = await take(t, timed, ticketId, A);
    await t.run((ctx) => timed.resolve(ctx, { ticketId, actor: A, claimSeq, resolution: "completed" }));
    return ticketId;
  }

  test("a ticket resolved before its due time and reopened after it breaches once", async () => {
    const t = await ready(timed);
    const ticketId = await resolved(t);
    await drain(t, HOUR + MINUTE);
    expect((await ticketOf(t, timed, ticketId)).ticket.dueBreachedAt).toBeUndefined();

    await t.run((ctx) => timed.reopen(ctx, { ticketId, actor: REQ }));
    await drain(t);

    expect((await ticketOf(t, timed, ticketId)).ticket.dueBreachedAt).toBeDefined();
    expect((await typesOf(t, timed, ticketId)).filter((type) => type === "due_breached")).toHaveLength(1);
    expect((await hookTypes(t, ticketId)).filter((type) => type === "due_breached")).toHaveLength(1);
  });

  test("a ticket reopened before its due time breaches once, when the time comes", async () => {
    const t = await ready(timed);
    const ticketId = await resolved(t);
    await t.run((ctx) => timed.reopen(ctx, { ticketId, actor: REQ }));
    await drain(t, 30 * MINUTE);
    expect(await typesOf(t, timed, ticketId)).not.toContain("due_breached");

    await drain(t, 31 * MINUTE);

    expect((await typesOf(t, timed, ticketId)).filter((type) => type === "due_breached")).toHaveLength(1);
    expect((await hookTypes(t, ticketId)).filter((type) => type === "due_breached")).toHaveLength(1);
  });

  test("a ticket that already breached does not breach again when it is canceled and reopened", async () => {
    const t = await ready(timed);
    const ticketId = await t.run((ctx) => timed.open(ctx, { queue: "q", actor: REQ, title: "late" }));
    await drain(t, HOUR + MINUTE);
    await t.run((ctx) => timed.cancel(ctx, { ticketId, actor: REQ }));
    await t.run((ctx) => timed.reopen(ctx, { ticketId, actor: REQ }));
    await drain(t, HOUR);

    expect((await typesOf(t, timed, ticketId)).filter((type) => type === "due_breached")).toHaveLength(1);
  });
});

describe("I: resolve with a body and requestInput count as messages", () => {
  const capped = mount({ q: defineQueue({ policy: { leaseMs: null, maxMessages: 1 } }) });
  const metered = mount({ q: defineQueue({ policy: { leaseMs: null } }) }, { messagesPerMinute: 2 });

  test("resolve with a body below maxMessages adds the message", async () => {
    const t = await ready(capped);
    const ticketId = await t.run((ctx) => capped.open(ctx, { queue: "q", actor: REQ, title: "room" }));
    const claimSeq = await take(t, capped, ticketId, A);

    await t.run((ctx) => capped.resolve(ctx, { ticketId, actor: A, claimSeq, resolution: "completed", body: "all done" }));

    const view = await ticketOf(t, capped, ticketId);
    expect(view.ticket).toMatchObject({ category: "done", messageCount: 1 });
    expect(view.messages.map((m) => m.body)).toEqual(["all done"]);
  });

  test("resolve with a body at maxMessages throws MESSAGE_LIMIT and changes nothing; without a body it resolves", async () => {
    const t = await ready(capped);
    const ticketId = await t.run((ctx) => capped.open(ctx, { queue: "q", actor: REQ, title: "full" }));
    const claimSeq = await take(t, capped, ticketId, A);
    await t.run((ctx) => capped.reply(ctx, { ticketId, actor: REQ, body: "fills the thread" }));

    await expectCode(
      t.run((ctx) => capped.resolve(ctx, { ticketId, actor: A, claimSeq, resolution: "completed", body: "one too many" })),
      "MESSAGE_LIMIT",
    );

    const view = await ticketOf(t, capped, ticketId);
    expect(view.ticket).toMatchObject({ category: "started", messageCount: 1 });
    expect(view.messages.map((m) => m.body)).toEqual(["fills the thread"]);
    expect(await typesOf(t, capped, ticketId)).toEqual(["opened", "claimed"]);

    await t.run((ctx) => capped.resolve(ctx, { ticketId, actor: A, claimSeq, resolution: "completed" }));
    expect((await ticketOf(t, capped, ticketId)).ticket.category).toBe("done");
  });

  test("resolve with a body takes a token of the party's message rate limit, and RATE_LIMITED changes nothing", async () => {
    const t = await ready(metered);
    const ids: string[] = [];
    for (const title of ["one", "two", "three"]) {
      ids.push(await t.run((ctx) => metered.open(ctx, { queue: "q", actor: REQ, title })));
    }
    const seqs: number[] = [];
    for (const id of ids) seqs.push(await take(t, metered, id, A));
    const [one, two, three] = ids;
    const [seqOne, seqTwo, seqThree] = seqs;
    if (one === undefined || two === undefined || three === undefined) throw new Error("missing tickets");
    if (seqOne === undefined || seqTwo === undefined || seqThree === undefined) throw new Error("missing claims");
    await t.run((ctx) => metered.resolve(ctx, { ticketId: one, actor: A, claimSeq: seqOne, resolution: "completed", body: "first" }));
    await t.run((ctx) => metered.resolve(ctx, { ticketId: two, actor: A, claimSeq: seqTwo, resolution: "completed", body: "second" }));

    await expectCode(
      t.run((ctx) => metered.resolve(ctx, { ticketId: three, actor: A, claimSeq: seqThree, resolution: "completed", body: "third" })),
      "RATE_LIMITED",
    );

    expect((await ticketOf(t, metered, three)).ticket).toMatchObject({ category: "started", messageCount: 0 });
    await t.run((ctx) => metered.resolve(ctx, { ticketId: three, actor: A, claimSeq: seqThree, resolution: "completed" }));
    expect((await ticketOf(t, metered, three)).ticket.category).toBe("done");
  });

  test("requestInput takes a token of the party's message rate limit, and RATE_LIMITED changes nothing", async () => {
    const t = await ready(metered);
    const ids: string[] = [];
    for (const title of ["one", "two", "three"]) {
      ids.push(await t.run((ctx) => metered.open(ctx, { queue: "q", actor: REQ, title })));
    }
    const seqs: number[] = [];
    for (const id of ids) seqs.push(await take(t, metered, id, A));
    const [one, two, three] = ids;
    const [seqOne, seqTwo, seqThree] = seqs;
    if (one === undefined || two === undefined || three === undefined) throw new Error("missing tickets");
    if (seqOne === undefined || seqTwo === undefined || seqThree === undefined) throw new Error("missing claims");
    await t.run((ctx) => metered.requestInput(ctx, { ticketId: one, actor: A, claimSeq: seqOne, body: "which one?" }));
    await t.run((ctx) => metered.requestInput(ctx, { ticketId: two, actor: A, claimSeq: seqTwo, body: "which two?" }));

    await expectCode(
      t.run((ctx) => metered.requestInput(ctx, { ticketId: three, actor: A, claimSeq: seqThree, body: "which three?" })),
      "RATE_LIMITED",
    );

    expect((await ticketOf(t, metered, three)).ticket).toMatchObject({ category: "started", messageCount: 0 });
  });
});

describe("J: links on sealed tickets", () => {
  const sealing = mount({
    live: defineQueue({ policy: { leaseMs: null, reopenWindowMs: null } }),
    gone: defineQueue({ policy: { leaseMs: null, reopenWindowMs: 0 } }),
  });

  const openLive = (t: T, title: string): Promise<string> =>
    t.run((ctx) => sealing.open(ctx, { queue: "live", actor: LEAD, title }));
  const openGone = (t: T, title: string): Promise<string> =>
    t.run((ctx) => sealing.open(ctx, { queue: "gone", actor: LEAD, title }));
  const sealByCancel = async (t: T, ticketId: string): Promise<void> => {
    await t.run((ctx) => sealing.cancel(ctx, { ticketId, actor: LEAD }));
    expect((await ticketOf(t, sealing, ticketId)).ticket.closedAt).toBeDefined();
  };
  const sealByCompleting = async (t: T, ticketId: string): Promise<void> => {
    const claimSeq = await take(t, sealing, ticketId, A);
    await t.run((ctx) => sealing.resolve(ctx, { ticketId, actor: A, claimSeq, resolution: "completed" }));
    expect((await ticketOf(t, sealing, ticketId)).ticket.closedAt).toBeDefined();
  };

  test.each(["relates", "duplicates"] as const)("link %s from a sealed ticket is SEALED, and to a sealed target stays allowed", async (relation) => {
    const t = await ready(sealing);
    const sealed = await openGone(t, "sealed");
    await sealByCancel(t, sealed);
    const active = await openLive(t, "active");

    await expectCode(
      t.run((ctx) => sealing.link(ctx, { ticketId: sealed, actor: LEAD, relation, toTicketId: active })),
      "SEALED",
    );
    await t.run((ctx) => sealing.link(ctx, { ticketId: active, actor: LEAD, relation, toTicketId: sealed }));
    expect((await ticketOf(t, sealing, active)).links).toMatchObject([{ relation, toTicketId: sealed }]);
  });

  test("link blocks from a sealed blocker is SEALED, and nothing is linked", async () => {
    const t = await ready(sealing);
    const blocker = await openGone(t, "blocker");
    await sealByCompleting(t, blocker);
    const dependent = await openLive(t, "dependent");

    await expectCode(
      t.run((ctx) => sealing.link(ctx, { ticketId: blocker, actor: LEAD, relation: "blocks", toTicketId: dependent })),
      "SEALED",
    );

    const view = await ticketOf(t, sealing, dependent);
    expect(view.blockers).toEqual([]);
    expect(view.ticket.openBlockers).toBe(0);
  });

  test("link blocks to a sealed dependent is SEALED", async () => {
    const t = await ready(sealing);
    const blocker = await openLive(t, "blocker");
    const dependent = await openGone(t, "dependent");
    await sealByCancel(t, dependent);

    await expectCode(
      t.run((ctx) => sealing.link(ctx, { ticketId: blocker, actor: LEAD, relation: "blocks", toTicketId: dependent })),
      "SEALED",
    );
  });

  test("unlink of a plain link is SEALED once its owner ticket is sealed, and the link stays", async () => {
    const t = await ready(sealing);
    const owner = await openGone(t, "owner");
    const other = await openLive(t, "other");
    const linkId = await t.run((ctx) => sealing.link(ctx, { ticketId: owner, actor: LEAD, relation: "relates", toTicketId: other }));
    await sealByCancel(t, owner);

    await expectCode(
      t.run((ctx) => sealing.unlink(ctx, { linkId })),
      "SEALED",
    );
    expect((await ticketOf(t, sealing, owner)).links).toMatchObject([{ linkId }]);
  });

  test("unlink of a blocks link is SEALED once the blocker is sealed", async () => {
    const t = await ready(sealing);
    const blocker = await openGone(t, "blocker");
    const dependent = await openLive(t, "dependent");
    const linkId = await t.run((ctx) => sealing.link(ctx, { ticketId: blocker, actor: LEAD, relation: "blocks", toTicketId: dependent }));
    await sealByCompleting(t, blocker);

    await expectCode(
      t.run((ctx) => sealing.unlink(ctx, { linkId })),
      "SEALED",
    );
    expect((await ticketOf(t, sealing, dependent)).blockers).toMatchObject([{ linkId }]);
  });

  test("unlink of a blocks link is SEALED once the dependent is sealed", async () => {
    const t = await ready(sealing);
    const blocker = await openLive(t, "blocker");
    const dependent = await openGone(t, "dependent");
    const linkId = await t.run((ctx) => sealing.link(ctx, { ticketId: blocker, actor: LEAD, relation: "blocks", toTicketId: dependent }));
    await sealByCancel(t, dependent);

    await expectCode(
      t.run((ctx) => sealing.unlink(ctx, { linkId })),
      "SEALED",
    );
    expect((await ticketOf(t, sealing, blocker)).links).toMatchObject([{ linkId }]);
  });

  test("unlink still removes links between active tickets", async () => {
    const t = await ready(sealing);
    const blocker = await openLive(t, "blocker");
    const dependent = await openLive(t, "dependent");
    const linkId = await t.run((ctx) => sealing.link(ctx, { ticketId: blocker, actor: LEAD, relation: "blocks", toTicketId: dependent }));

    await t.run((ctx) => sealing.unlink(ctx, { linkId }));

    expect((await ticketOf(t, sealing, dependent)).blockers).toEqual([]);
  });
});

describe("K: the client refuses a value it cannot store", () => {
  const typed = mount({ q: defineQueue({ fields: { amount: { type: "number" }, note: { type: "string" } } }) });

  test.each<[string, unknown]>([
    ["an array", ["a"]],
    ["a nested object", { nested: 1 }],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
  ])("open refuses %s with INVALID_FIELD and writes no ticket", async (_what, value) => {
    const t = await ready(typed);
    const fields = { amount: 1 };
    Object.assign(fields, { note: value });

    await expectCode(
      t.run((ctx) => typed.open(ctx, { queue: "q", actor: LEAD, title: "smuggled", fields })),
      "INVALID_FIELD",
    );

    const listed = await t.run((ctx) => typed.list(ctx, { filter: { by: "queue", queue: "q" }, paginationOpts: PAGE }));
    expect(listed.page).toEqual([]);
  });

  test("a key left undefined is still dropped, as an unset optional field", async () => {
    const t = await ready(typed);
    const ticketId = await t.run((ctx) =>
      typed.open(ctx, { queue: "q", actor: LEAD, title: "partial", fields: { amount: 1, note: undefined } }),
    );

    expect((await ticketOf(t, typed, ticketId)).ticket.fields).toEqual({ amount: 1 });
  });
});

describe("L: automatic escalation happens once", () => {
  test("lease expiry escalates a ticket once, then returns it to the queue it is in", async () => {
    const loop = mount({
      ping: defineQueue({ policy: { maxReturns: 1, escalateTo: "pong" } }),
      pong: defineQueue({ policy: { maxReturns: 1, escalateTo: "ping" } }),
    });
    const t = await ready(loop);
    const ticketId = await t.run((ctx) => loop.open(ctx, { queue: "ping", actor: REQ, title: "crash loop" }));

    for (let round = 0; round < 3; round += 1) {
      await take(t, loop, ticketId, A);
      await drain(t, 5 * MINUTE);
    }

    expect(await typesOf(t, loop, ticketId)).toEqual([
      "opened",
      "claimed",
      "escalated",
      "claimed",
      "lease_expired",
      "claimed",
      "lease_expired",
    ]);
    expect((await ticketOf(t, loop, ticketId)).ticket).toMatchObject({ queue: "pong", category: "unstarted", leaseExpiryCount: 3 });
  });

  test("a due time on an already escalated ticket emits due_breached and does not escalate again", async () => {
    const dueLoop = mount({
      front: defineQueue({ policy: { leaseMs: null, dueInMs: HOUR, escalateTo: "back" } }),
      back: defineQueue({ policy: { leaseMs: null, escalateTo: "front", escalateOnDue: true } }),
    });
    const t = await ready(dueLoop);
    const ticketId = await t.run((ctx) => dueLoop.open(ctx, { queue: "front", actor: REQ, title: "slow" }));
    await t.run((ctx) => dueLoop.escalate(ctx, { ticketId, actor: LEAD, trusted: true, reason: "by hand" }));

    await drain(t, HOUR + MINUTE);

    expect(await typesOf(t, dueLoop, ticketId)).toEqual(["opened", "escalated", "due_breached"]);
    expect((await ticketOf(t, dueLoop, ticketId)).ticket).toMatchObject({ queue: "back", category: "unstarted" });
  });

  test("the explicit escalate mutation still works on an already escalated ticket", async () => {
    const dueLoop = mount({
      front: defineQueue({ policy: { leaseMs: null, escalateTo: "back" } }),
      back: defineQueue({ policy: { leaseMs: null, escalateTo: "front" } }),
    });
    const t = await ready(dueLoop);
    const ticketId = await t.run((ctx) => dueLoop.open(ctx, { queue: "front", actor: REQ, title: "bounced" }));

    await t.run((ctx) => dueLoop.escalate(ctx, { ticketId, actor: LEAD, trusted: true, reason: "first" }));
    await t.run((ctx) => dueLoop.escalate(ctx, { ticketId, actor: LEAD, trusted: true, reason: "second" }));

    expect(await typesOf(t, dueLoop, ticketId)).toEqual(["opened", "escalated", "escalated"]);
    expect((await ticketOf(t, dueLoop, ticketId)).ticket.queue).toBe("front");
  });
});
