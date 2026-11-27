/// <reference types="vite/client" />
import { componentsGeneric } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SYSTEM_PARTY, Tickets, defineQueue, isTicketsError } from "../../src/client/index.js";
import type {
  Category,
  ClaimResult,
  HandoffResult,
  Party,
  RunMutationCtx,
  StatesSpec,
  TicketDetail,
  TicketView,
  TransitionType,
} from "../../src/client/index.js";
import { deskQueue } from "../../src/client/presets.js";
import crons, { PURGE_INTERVAL } from "../../src/component/crons.js";
import { components, internal } from "./_generated/api.js";
import { A, B, C, DAY, HOUR, HUMAN, LEAD, MINUTE, REQ, drain, events, expectCode, lab, setup, syncLab } from "./harness.helper.js";
import type { T } from "./harness.helper.js";
import { strictTickets } from "./tickets.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const D: Party = { ref: "agent:d", kind: "agent" };
const CODER: Party = { ref: "agent:coder", kind: "agent" };
const api = lab.component.mutations;

type Row = Awaited<ReturnType<typeof lab.listTransitions>>["page"][number];

async function detailOf(t: T, ticketId: string): Promise<TicketDetail> {
  const detail = await t.run((ctx) => lab.get(ctx, { ticketId, view: "internal" }));
  if (!detail) throw new Error(`ticket ${ticketId} does not exist`);
  return detail;
}

async function ticketOf(t: T, ticketId: string): Promise<TicketView> {
  return (await detailOf(t, ticketId)).ticket;
}

async function leaseOf(t: T, ticketId: string): Promise<number> {
  const expiresAt = (await detailOf(t, ticketId)).leaseExpiresAt;
  if (expiresAt === undefined) throw new Error(`ticket ${ticketId} has no lease`);
  return expiresAt;
}

async function historyOf(t: T, ticketId: string): Promise<Row[]> {
  const result = await t.run((ctx) => lab.listTransitions(ctx, { ticketId, paginationOpts: { cursor: null, numItems: 200 } }));
  return result.page;
}

async function typesOf(t: T, ticketId: string): Promise<TransitionType[]> {
  return (await historyOf(t, ticketId)).map((row) => row.type);
}

async function eventTypes(t: T, ticketId: string): Promise<string[]> {
  const rows = (await events(t)).filter((e) => e.ticketId === ticketId);
  return rows.sort((a, b) => a.seq - b.seq).map((e) => e.type);
}

function count(types: readonly string[], type: string): number {
  return types.filter((candidate) => candidate === type).length;
}

function claimedSeq(result: ClaimResult): number {
  if (!result.ok) throw new Error(`claim refused: ${result.reason}`);
  return result.claimSeq;
}

function acceptedSeq(result: HandoffResult): number {
  if (!result.ok) throw new Error(`handoff refused: ${result.reason}`);
  return result.claimSeq;
}

function refusalOf(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "ok" in value && value.ok === false && "reason" in value) {
    return typeof value.reason === "string" ? value.reason : undefined;
  }
  return undefined;
}

/** `ok`, the `reason` of an `ok: false` result, or the code of a thrown tickets error. */
async function outcomeOf(run: Promise<unknown>): Promise<string> {
  try {
    return refusalOf(await run) ?? "ok";
  } catch (error) {
    if (isTicketsError(error)) return error.data.code;
    throw error;
  }
}

async function claim(t: T, ticketId: string, actor: Party = A): Promise<number> {
  return claimedSeq(await t.run((ctx) => lab.claim(ctx, { ticketId, actor })));
}

async function openAgent(t: T, priority?: number): Promise<string> {
  return await t.run((ctx) => lab.open(ctx, { queue: "agent", actor: REQ, title: "Refund", priority, fields: { amount: 5 } }));
}

async function openPeople(t: T): Promise<string> {
  return await t.run((ctx) => lab.open(ctx, { queue: "people", actor: REQ, title: "Triage" }));
}

async function startedAgent(t: T, holder: Party = A): Promise<{ id: string; seq: number }> {
  const id = await openAgent(t);
  return { id, seq: await claim(t, id, holder) };
}

async function startedPeople(t: T, holder: Party = A): Promise<{ id: string; seq: number }> {
  const id = await openPeople(t);
  return { id, seq: await claim(t, id, holder) };
}

async function waitingAgent(t: T): Promise<{ id: string; seq: number }> {
  const { id, seq } = await startedAgent(t);
  await t.run((ctx) =>
    lab.requestInput(ctx, { queue: "agent", ticketId: id, actor: A, claimSeq: seq, body: "Which order?", fields: ["note"] }),
  );
  return { id, seq };
}

async function resolvedAgent(t: T): Promise<{ id: string; seq: number }> {
  const { id, seq } = await startedAgent(t);
  await t.run((ctx) =>
    lab.resolve(ctx, { queue: "agent", ticketId: id, actor: A, claimSeq: seq, resolution: "completed", result: { ok: true, ref: "re_1" } }),
  );
  return { id, seq };
}

const guard = new Tickets(components.tickets, {
  queues: {
    work: defineQueue({ policy: { leaseMs: null, maxHops: 2, escalateTo: "humans" } }),
    relay: defineQueue({ policy: { leaseMs: null, escalateTo: "humans" } }),
    qa: defineQueue({ policy: { leaseMs: null, escalateTo: "humans" } }),
    qb: defineQueue({ policy: { leaseMs: null, escalateTo: "humans" } }),
    solo: defineQueue({ policy: { leaseMs: null, maxHops: 1 } }),
    humans: defineQueue(deskQueue({ policy: { maxHops: 1, escalateTo: "leads" } })),
    leads: defineQueue(deskQueue()),
  },
  onEvent: internal.hooks.recordOnly,
});

async function passTo(t: T, ticketId: string, from: Party, claimSeq: number, to: Party): Promise<HandoffResult> {
  return await t.run((ctx) => guard.handoff(ctx, { ticketId, actor: from, claimSeq, toParty: to }));
}

async function openWork(t: T): Promise<string> {
  return await t.run((ctx) => guard.open(ctx, { queue: "work", actor: REQ, title: "baton", priority: 3 }));
}

/** Pass a `work` ticket A to B to C, then let D's handoff trip the hop limit: it ends escalated in `humans`. */
async function hopOut(t: T): Promise<{ id: string; seq: number }> {
  const id = await openWork(t);
  const first = acceptedSeq(await passTo(t, id, A, await claim(t, id, A), B));
  const second = acceptedSeq(await passTo(t, id, B, first, C));
  expect(await passTo(t, id, C, second, D)).toEqual({ ok: false, reason: "HOP_LIMIT", escalated: true });
  return { id, seq: second + 1 };
}

const timed = new Tickets(components.tickets, {
  queues: {
    watch: defineQueue({ policy: { leaseMs: null, dueInMs: HOUR, escalateTo: "humans" } }),
    rush: defineQueue({ policy: { leaseMs: null, dueInMs: HOUR, escalateTo: "humans", escalateOnDue: true } }),
    bare: defineQueue({ policy: { leaseMs: null, dueInMs: HOUR, escalateOnDue: true } }),
    humans: defineQueue(deskQueue()),
  },
  onEvent: internal.hooks.recordOnly,
});

const reports = new Tickets(components.tickets, {
  queues: {
    reports: defineQueue({
      states: {
        new: { category: "unstarted" },
        reviewing: { category: "started" },
        need_info: { category: "waiting", on: "requester" },
        actioned: { category: "done" },
        dismissed: { category: "done" },
        withdrawn: { category: "canceled" },
      },
      fields: { reason: { type: "enum", options: ["cheating", "abuse", "spam"], required: true } },
      result: { action: { type: "enum", options: ["none", "warning", "ban"], required: true } },
      policy: { leaseMs: null },
    }),
  },
  onEvent: internal.hooks.recordOnly,
});

async function openReport(t: T): Promise<string> {
  return await t.run((ctx) => reports.open(ctx, { queue: "reports", actor: REQ, title: "Cheater", fields: { reason: "cheating" } }));
}

async function resolvedReport(t: T): Promise<{ id: string; seq: number }> {
  const id = await openReport(t);
  const seq = await claim(t, id, A);
  await t.run((ctx) =>
    reports.resolve(ctx, { queue: "reports", ticketId: id, actor: A, claimSeq: seq, resolution: "completed", result: { action: "ban" } }),
  );
  return { id, seq };
}

describe("handoff", () => {
  test("a handoff to another queue lands unstarted with no holder and raises claimSeq and hopCount", async () => {
    const t = setup();
    await syncLab(t);
    const { id, seq } = await startedAgent(t);
    const result = await t.run((ctx) =>
      lab.handoff(ctx, { ticketId: id, actor: A, claimSeq: seq, toQueue: "people", reason: "needs a person" }),
    );
    expect(result).toEqual({ ok: true, queue: "people", state: "open", claimSeq: seq + 1 });
    const detail = await detailOf(t, id);
    expect(detail.ticket).toMatchObject({ queue: "people", state: "open", category: "unstarted", hopCount: 1, claimSeq: seq + 1 });
    expect(detail.ticket.assigneeRef).toBeUndefined();
    expect(detail.leaseExpiresAt).toBeUndefined();
    const last = (await historyOf(t, id)).at(-1);
    expect(last).toMatchObject({
      type: "handed_off",
      fromQueue: "agent",
      toQueue: "people",
      fromAssigneeRef: A.ref,
      actorRef: A.ref,
      reason: "needs a person",
    });
    expect(last?.toAssigneeRef).toBeUndefined();
    await expectCode(t.run((ctx) => lab.renew(ctx, { ticketId: id, actor: A, claimSeq: seq })), "CLAIM_LOST");
    expect(await claim(t, id, B)).toBe(seq + 2);
  });

  test("a handoff to a named party keeps the ticket started for that party with a new claimSeq and a new lease", async () => {
    const t = setup();
    await syncLab(t);
    const { id, seq } = await startedAgent(t);
    const claimedLease = await leaseOf(t, id);
    await drain(t, MINUTE);
    const result = await t.run((ctx) => lab.handoff(ctx, { ticketId: id, actor: A, claimSeq: seq, toParty: B, reason: "your turn" }));
    expect(result).toEqual({ ok: true, queue: "agent", state: "working", claimSeq: seq + 1 });
    const detail = await detailOf(t, id);
    expect(detail.ticket).toMatchObject({ category: "started", assigneeRef: B.ref, claimSeq: seq + 1, hopCount: 1 });
    expect(detail.leaseExpiresAt).toBeGreaterThanOrEqual(claimedLease + MINUTE);
    expect((await historyOf(t, id)).at(-1)).toMatchObject({ type: "handed_off", fromAssigneeRef: A.ref, toAssigneeRef: B.ref });
    await expectCode(t.run((ctx) => lab.renew(ctx, { ticketId: id, actor: A, claimSeq: seq })), "CLAIM_LOST");
    await expectCode(t.run((ctx) => lab.renew(ctx, { ticketId: id, actor: B, claimSeq: seq })), "CLAIM_LOST");
    await expectCode(
      t.run((ctx) => lab.resolve(ctx, { queue: "agent", ticketId: id, actor: A, claimSeq: seq, resolution: "failed" })),
      "CLAIM_LOST",
    );
    const renewed = await t.run((ctx) => lab.renew(ctx, { ticketId: id, actor: B, claimSeq: seq + 1 }));
    expect(renewed.expiresAt).toBeGreaterThan(detail.leaseExpiresAt ?? 0);
  });

  test("the lease of the new holder runs from the handoff and the old holder's timer does not end it", async () => {
    const t = setup();
    await syncLab(t);
    const { id, seq } = await startedAgent(t);
    await drain(t, MINUTE);
    await t.run((ctx) => lab.handoff(ctx, { ticketId: id, actor: A, claimSeq: seq, toParty: B }));
    await drain(t, 4 * MINUTE + 30_000);
    expect(await ticketOf(t, id)).toMatchObject({ category: "started", assigneeRef: B.ref });
    expect(await typesOf(t, id)).not.toContain("lease_expired");
    await drain(t, MINUTE);
    expect(await ticketOf(t, id)).toMatchObject({ category: "unstarted", leaseExpiryCount: 1 });
    expect(count(await typesOf(t, id), "lease_expired")).toBe(1);
  });

  test("a handoff to a named party in a queue without a lease writes no lease and the party keeps the ticket for days", async () => {
    const t = setup();
    await syncLab(t);
    const { id, seq } = await startedPeople(t);
    const result = await t.run((ctx) => lab.handoff(ctx, { ticketId: id, actor: A, claimSeq: seq, toParty: B }));
    expect(result).toEqual({ ok: true, queue: "people", state: "working", claimSeq: seq + 1 });
    await drain(t, 30 * DAY);
    const detail = await detailOf(t, id);
    expect(detail.leaseExpiresAt).toBeUndefined();
    expect(detail.ticket).toMatchObject({ category: "started", assigneeRef: B.ref, claimSeq: seq + 1 });
    expect(await typesOf(t, id)).not.toContain("lease_expired");
    await expectCode(t.run((ctx) => lab.renew(ctx, { ticketId: id, actor: A, claimSeq: seq })), "CLAIM_LOST");
    expect(await t.run((ctx) => lab.renew(ctx, { ticketId: id, actor: B, claimSeq: seq + 1 }))).toEqual({ expiresAt: null });
  });

  test("a handoff to a party in another queue lands on that queue's first started state", async () => {
    const t = setup();
    await syncLab(t);
    const toProject = await startedAgent(t);
    const projectResult = await t.run((ctx) =>
      lab.handoff(ctx, { ticketId: toProject.id, actor: A, claimSeq: toProject.seq, toQueue: "proj", toParty: B }),
    );
    expect(projectResult).toEqual({ ok: true, queue: "proj", state: "in_progress", claimSeq: toProject.seq + 1 });
    expect(await ticketOf(t, toProject.id)).toMatchObject({ queue: "proj", category: "started", assigneeRef: B.ref, hopCount: 1 });

    const toDesk = await startedAgent(t);
    const deskResult = await t.run((ctx) =>
      lab.handoff(ctx, { ticketId: toDesk.id, actor: A, claimSeq: toDesk.seq, toQueue: "humans", toParty: HUMAN }),
    );
    expect(deskResult).toEqual({ ok: true, queue: "humans", state: "open", claimSeq: toDesk.seq + 1 });
    const desk = await detailOf(t, toDesk.id);
    expect(desk.ticket).toMatchObject({ queue: "humans", category: "started", assigneeRef: HUMAN.ref });
    expect(desk.leaseExpiresAt).toBeUndefined();
  });

  test("a handoff needs toQueue or toParty", async () => {
    const t = setup();
    await syncLab(t);
    const { id, seq } = await startedAgent(t);
    await expectCode(t.run((ctx) => lab.handoff(ctx, { ticketId: id, actor: A, claimSeq: seq })), "INVALID_ARGUMENT");
    expect(await ticketOf(t, id)).toMatchObject({ category: "started", claimSeq: seq, hopCount: 0 });
  });

  test("a handoff is refused with INVALID_MOVE unless the ticket is started", async () => {
    const t = setup();
    await syncLab(t);
    const unstarted = await openAgent(t);
    await expectCode(
      t.run((ctx) => lab.handoff(ctx, { ticketId: unstarted, actor: A, claimSeq: 0, toQueue: "people" })),
      "INVALID_MOVE",
    );
    const waiting = await waitingAgent(t);
    await expectCode(
      t.run((ctx) => lab.handoff(ctx, { ticketId: waiting.id, actor: A, claimSeq: waiting.seq, toQueue: "people" })),
      "INVALID_MOVE",
    );
    const done = await resolvedAgent(t);
    await expectCode(
      t.run((ctx) => lab.handoff(ctx, { ticketId: done.id, actor: A, claimSeq: done.seq, toQueue: "people" })),
      "INVALID_MOVE",
    );
  });

  test("a handoff is refused unless the caller holds the ticket with the current claimSeq", async () => {
    const t = setup();
    await syncLab(t);
    const { id, seq } = await startedAgent(t);
    await expectCode(t.run((ctx) => lab.handoff(ctx, { ticketId: id, actor: B, claimSeq: seq, toQueue: "people" })), "NOT_HOLDER");
    await expectCode(t.run((ctx) => lab.handoff(ctx, { ticketId: id, actor: A, claimSeq: seq + 1, toQueue: "people" })), "CLAIM_LOST");
    expect(await ticketOf(t, id)).toMatchObject({ category: "started", assigneeRef: A.ref, hopCount: 0 });
  });

  test("handoff fields are checked against the target queue and a refused handoff changes nothing", async () => {
    const t = setup();
    await syncLab(t);
    const { id, seq } = await startedAgent(t);
    const before = await detailOf(t, id);
    await expectCode(
      t.run((ctx) => ctx.runMutation(api.handoff, { ticketId: id, actor: A, claimSeq: seq, toQueue: "proj", fields: { amount: 7 } })),
      "UNKNOWN_FIELD",
    );
    await expectCode(
      t.run((ctx) => ctx.runMutation(api.handoff, { ticketId: id, actor: A, claimSeq: seq, toQueue: "proj", fields: { estimate: "big" } })),
      "INVALID_FIELD",
    );
    expect(await detailOf(t, id)).toEqual(before);

    await t.run((ctx) => lab.handoff(ctx, { ticketId: id, actor: A, claimSeq: seq, toQueue: "proj", fields: { estimate: 8 } }));
    expect((await ticketOf(t, id)).fields).toEqual({ amount: 5, estimate: 8 });
  });

  test("a handoff within a queue merges fields and null clears an optional one", async () => {
    const t = setup();
    await syncLab(t);
    const id = await t.run((ctx) => lab.open(ctx, { queue: "agent", actor: REQ, title: "Refund", fields: { amount: 5, note: "first" } }));
    const seq = await claim(t, id);
    const next = await t.run((ctx) =>
      lab.handoff(ctx, { ticketId: id, actor: A, claimSeq: seq, toQueue: "agent", toParty: B, fields: { currency: "EUR", note: null } }),
    );
    expect(next.ok).toBe(true);
    expect((await ticketOf(t, id)).fields).toEqual({ amount: 5, currency: "EUR" });
  });

  test("the handoff that brings hopCount up to maxHops is allowed and the next one returns HOP_LIMIT and escalates", async () => {
    const t = setup();
    await t.run((ctx) => guard.sync(ctx));
    const id = await openWork(t);
    const first = acceptedSeq(await passTo(t, id, A, await claim(t, id, A), B));
    const second = acceptedSeq(await passTo(t, id, B, first, C));
    expect(await ticketOf(t, id)).toMatchObject({ queue: "work", category: "started", hopCount: 2, assigneeRef: C.ref });

    const refusedAt = Date.now();
    const refused = await passTo(t, id, C, second, D);
    expect(refused).toEqual({ ok: false, reason: "HOP_LIMIT", escalated: true });
    const ticket = await ticketOf(t, id);
    expect(ticket).toMatchObject({ queue: "humans", state: "new", category: "unstarted", priority: 2, hopCount: 2, claimSeq: second + 1 });
    expect(ticket.escalatedAt).toBeGreaterThanOrEqual(refusedAt);
    expect(ticket.escalatedAt).toBeLessThanOrEqual(refusedAt + 1000);
    expect(ticket.assigneeRef).toBeUndefined();
    expect((await historyOf(t, id)).at(-1)).toMatchObject({
      type: "escalated",
      actorRef: SYSTEM_PARTY.ref,
      fromQueue: "work",
      toQueue: "humans",
      reason: "handoff refused: HOP_LIMIT",
    });
    await expectCode(t.run((ctx) => lab.renew(ctx, { ticketId: id, actor: C, claimSeq: second })), "CLAIM_LOST");
  });

  test("two parties passing a ticket back and forth trip PING_PONG and the ticket lands in the escalation queue", async () => {
    const t = setup();
    await t.run((ctx) => guard.sync(ctx));
    const id = await t.run((ctx) => guard.open(ctx, { queue: "relay", actor: REQ, title: "baton" }));
    let seq = await claim(t, id, A);
    seq = acceptedSeq(await passTo(t, id, A, seq, B));
    seq = acceptedSeq(await passTo(t, id, B, seq, A));
    seq = acceptedSeq(await passTo(t, id, A, seq, B));
    expect(await ticketOf(t, id)).toMatchObject({ queue: "relay", category: "started", assigneeRef: B.ref, hopCount: 3 });

    const refused = await passTo(t, id, B, seq, A);
    expect(refused).toEqual({ ok: false, reason: "PING_PONG", escalated: true });
    expect(await ticketOf(t, id)).toMatchObject({ queue: "humans", state: "new", category: "unstarted", hopCount: 3 });
    expect((await historyOf(t, id)).at(-1)).toMatchObject({ type: "escalated", reason: "handoff refused: PING_PONG" });
  });

  test("a ticket passed between two queues trips PING_PONG on the fourth pass", async () => {
    const t = setup();
    await t.run((ctx) => guard.sync(ctx));
    const id = await t.run((ctx) => guard.open(ctx, { queue: "qa", actor: REQ, title: "baton" }));
    const passFrom = async (from: Party, queue: "qa" | "qb") => {
      const seq = await claim(t, id, from);
      return await t.run((ctx) => guard.handoff(ctx, { ticketId: id, actor: from, claimSeq: seq, toQueue: queue }));
    };
    acceptedSeq(await passFrom(A, "qb"));
    acceptedSeq(await passFrom(B, "qa"));
    acceptedSeq(await passFrom(C, "qb"));
    expect(await ticketOf(t, id)).toMatchObject({ queue: "qb", category: "unstarted", hopCount: 3 });
    expect(await passFrom(D, "qa")).toEqual({ ok: false, reason: "PING_PONG", escalated: true });
    expect(await ticketOf(t, id)).toMatchObject({ queue: "humans", category: "unstarted", hopCount: 3 });
  });

  test("a refusal on an already escalated ticket does not escalate again", async () => {
    const t = setup();
    await t.run((ctx) => guard.sync(ctx));
    const { id } = await hopOut(t);
    const seq = await claim(t, id, HUMAN);
    const again = await t.run((ctx) => guard.handoff(ctx, { ticketId: id, actor: HUMAN, claimSeq: seq, toParty: C }));
    expect(again).toEqual({ ok: false, reason: "HOP_LIMIT", escalated: false });
    expect(count(await typesOf(t, id), "escalated")).toBe(1);
    expect(await ticketOf(t, id)).toMatchObject({ queue: "humans", category: "started", assigneeRef: HUMAN.ref, claimSeq: seq });
  });

  test("a queue without escalateTo refuses at the hop limit with escalated false and the holder keeps the ticket", async () => {
    const t = setup();
    await t.run((ctx) => guard.sync(ctx));
    const id = await t.run((ctx) => guard.open(ctx, { queue: "solo", actor: REQ, title: "baton" }));
    const seq = acceptedSeq(await passTo(t, id, A, await claim(t, id, A), B));
    const refused = await passTo(t, id, B, seq, C);
    expect(refused).toEqual({ ok: false, reason: "HOP_LIMIT", escalated: false });
    expect(await ticketOf(t, id)).toMatchObject({ queue: "solo", category: "started", assigneeRef: B.ref, claimSeq: seq, hopCount: 1 });
    expect(await typesOf(t, id)).not.toContain("escalated");
  });
});

describe("escalate", () => {
  test.each([
    [4, 3],
    [2, 1],
    [1, 0],
    [0, 0],
  ])("escalating a priority %i ticket leaves it at priority %i", async (from, to) => {
    const t = setup();
    await syncLab(t);
    const id = await openAgent(t, from);
    const seq = await claim(t, id);
    await t.run((ctx) => lab.escalate(ctx, { ticketId: id, actor: A, claimSeq: seq, reason: "stuck" }));
    expect((await ticketOf(t, id)).priority).toBe(to);
  });

  test("a holder's escalation lands in the escalation queue, stamps escalatedAt, clears the holder and stops the lease", async () => {
    const t = setup();
    await syncLab(t);
    const { id, seq } = await startedAgent(t);
    const escalatedAt = Date.now();
    const result = await t.run((ctx) => lab.escalate(ctx, { ticketId: id, actor: A, claimSeq: seq, reason: "needs a lead" }));
    expect(result).toEqual({ queue: "humans", state: "new", category: "unstarted", claimSeq: seq + 1 });
    const detail = await detailOf(t, id);
    expect(detail.ticket.escalatedAt).toBeGreaterThanOrEqual(escalatedAt);
    expect(detail.ticket.escalatedAt).toBeLessThanOrEqual(escalatedAt + 1000);
    expect(detail.ticket.assigneeRef).toBeUndefined();
    expect(detail.leaseExpiresAt).toBeUndefined();
    expect((await historyOf(t, id)).at(-1)).toMatchObject({
      type: "escalated",
      actorRef: A.ref,
      reason: "needs a lead",
      fromQueue: "agent",
      toQueue: "humans",
    });
    await drain(t, 10 * MINUTE);
    expect(await typesOf(t, id)).not.toContain("lease_expired");
    expect(await ticketOf(t, id)).toMatchObject({ queue: "humans", category: "unstarted" });
    await expectCode(t.run((ctx) => lab.renew(ctx, { ticketId: id, actor: A, claimSeq: seq })), "CLAIM_LOST");
  });

  test("a trusted caller may escalate an unstarted ticket nobody holds", async () => {
    const t = setup();
    await syncLab(t);
    const id = await openAgent(t, 3);
    const result = await t.run((ctx) => lab.escalate(ctx, { ticketId: id, actor: LEAD, trusted: true, reason: "VIP" }));
    expect(result).toMatchObject({ queue: "humans", state: "new", category: "unstarted" });
    expect(await ticketOf(t, id)).toMatchObject({ priority: 2, queue: "humans" });
  });

  test("an untrusted party cannot escalate an unstarted ticket", async () => {
    const t = setup();
    await syncLab(t);
    const id = await openAgent(t);
    await expectCode(t.run((ctx) => lab.escalate(ctx, { ticketId: id, actor: REQ, claimSeq: 0, reason: "now" })), "NOT_HOLDER");
    await expectCode(t.run((ctx) => lab.escalate(ctx, { ticketId: id, actor: REQ, reason: "now" })), "INVALID_ARGUMENT");
    expect(await ticketOf(t, id)).toMatchObject({ queue: "agent", category: "unstarted", claimSeq: 0 });
  });

  test("escalate by a party that is not the holder gets NOT_HOLDER and a stale claimSeq gets CLAIM_LOST", async () => {
    const t = setup();
    await syncLab(t);
    const { id, seq } = await startedAgent(t);
    await expectCode(t.run((ctx) => lab.escalate(ctx, { ticketId: id, actor: B, claimSeq: seq, reason: "x" })), "NOT_HOLDER");
    await expectCode(t.run((ctx) => lab.escalate(ctx, { ticketId: id, actor: A, claimSeq: seq + 1, reason: "x" })), "CLAIM_LOST");
    expect(await ticketOf(t, id)).toMatchObject({ queue: "agent", category: "started", assigneeRef: A.ref });
  });

  test("a queue without escalateTo refuses escalate with NO_ESCALATION and the ticket stays put", async () => {
    const t = setup();
    await syncLab(t);
    const { id, seq } = await startedPeople(t);
    const before = await detailOf(t, id);
    await expectCode(t.run((ctx) => lab.escalate(ctx, { ticketId: id, actor: A, claimSeq: seq, reason: "x" })), "NO_ESCALATION");
    await expectCode(t.run((ctx) => lab.escalate(ctx, { ticketId: id, actor: LEAD, trusted: true, reason: "x" })), "NO_ESCALATION");
    expect(await detailOf(t, id)).toEqual(before);
  });

  test("an escalation is exempt from the hop limit", async () => {
    const t = setup();
    await t.run((ctx) => guard.sync(ctx));
    const id = await openWork(t);
    const first = acceptedSeq(await passTo(t, id, A, await claim(t, id, A), B));
    const second = acceptedSeq(await passTo(t, id, B, first, C));
    expect(await ticketOf(t, id)).toMatchObject({ hopCount: 2 });
    const result = await t.run((ctx) => guard.escalate(ctx, { ticketId: id, actor: C, claimSeq: second, reason: "stuck" }));
    expect(result).toMatchObject({ queue: "humans", category: "unstarted" });
    expect(await ticketOf(t, id)).toMatchObject({ hopCount: 2, queue: "humans" });
  });
});

describe("due time", () => {
  test("due_breached fires once at dueAt and not again", async () => {
    const t = setup();
    await t.run((ctx) => timed.sync(ctx));
    const openedAt = Date.now();
    const id = await t.run((ctx) => timed.open(ctx, { queue: "watch", actor: REQ, title: "slow" }));
    const dueAt = (await ticketOf(t, id)).dueAt;
    expect(dueAt).toBeGreaterThanOrEqual(openedAt + HOUR);
    expect(dueAt).toBeLessThanOrEqual(openedAt + HOUR + 1000);

    await drain(t, HOUR - 5 * MINUTE);
    expect((await ticketOf(t, id)).dueBreachedAt).toBeUndefined();
    expect(count(await typesOf(t, id), "due_breached")).toBe(0);

    await drain(t, 10 * MINUTE);
    const ticket = await ticketOf(t, id);
    expect(ticket.dueBreachedAt).toBeGreaterThanOrEqual(openedAt + HOUR);
    expect(ticket).toMatchObject({ queue: "watch", category: "unstarted" });
    expect(count(await typesOf(t, id), "due_breached")).toBe(1);
    expect(count(await eventTypes(t, id), "due_breached")).toBe(1);

    await drain(t, 3 * DAY);
    expect(count(await typesOf(t, id), "due_breached")).toBe(1);
    expect(count(await eventTypes(t, id), "due_breached")).toBe(1);
  });

  test("with escalateOnDue the ticket escalates at dueAt and the old holder's claim is lost", async () => {
    const t = setup();
    await t.run((ctx) => timed.sync(ctx));
    const openedAt = Date.now();
    const id = await t.run((ctx) => timed.open(ctx, { queue: "rush", actor: REQ, title: "urgent" }));
    const seq = await claim(t, id, A);
    await drain(t, HOUR + MINUTE);
    const ticket = await ticketOf(t, id);
    expect(ticket).toMatchObject({ queue: "humans", state: "new", category: "unstarted", claimSeq: seq + 1 });
    expect(ticket.escalatedAt).toBeGreaterThanOrEqual(openedAt + HOUR);
    expect(ticket.assigneeRef).toBeUndefined();
    expect(await typesOf(t, id)).toEqual(["opened", "claimed", "due_breached", "escalated"]);
    await expectCode(t.run((ctx) => lab.renew(ctx, { ticketId: id, actor: A, claimSeq: seq })), "CLAIM_LOST");
  });

  test("escalateOnDue without an escalateTo queue records the breach and leaves the ticket in place", async () => {
    const t = setup();
    await t.run((ctx) => timed.sync(ctx));
    const id = await t.run((ctx) => timed.open(ctx, { queue: "bare", actor: REQ, title: "late" }));
    await drain(t, HOUR + MINUTE);
    expect(await ticketOf(t, id)).toMatchObject({ queue: "bare", category: "unstarted" });
    expect(await typesOf(t, id)).toEqual(["opened", "due_breached"]);
  });

  test("a ticket resolved before dueAt never breaches", async () => {
    const t = setup();
    await t.run((ctx) => timed.sync(ctx));
    const id = await t.run((ctx) => timed.open(ctx, { queue: "watch", actor: REQ, title: "quick" }));
    const seq = await claim(t, id, A);
    await t.run((ctx) => timed.resolve(ctx, { queue: "watch", ticketId: id, actor: A, claimSeq: seq, resolution: "completed" }));
    await drain(t, 2 * HOUR);
    const ticket = await ticketOf(t, id);
    expect(ticket.category).toBe("done");
    expect(ticket.dueBreachedAt).toBeUndefined();
    expect(await typesOf(t, id)).not.toContain("due_breached");
  });

  test("a ticket canceled before dueAt never breaches", async () => {
    const t = setup();
    await t.run((ctx) => timed.sync(ctx));
    const id = await t.run((ctx) => timed.open(ctx, { queue: "rush", actor: REQ, title: "dropped" }));
    await t.run((ctx) => timed.cancel(ctx, { ticketId: id, actor: REQ }));
    await drain(t, 2 * HOUR);
    expect(await ticketOf(t, id)).toMatchObject({ category: "canceled", queue: "rush" });
    expect(await typesOf(t, id)).toEqual(["opened", "canceled"]);
  });
});

describe("resolve", () => {
  test("resolve is refused with INVALID_MOVE unless the ticket is started", async () => {
    const t = setup();
    await syncLab(t);
    const unstarted = await openAgent(t);
    await expectCode(
      t.run((ctx) => lab.resolve(ctx, { ticketId: unstarted, actor: A, claimSeq: 0, resolution: "failed" })),
      "INVALID_MOVE",
    );
    const waiting = await waitingAgent(t);
    await expectCode(
      t.run((ctx) => lab.resolve(ctx, { ticketId: waiting.id, actor: A, claimSeq: waiting.seq, resolution: "failed" })),
      "INVALID_MOVE",
    );
    const done = await resolvedAgent(t);
    await expectCode(
      t.run((ctx) => lab.resolve(ctx, { ticketId: done.id, actor: A, claimSeq: done.seq, resolution: "failed" })),
      "INVALID_MOVE",
    );
  });

  test("resolve needs the holder with the current claimSeq", async () => {
    const t = setup();
    await syncLab(t);
    const { id, seq } = await startedAgent(t);
    const result = { ok: true };
    await expectCode(
      t.run((ctx) => lab.resolve(ctx, { ticketId: id, actor: B, claimSeq: seq, resolution: "completed", result })),
      "NOT_HOLDER",
    );
    await expectCode(
      t.run((ctx) => lab.resolve(ctx, { ticketId: id, actor: A, claimSeq: seq + 1, resolution: "completed", result })),
      "CLAIM_LOST",
    );
    expect(await ticketOf(t, id)).toMatchObject({ category: "started", assigneeRef: A.ref, claimSeq: seq });
  });

  test("a completed resolution needs every required result key and then lands in the first done state", async () => {
    const t = setup();
    await syncLab(t);
    const { id, seq } = await startedAgent(t);
    await expectCode(t.run((ctx) => lab.resolve(ctx, { ticketId: id, actor: A, claimSeq: seq, resolution: "completed" })), "MISSING_FIELD");
    await expectCode(
      t.run((ctx) => lab.resolve(ctx, { ticketId: id, actor: A, claimSeq: seq, resolution: "completed", result: { ref: "re_1" } })),
      "MISSING_FIELD",
    );
    expect(await ticketOf(t, id)).toMatchObject({ category: "started" });

    const landed = await t.run((ctx) =>
      lab.resolve(ctx, { ticketId: id, actor: A, claimSeq: seq, resolution: "completed", result: { ok: true } }),
    );
    expect(landed).toEqual({ queue: "agent", state: "resolved", category: "done", claimSeq: seq });
    const ticket = await ticketOf(t, id);
    expect(ticket).toMatchObject({ resolution: "completed", result: { ok: true } });
    expect(ticket.resolvedAt).toBeDefined();
    expect((await historyOf(t, id)).at(-1)).toMatchObject({ type: "resolved", actorRef: A.ref });
  });

  test.each(["failed", "rejected"] as const)("a %s resolution may omit the result", async (resolution) => {
    const t = setup();
    await syncLab(t);
    const { id, seq } = await startedAgent(t);
    await t.run((ctx) => lab.resolve(ctx, { ticketId: id, actor: A, claimSeq: seq, resolution }));
    const ticket = await ticketOf(t, id);
    expect(ticket).toMatchObject({ category: "done", resolution });
    expect(Object.keys(ticket.result ?? {})).toEqual([]);
  });

  test("a result key the queue does not declare gets UNKNOWN_FIELD and a wrongly typed one INVALID_FIELD", async () => {
    const t = setup();
    await syncLab(t);
    const { id, seq } = await startedAgent(t);
    const before = await detailOf(t, id);
    const resolve = async (resolution: "completed" | "failed", result: Record<string, string | number | boolean>) =>
      await t.run((ctx) => ctx.runMutation(api.resolve, { ticketId: id, actor: A, claimSeq: seq, resolution, result }));
    await expectCode(resolve("completed", { ok: true, bogus: 1 }), "UNKNOWN_FIELD");
    await expectCode(resolve("failed", { bogus: 1 }), "UNKNOWN_FIELD");
    await expectCode(resolve("completed", { ok: "yes" }), "INVALID_FIELD");
    await expectCode(resolve("failed", { ok: "yes" }), "INVALID_FIELD");
    await expectCode(resolve("failed", { ref: 7 }), "INVALID_FIELD");
    expect(await detailOf(t, id)).toEqual(before);
  });

  test("resolve to a named done state lands there and a state that is not done is refused", async () => {
    const t = setup();
    await t.run((ctx) => reports.sync(ctx));
    const id = await openReport(t);
    const seq = await claim(t, id, A);
    const resolve = async (to: "dismissed" | "new" | "reviewing") =>
      await t.run((ctx) =>
        reports.resolve(ctx, { queue: "reports", ticketId: id, actor: A, claimSeq: seq, resolution: "completed", result: { action: "warning" }, to }),
      );
    await expectCode(resolve("new"), "INVALID_TARGET");
    await expectCode(resolve("reviewing"), "INVALID_TARGET");
    await expectCode(
      t.run((ctx) =>
        ctx.runMutation(api.resolve, { ticketId: id, actor: A, claimSeq: seq, resolution: "failed", to: "nowhere" }),
      ),
      "UNKNOWN_STATE",
    );
    expect(await ticketOf(t, id)).toMatchObject({ category: "started" });
    expect(await resolve("dismissed")).toEqual({ queue: "reports", state: "dismissed", category: "done", claimSeq: seq });
  });

  test("resolve without a target lands in the queue's first done state", async () => {
    const t = setup();
    await t.run((ctx) => reports.sync(ctx));
    const { id } = await resolvedReport(t);
    expect(await ticketOf(t, id)).toMatchObject({ state: "actioned", category: "done", result: { action: "ban" } });
  });

  test("resolve with a body adds a public message written by the holder", async () => {
    const t = setup();
    await syncLab(t);
    const { id, seq } = await startedAgent(t);
    await t.run((ctx) =>
      lab.resolve(ctx, { ticketId: id, actor: A, claimSeq: seq, resolution: "completed", result: { ok: true }, body: "Refund sent" }),
    );
    const detail = await detailOf(t, id);
    expect(detail.ticket.messageCount).toBe(1);
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]).toMatchObject({ authorRef: A.ref, visibility: "public", kind: "message", body: "Refund sent" });
    const publicView = await t.run((ctx) => lab.get(ctx, { ticketId: id }));
    expect(publicView?.messages.map((m) => m.body)).toEqual(["Refund sent"]);
  });

  test("resolve typed for another queue gets WRONG_QUEUE", async () => {
    const t = setup();
    await syncLab(t);
    const { id, seq } = await startedAgent(t);
    await expectCode(
      t.run((ctx) => lab.resolve(ctx, { queue: "people", ticketId: id, actor: A, claimSeq: seq, resolution: "failed" })),
      "WRONG_QUEUE",
    );
    expect(await ticketOf(t, id)).toMatchObject({ queue: "agent", category: "started" });
  });

  test("resolve stops the lease so no lease_expired follows", async () => {
    const t = setup();
    await syncLab(t);
    const { id, seq } = await startedAgent(t);
    expect(await leaseOf(t, id)).toBeGreaterThan(Date.now());
    await t.run((ctx) => lab.resolve(ctx, { ticketId: id, actor: A, claimSeq: seq, resolution: "failed" }));
    expect((await detailOf(t, id)).leaseExpiresAt).toBeUndefined();
    await drain(t, 10 * MINUTE);
    expect(await typesOf(t, id)).toEqual(["opened", "claimed", "resolved"]);
    expect(await ticketOf(t, id)).toMatchObject({ category: "done" });
  });
});

describe("reopen", () => {
  test("only the requester or a trusted caller may reopen", async () => {
    const t = setup();
    await syncLab(t);
    const first = await resolvedAgent(t);
    await expectCode(t.run((ctx) => lab.reopen(ctx, { ticketId: first.id, actor: B })), "NOT_REQUESTER");
    await expectCode(t.run((ctx) => lab.reopen(ctx, { ticketId: first.id, actor: A })), "NOT_REQUESTER");
    expect(await ticketOf(t, first.id)).toMatchObject({ category: "done" });
    await t.run((ctx) => lab.reopen(ctx, { ticketId: first.id, actor: REQ }));
    expect(await ticketOf(t, first.id)).toMatchObject({ category: "unstarted" });

    const second = await resolvedAgent(t);
    await t.run((ctx) => lab.reopen(ctx, { ticketId: second.id, actor: LEAD, trusted: true }));
    expect(await ticketOf(t, second.id)).toMatchObject({ category: "unstarted" });
  });

  test("reopening a done ticket lands it unstarted and clears resolution, result, holder and resolvedAt", async () => {
    const t = setup();
    await syncLab(t);
    const { id, seq } = await resolvedAgent(t);
    const result = await t.run((ctx) => lab.reopen(ctx, { ticketId: id, actor: REQ, reason: "not fixed" }));
    expect(result).toEqual({ queue: "agent", state: "open", category: "unstarted", claimSeq: seq + 1 });
    const ticket = await ticketOf(t, id);
    expect(ticket).toMatchObject({ fields: { amount: 5 }, claimSeq: seq + 1 });
    expect(ticket.resolution).toBeUndefined();
    expect(ticket.result).toBeUndefined();
    expect(ticket.assigneeRef).toBeUndefined();
    expect(ticket.resolvedAt).toBeUndefined();
    expect((await historyOf(t, id)).at(-1)).toMatchObject({ type: "reopened", actorRef: REQ.ref, reason: "not fixed" });
    expect(await claim(t, id, B)).toBe(seq + 2);
  });

  test("reopening a canceled ticket lands it unstarted and clears canceledAt", async () => {
    const t = setup();
    await syncLab(t);
    const id = await openAgent(t);
    await t.run((ctx) => lab.cancel(ctx, { ticketId: id, actor: REQ }));
    expect((await ticketOf(t, id)).canceledAt).toBeDefined();
    const result = await t.run((ctx) => lab.reopen(ctx, { ticketId: id, actor: REQ }));
    expect(result).toEqual({ queue: "agent", state: "open", category: "unstarted", claimSeq: 1 });
    expect((await ticketOf(t, id)).canceledAt).toBeUndefined();
  });

  test("reopen can name an unstarted state and refuses any other", async () => {
    const t = setup();
    await syncLab(t);
    const id = await t.run((ctx) => lab.open(ctx, { queue: "proj", actor: REQ, title: "Ship it" }));
    const seq = await claim(t, id, A);
    await t.run((ctx) => lab.resolve(ctx, { ticketId: id, actor: A, claimSeq: seq, resolution: "completed" }));
    await expectCode(t.run((ctx) => lab.reopen(ctx, { ticketId: id, actor: REQ, to: "backlog" })), "INVALID_TARGET");
    await expectCode(t.run((ctx) => lab.reopen(ctx, { ticketId: id, actor: REQ, to: "in_progress" })), "INVALID_TARGET");
    expect(await ticketOf(t, id)).toMatchObject({ category: "done" });
    const result = await t.run((ctx) => lab.reopen(ctx, { ticketId: id, actor: REQ, to: "todo" }));
    expect(result).toMatchObject({ state: "todo", category: "unstarted" });
  });

  test("reopen is allowed just before the window ends and SEALED after it, for the requester and a trusted caller", async () => {
    const t = setup();
    await syncLab(t);
    const early = await resolvedAgent(t);
    const late = await resolvedAgent(t);
    await drain(t, 7 * DAY - HOUR);
    await t.run((ctx) => lab.reopen(ctx, { ticketId: early.id, actor: REQ }));
    expect(await ticketOf(t, early.id)).toMatchObject({ category: "unstarted" });

    await drain(t, 2 * HOUR);
    expect((await ticketOf(t, late.id)).closedAt).toBeDefined();
    await expectCode(t.run((ctx) => lab.reopen(ctx, { ticketId: late.id, actor: REQ })), "SEALED");
    await expectCode(t.run((ctx) => lab.reopen(ctx, { ticketId: late.id, actor: LEAD, trusted: true })), "SEALED");
  });

  test("reopen is refused with INVALID_MOVE on an unstarted, started or waiting ticket", async () => {
    const t = setup();
    await syncLab(t);
    const unstarted = await openAgent(t);
    const started = await startedAgent(t);
    const waiting = await waitingAgent(t);
    for (const id of [unstarted, started.id, waiting.id]) {
      await expectCode(t.run((ctx) => lab.reopen(ctx, { ticketId: id, actor: REQ })), "INVALID_MOVE");
      await expectCode(t.run((ctx) => lab.reopen(ctx, { ticketId: id, actor: LEAD, trusted: true })), "INVALID_MOVE");
    }
  });

  test("a plain reply by the requester on a done or canceled ticket adds a message and never reopens it", async () => {
    const t = setup();
    await syncLab(t);
    const done = await resolvedAgent(t);
    const reply = await t.run((ctx) => lab.reply(ctx, { ticketId: done.id, actor: REQ, body: "thanks!" }));
    expect(reply).toMatchObject({ ok: true, resumed: false, duplicate: false });
    expect(await ticketOf(t, done.id)).toMatchObject({ category: "done", messageCount: 1, claimSeq: done.seq });
    expect(await typesOf(t, done.id)).not.toContain("reopened");

    const canceled = await openAgent(t);
    await t.run((ctx) => lab.cancel(ctx, { ticketId: canceled, actor: REQ }));
    await t.run((ctx) => lab.reply(ctx, { ticketId: canceled, actor: REQ, body: "never mind" }));
    expect(await ticketOf(t, canceled)).toMatchObject({ category: "canceled", messageCount: 1 });
    expect(await typesOf(t, canceled)).toEqual(["opened", "canceled"]);
  });

  test("reopening a completed blocker makes its dependent blocked again and completing it again frees it", async () => {
    const t = setup();
    await syncLab(t);
    const blocker = await openPeople(t);
    const dependent = await t.run((ctx) => lab.open(ctx, { queue: "people", actor: REQ, title: "Waits", blockedBy: [blocker] }));
    expect((await ticketOf(t, dependent)).openBlockers).toBe(1);
    const complete = async () => {
      const seq = await claim(t, blocker, A);
      await t.run((ctx) => lab.resolve(ctx, { ticketId: blocker, actor: A, claimSeq: seq, resolution: "completed" }));
    };
    await complete();
    expect((await ticketOf(t, dependent)).openBlockers).toBe(0);
    await t.run((ctx) => lab.reopen(ctx, { ticketId: blocker, actor: REQ }));
    expect((await ticketOf(t, dependent)).openBlockers).toBe(1);
    await complete();
    expect((await ticketOf(t, dependent)).openBlockers).toBe(0);
  });
});

describe("cancel", () => {
  test("the requester and a trusted caller may cancel and any other party gets NOT_REQUESTER", async () => {
    const t = setup();
    await syncLab(t);
    const id = await openAgent(t);
    await expectCode(t.run((ctx) => lab.cancel(ctx, { ticketId: id, actor: B })), "NOT_REQUESTER");
    const held = await startedAgent(t);
    await expectCode(t.run((ctx) => lab.cancel(ctx, { ticketId: held.id, actor: A })), "NOT_REQUESTER");
    expect(await ticketOf(t, held.id)).toMatchObject({ category: "started" });

    const result = await t.run((ctx) => lab.cancel(ctx, { ticketId: id, actor: REQ }));
    expect(result).toEqual({ queue: "agent", state: "canceled", category: "canceled", claimSeq: 0 });
    await t.run((ctx) => lab.cancel(ctx, { ticketId: held.id, actor: LEAD, trusted: true }));
    expect(await ticketOf(t, held.id)).toMatchObject({ category: "canceled" });
  });

  test("a canceled ticket carries no resolution and no result, stamps canceledAt and stops the lease", async () => {
    const t = setup();
    await syncLab(t);
    const { id } = await startedAgent(t);
    await t.run((ctx) => lab.cancel(ctx, { ticketId: id, actor: REQ, reason: "no longer needed" }));
    const detail = await detailOf(t, id);
    expect(detail.ticket).toMatchObject({ category: "canceled", state: "canceled" });
    expect(detail.ticket.resolution).toBeUndefined();
    expect(detail.ticket.result).toBeUndefined();
    expect(detail.ticket.resolvedAt).toBeUndefined();
    expect(detail.ticket.canceledAt).toBeDefined();
    expect(detail.leaseExpiresAt).toBeUndefined();
    await drain(t, 10 * MINUTE);
    expect(await typesOf(t, id)).toEqual(["opened", "claimed", "canceled"]);
    expect((await historyOf(t, id)).at(-1)).toMatchObject({ reason: "no longer needed", actorRef: REQ.ref });
  });

  test("cancel can name a canceled state and refuses any other", async () => {
    const t = setup();
    await t.run((ctx) => reports.sync(ctx));
    const id = await openReport(t);
    await expectCode(t.run((ctx) => reports.cancel(ctx, { ticketId: id, actor: REQ, to: "dismissed" })), "INVALID_TARGET");
    const result = await t.run((ctx) => reports.cancel(ctx, { ticketId: id, actor: REQ, to: "withdrawn" }));
    expect(result).toMatchObject({ state: "withdrawn", category: "canceled" });
  });

  test("cancel is refused with INVALID_MOVE on a done or canceled ticket", async () => {
    const t = setup();
    await syncLab(t);
    const done = await resolvedAgent(t);
    await expectCode(t.run((ctx) => lab.cancel(ctx, { ticketId: done.id, actor: REQ })), "INVALID_MOVE");
    const canceled = await openAgent(t);
    await t.run((ctx) => lab.cancel(ctx, { ticketId: canceled, actor: REQ }));
    await expectCode(t.run((ctx) => lab.cancel(ctx, { ticketId: canceled, actor: REQ })), "INVALID_MOVE");
  });

  test("a canceled ticket can be reopened before the seal and not after", async () => {
    const t = setup();
    await syncLab(t);
    const early = await openAgent(t);
    const late = await openAgent(t);
    await t.run((ctx) => lab.cancel(ctx, { ticketId: early, actor: REQ }));
    await t.run((ctx) => lab.cancel(ctx, { ticketId: late, actor: REQ }));
    await drain(t, 6 * DAY);
    await t.run((ctx) => lab.reopen(ctx, { ticketId: early, actor: REQ }));
    expect(await ticketOf(t, early)).toMatchObject({ category: "unstarted" });
    await drain(t, 2 * DAY);
    expect((await ticketOf(t, late)).closedAt).toBeDefined();
    await expectCode(t.run((ctx) => lab.reopen(ctx, { ticketId: late, actor: REQ })), "SEALED");
  });
});

describe("seal", () => {
  test("a done ticket is not sealed before its reopen window ends and the system seals it after", async () => {
    const t = setup();
    await syncLab(t);
    const { id } = await resolvedAgent(t);
    await drain(t, 7 * DAY - HOUR);
    expect((await ticketOf(t, id)).closedAt).toBeUndefined();
    expect(await typesOf(t, id)).not.toContain("closed");

    await drain(t, 2 * HOUR);
    const ticket = await ticketOf(t, id);
    expect(ticket.closedAt).toBeGreaterThanOrEqual((ticket.resolvedAt ?? 0) + 7 * DAY);
    expect(ticket.category).toBe("done");
    expect((await historyOf(t, id)).at(-1)).toMatchObject({
      type: "closed",
      actorRef: SYSTEM_PARTY.ref,
      fromCategory: "done",
      toCategory: "done",
    });
    expect(count(await eventTypes(t, id), "closed")).toBe(1);
  });

  test("a canceled ticket is sealed by the timer at the end of its window", async () => {
    const t = setup();
    await syncLab(t);
    const id = await openAgent(t);
    await t.run((ctx) => lab.cancel(ctx, { ticketId: id, actor: REQ }));
    await drain(t, 7 * DAY - HOUR);
    expect((await ticketOf(t, id)).closedAt).toBeUndefined();
    await drain(t, 2 * HOUR);
    expect((await ticketOf(t, id)).closedAt).toBeDefined();
    expect(await typesOf(t, id)).toEqual(["opened", "canceled", "closed"]);
  });

  test("a ticket reopened inside the window is not sealed by the old timer", async () => {
    const t = setup();
    await syncLab(t);
    const { id } = await resolvedAgent(t);
    await drain(t, 3 * DAY);
    await t.run((ctx) => lab.reopen(ctx, { ticketId: id, actor: REQ }));
    await drain(t, 5 * DAY);
    const ticket = await ticketOf(t, id);
    expect(ticket.closedAt).toBeUndefined();
    expect(ticket.category).toBe("unstarted");
    expect(await typesOf(t, id)).not.toContain("closed");
  });

  test("resolving a reopened ticket again starts a new window that ends later than the old one", async () => {
    const t = setup();
    await syncLab(t);
    const { id } = await resolvedAgent(t);
    await drain(t, 3 * DAY);
    await t.run((ctx) => lab.reopen(ctx, { ticketId: id, actor: REQ }));
    const seq = await claim(t, id, B);
    await t.run((ctx) => lab.resolve(ctx, { ticketId: id, actor: B, claimSeq: seq, resolution: "completed", result: { ok: true } }));
    await drain(t, 5 * DAY);
    expect((await ticketOf(t, id)).closedAt).toBeUndefined();
    await drain(t, 3 * DAY);
    expect((await ticketOf(t, id)).closedAt).toBeDefined();
    expect(count(await typesOf(t, id), "closed")).toBe(1);
  });

  test("moving a done ticket to another done state still ends in a seal at the window end", async () => {
    const t = setup();
    await t.run((ctx) => reports.sync(ctx));
    const { id } = await resolvedReport(t);
    await drain(t, DAY);
    await t.run((ctx) => reports.move(ctx, { queue: "reports", ticketId: id, actor: LEAD, to: "dismissed" }));
    expect(await ticketOf(t, id)).toMatchObject({ state: "dismissed", category: "done" });
    await drain(t, 8 * DAY);
    expect((await ticketOf(t, id)).closedAt).toBeDefined();
    expect(count(await typesOf(t, id), "closed")).toBe(1);
  });

  test("a queue with reopenWindowMs 0 seals at once on resolve and on cancel", async () => {
    const t = setup();
    await syncLab(t);
    const id = await t.run((ctx) => lab.open(ctx, { queue: "instant", actor: REQ, title: "now" }));
    const seq = await claim(t, id, A);
    await t.run((ctx) => lab.resolve(ctx, { ticketId: id, actor: A, claimSeq: seq, resolution: "completed" }));
    expect((await ticketOf(t, id)).closedAt).toBeDefined();
    expect(await typesOf(t, id)).toEqual(["opened", "claimed", "resolved", "closed"]);
    expect((await historyOf(t, id)).at(-1)).toMatchObject({ actorRef: SYSTEM_PARTY.ref });
    await expectCode(t.run((ctx) => lab.reopen(ctx, { ticketId: id, actor: REQ })), "SEALED");

    const canceled = await t.run((ctx) => lab.open(ctx, { queue: "instant", actor: REQ, title: "never" }));
    await t.run((ctx) => lab.cancel(ctx, { ticketId: canceled, actor: REQ }));
    expect((await ticketOf(t, canceled)).closedAt).toBeDefined();
    expect(await typesOf(t, canceled)).toEqual(["opened", "canceled", "closed"]);
  });

  test("a queue with reopenWindowMs null never seals and its done tickets stay reopenable", async () => {
    const t = setup();
    await syncLab(t);
    const id = await t.run((ctx) => lab.open(ctx, { queue: "proj", actor: REQ, title: "Ship it" }));
    const seq = await claim(t, id, A);
    await t.run((ctx) => lab.resolve(ctx, { ticketId: id, actor: A, claimSeq: seq, resolution: "completed" }));
    await drain(t, 365 * DAY);
    expect((await ticketOf(t, id)).closedAt).toBeUndefined();
    expect(await typesOf(t, id)).not.toContain("closed");
    await t.run((ctx) => lab.reopen(ctx, { ticketId: id, actor: REQ }));
    expect(await ticketOf(t, id)).toMatchObject({ category: "unstarted" });
  });

  test("close seals a done or canceled ticket now as a host move and the old timer adds no second close", async () => {
    const t = setup();
    await syncLab(t);
    const done = await resolvedAgent(t);
    const canceled = await openAgent(t);
    await t.run((ctx) => lab.cancel(ctx, { ticketId: canceled, actor: REQ }));
    for (const id of [done.id, canceled]) {
      const result = await t.run((ctx) => lab.close(ctx, { ticketId: id, actor: LEAD }));
      expect(result.category).toBe((await ticketOf(t, id)).category);
      expect((await ticketOf(t, id)).closedAt).toBeDefined();
      expect((await historyOf(t, id)).at(-1)).toMatchObject({ type: "closed", actorRef: LEAD.ref });
    }
    await drain(t, 8 * DAY);
    expect(count(await typesOf(t, done.id), "closed")).toBe(1);
    expect(count(await typesOf(t, canceled), "closed")).toBe(1);
  });

  test("close is refused with INVALID_MOVE on an unstarted, started or waiting ticket and with SEALED on a sealed one", async () => {
    const t = setup();
    await syncLab(t);
    const unstarted = await openAgent(t);
    const started = await startedAgent(t);
    const waiting = await waitingAgent(t);
    for (const id of [unstarted, started.id, waiting.id]) {
      await expectCode(t.run((ctx) => lab.close(ctx, { ticketId: id, actor: LEAD })), "INVALID_MOVE");
    }
    expect(await ticketOf(t, started.id)).toMatchObject({ category: "started" });
    const done = await resolvedAgent(t);
    await t.run((ctx) => lab.close(ctx, { ticketId: done.id, actor: LEAD }));
    await expectCode(t.run((ctx) => lab.close(ctx, { ticketId: done.id, actor: LEAD })), "SEALED");
  });

  test("every write on a sealed ticket gets SEALED", async () => {
    const t = setup();
    await syncLab(t);
    const id = await t.run((ctx) => lab.open(ctx, { queue: "instant", actor: REQ, title: "sealed" }));
    const seq = await claim(t, id, A);
    await t.run((ctx) => lab.resolve(ctx, { ticketId: id, actor: A, claimSeq: seq, resolution: "completed" }));
    const before = await detailOf(t, id);
    expect(before.ticket.closedAt).toBeDefined();

    const attempts: Record<string, () => Promise<unknown>> = {
      renew: () => t.run((ctx) => lab.renew(ctx, { ticketId: id, actor: A, claimSeq: seq })),
      release: () => t.run((ctx) => lab.release(ctx, { ticketId: id, actor: A, claimSeq: seq })),
      assign: () => t.run((ctx) => lab.assign(ctx, { ticketId: id, actor: LEAD, assignee: B })),
      move: () => t.run((ctx) => lab.move(ctx, { ticketId: id, actor: LEAD, trusted: true, to: "resolved" })),
      requestInput: () => t.run((ctx) => lab.requestInput(ctx, { ticketId: id, actor: A, claimSeq: seq, body: "more?" })),
      reply: () => t.run((ctx) => lab.reply(ctx, { ticketId: id, actor: REQ, body: "hello" })),
      hold: () => t.run((ctx) => lab.hold(ctx, { ticketId: id, actor: A, claimSeq: seq, waitingOn: "external" })),
      resume: () => t.run((ctx) => lab.resume(ctx, { ticketId: id, actor: A, claimSeq: seq })),
      handoff: () => t.run((ctx) => lab.handoff(ctx, { ticketId: id, actor: A, claimSeq: seq, toParty: B })),
      resolve: () => t.run((ctx) => lab.resolve(ctx, { ticketId: id, actor: A, claimSeq: seq, resolution: "failed" })),
      reopen: () => t.run((ctx) => lab.reopen(ctx, { ticketId: id, actor: REQ })),
      close: () => t.run((ctx) => lab.close(ctx, { ticketId: id, actor: LEAD })),
      cancel: () => t.run((ctx) => lab.cancel(ctx, { ticketId: id, actor: REQ })),
      escalate: () => t.run((ctx) => lab.escalate(ctx, { ticketId: id, actor: LEAD, trusted: true, reason: "late" })),
      link: () => t.run((ctx) => lab.link(ctx, { ticketId: id, actor: A, relation: "ref", refKind: "label", ref: "vip" })),
    };
    const outcomes: Record<string, string> = {};
    for (const [name, attempt] of Object.entries(attempts)) outcomes[name] = await outcomeOf(attempt());
    expect(outcomes).toEqual(Object.fromEntries(Object.keys(attempts).map((name) => [name, "SEALED"])));
    expect(await outcomeOf(t.run((ctx) => lab.claim(ctx, { ticketId: id, actor: B })))).not.toBe("ok");
    expect(await detailOf(t, id)).toEqual(before);
  });
});

const CUSTOM_STATES = {
  triage: { category: "backlog" },
  todo: { category: "unstarted" },
  ready: { category: "unstarted" },
  doing: { category: "started" },
  review: { category: "started" },
  need_info: { category: "waiting", on: "requester" },
  need_more: { category: "waiting", on: "requester" },
  parked: { category: "waiting", on: "external" },
  on_hold: { category: "waiting", on: "external" },
  shipped: { category: "done" },
  merged: { category: "done" },
  dropped: { category: "canceled" },
  duplicate: { category: "canceled" },
} as const satisfies StatesSpec;

const MATRIX_POLICY = { escalateTo: "esc", maxOpenPerRequester: 1000 } as const;

const matrix = new Tickets(components.tickets, {
  queues: {
    leaseDefault: defineQueue({ policy: { ...MATRIX_POLICY, leaseMs: 5 * MINUTE } }),
    noLeaseDefault: defineQueue({ policy: { ...MATRIX_POLICY, leaseMs: null } }),
    leaseCustom: defineQueue({ states: CUSTOM_STATES, policy: { ...MATRIX_POLICY, leaseMs: 5 * MINUTE } }),
    noLeaseCustom: defineQueue({ states: CUSTOM_STATES, policy: { ...MATRIX_POLICY, leaseMs: null } }),
    esc: defineQueue({ policy: { leaseMs: null } }),
  },
  limits: { opensPerMinute: 100_000, messagesPerMinute: 100_000 },
  onEvent: internal.hooks.recordOnly,
});

interface Layout {
  queue: string;
  lease: boolean;
  custom: boolean;
}

const LAYOUTS: readonly Layout[] = [
  { queue: "leaseDefault", lease: true, custom: false },
  { queue: "noLeaseDefault", lease: false, custom: false },
  { queue: "leaseCustom", lease: true, custom: true },
  { queue: "noLeaseCustom", lease: false, custom: true },
];

const SITUATIONS = ["backlog", "unstarted", "started", "waitingRequester", "waitingExternal", "done", "canceled"] as const;
type Situation = (typeof SITUATIONS)[number];

const MOVES = [
  "claim",
  "renew",
  "release",
  "assign",
  "move",
  "moveIntake",
  "moveAway",
  "requestInput",
  "reply",
  "hold",
  "resume",
  "handoff",
  "resolve",
  "reopen",
  "close",
  "cancel",
  "escalate",
] as const;
type MoveName = (typeof MOVES)[number];

interface Subject {
  id: string;
  seq: number;
  transitions: number;
  situation: Situation;
  layout: Layout;
}

const CATEGORY_OF: Record<Situation, Category> = {
  backlog: "backlog",
  unstarted: "unstarted",
  started: "started",
  waitingRequester: "waiting",
  waitingExternal: "waiting",
  done: "done",
  canceled: "canceled",
};

const HOLDER_OF: Record<Situation, string> = {
  backlog: "-",
  unstarted: "-",
  started: A.ref,
  waitingRequester: A.ref,
  waitingExternal: A.ref,
  done: A.ref,
  canceled: "-",
};

function row(b: string, u: string, s: string, wr: string, we: string, d: string, c: string): Record<Situation, string> {
  return { backlog: b, unstarted: u, started: s, waitingRequester: wr, waitingExternal: we, done: d, canceled: c };
}

const OK = "ok";
const IM = "INVALID_MOVE";
const NH = "NOT_HOLDER";
const NC = "NOT_CLAIMABLE";
const TK = "TAKEN";

/** The spec's moves table, one row per move, one column per starting category. */
const EXPECTED: Record<MoveName, Record<Situation, string>> = {
  claim: row(NC, OK, TK, TK, TK, NC, NC),
  renew: row(IM, IM, OK, IM, IM, IM, IM),
  release: row(IM, IM, OK, IM, IM, IM, IM),
  assign: row(OK, OK, OK, OK, OK, IM, IM),
  move: row(OK, OK, OK, OK, OK, OK, OK),
  moveIntake: row(OK, OK, IM, IM, IM, IM, IM),
  moveAway: row(IM, IM, IM, IM, IM, IM, IM),
  requestInput: row(IM, IM, OK, IM, IM, IM, IM),
  reply: row(OK, OK, OK, OK, OK, OK, OK),
  hold: row(IM, IM, OK, IM, IM, IM, IM),
  resume: row(IM, IM, IM, OK, OK, IM, IM),
  handoff: row(IM, IM, OK, IM, IM, IM, IM),
  resolve: row(IM, IM, OK, IM, IM, IM, IM),
  reopen: row(IM, IM, IM, IM, IM, OK, OK),
  close: row(IM, IM, IM, IM, IM, OK, OK),
  cancel: row(OK, OK, OK, OK, OK, IM, IM),
  escalate: row(OK, OK, OK, OK, OK, IM, IM),
};

const CUSTOM_SAME: Partial<Record<Situation, string>> = {
  unstarted: "ready",
  started: "review",
  waitingRequester: "need_more",
  waitingExternal: "on_hold",
  done: "merged",
  canceled: "duplicate",
};
const CUSTOM_INTAKE: Partial<Record<Situation, string>> = { backlog: "todo", unstarted: "triage" };
const CUSTOM_AWAY: Record<Situation, string> = {
  backlog: "doing",
  unstarted: "doing",
  started: "shipped",
  waitingRequester: "doing",
  waitingExternal: "doing",
  done: "todo",
  canceled: "todo",
};
const DEFAULT_AWAY: Partial<Record<Situation, string>> = {
  unstarted: "working",
  started: "resolved",
  waitingRequester: "working",
  waitingExternal: "working",
  done: "open",
  canceled: "open",
};

type TargetKind = "same" | "intake" | "away";

function targetOf(kind: TargetKind, s: Subject): string | undefined {
  if (kind === "away") return s.layout.custom ? CUSTOM_AWAY[s.situation] : DEFAULT_AWAY[s.situation];
  if (!s.layout.custom) return undefined;
  return kind === "same" ? CUSTOM_SAME[s.situation] : CUSTOM_INTAKE[s.situation];
}

const TARGET_OF_MOVE: Partial<Record<MoveName, TargetKind>> = { move: "same", moveIntake: "intake", moveAway: "away" };

function applicable(move: MoveName, s: Subject): boolean {
  const kind = TARGET_OF_MOVE[move];
  return kind === undefined || targetOf(kind, s) !== undefined;
}

function isHeld(s: Subject): boolean {
  return s.situation === "started" || s.situation === "waitingRequester" || s.situation === "waitingExternal";
}

type Runner = (ctx: RunMutationCtx, s: Subject) => Promise<unknown>;

const RUN: Record<MoveName, Runner> = {
  claim: (ctx, s) => ctx.runMutation(api.claim, { ticketId: s.id, actor: C }),
  renew: (ctx, s) => ctx.runMutation(api.renew, { ticketId: s.id, actor: A, claimSeq: s.seq }),
  release: (ctx, s) => ctx.runMutation(api.release, { ticketId: s.id, actor: A, claimSeq: s.seq }),
  assign: (ctx, s) => ctx.runMutation(api.assign, { ticketId: s.id, actor: LEAD, assignee: B }),
  move: (ctx, s) => ctx.runMutation(api.move, { ticketId: s.id, actor: A, claimSeq: s.seq, to: targetOf("same", s) ?? "" }),
  moveIntake: (ctx, s) => ctx.runMutation(api.move, { ticketId: s.id, actor: A, claimSeq: s.seq, to: targetOf("intake", s) ?? "" }),
  moveAway: (ctx, s) => ctx.runMutation(api.move, { ticketId: s.id, actor: A, claimSeq: s.seq, to: targetOf("away", s) ?? "" }),
  requestInput: (ctx, s) => ctx.runMutation(api.requestInput, { ticketId: s.id, actor: A, claimSeq: s.seq, body: "Which one?" }),
  reply: (ctx, s) => ctx.runMutation(api.reply, { ticketId: s.id, actor: REQ, body: "hello" }),
  hold: (ctx, s) => ctx.runMutation(api.hold, { ticketId: s.id, actor: A, claimSeq: s.seq, waitingOn: "external" }),
  resume: (ctx, s) => ctx.runMutation(api.resume, { ticketId: s.id, actor: A, claimSeq: s.seq }),
  handoff: (ctx, s) => ctx.runMutation(api.handoff, { ticketId: s.id, actor: A, claimSeq: s.seq, toParty: C }),
  resolve: (ctx, s) => ctx.runMutation(api.resolve, { ticketId: s.id, actor: A, claimSeq: s.seq, resolution: "completed" }),
  reopen: (ctx, s) => ctx.runMutation(api.reopen, { ticketId: s.id, actor: REQ }),
  close: (ctx, s) => ctx.runMutation(api.close, { ticketId: s.id, actor: LEAD }),
  cancel: (ctx, s) => ctx.runMutation(api.cancel, { ticketId: s.id, actor: REQ }),
  escalate: (ctx, s) =>
    isHeld(s)
      ? ctx.runMutation(api.escalate, { ticketId: s.id, actor: A, claimSeq: s.seq, reason: "stuck" })
      : ctx.runMutation(api.escalate, { ticketId: s.id, actor: LEAD, trusted: true, reason: "stuck" }),
};

interface Shape {
  category: Category;
  queue: string;
  holder: string;
  seqDelta: number;
  last: string;
  lease: boolean;
  state?: string;
}

/** What the ticket must look like after a move that the table allows. */
function expectedAfter(move: MoveName, s: Subject): Shape {
  const category = CATEGORY_OF[s.situation];
  const queue = s.layout.queue;
  const keep = { category, queue, holder: HOLDER_OF[s.situation], seqDelta: 0 };
  const leaseIfStarted = category === "started" && s.layout.lease;
  const target = TARGET_OF_MOVE[move];
  const state = target === undefined ? undefined : targetOf(target, s);
  switch (move) {
    case "claim":
      return { category: "started", queue, holder: C.ref, seqDelta: 1, last: "claimed", lease: s.layout.lease };
    case "renew":
      return { ...keep, last: "none", lease: s.layout.lease };
    case "release":
      return { category: "unstarted", queue, holder: "-", seqDelta: 1, last: "released", lease: false };
    case "assign":
      return { ...keep, holder: B.ref, seqDelta: 1, last: "assigned", lease: leaseIfStarted };
    case "move":
    case "moveAway":
      return { ...keep, last: "moved", lease: leaseIfStarted, state };
    case "moveIntake":
      return { ...keep, category: category === "backlog" ? "unstarted" : "backlog", last: "moved", lease: false, state };
    case "requestInput":
      return { ...keep, category: "waiting", last: "input_requested", lease: false };
    case "reply":
      return s.situation === "waitingRequester"
        ? { ...keep, category: "started", last: "input_provided", lease: s.layout.lease }
        : { ...keep, last: "none", lease: leaseIfStarted };
    case "hold":
      return { ...keep, category: "waiting", last: "held", lease: false };
    case "resume":
      return { ...keep, category: "started", last: "resumed", lease: s.layout.lease };
    case "handoff":
      return { ...keep, holder: C.ref, seqDelta: 1, last: "handed_off", lease: s.layout.lease };
    case "resolve":
      return { ...keep, category: "done", last: "resolved", lease: false };
    case "reopen":
      return { category: "unstarted", queue, holder: "-", seqDelta: 1, last: "reopened", lease: false };
    case "close":
      return { ...keep, last: "closed", lease: false };
    case "cancel":
      return { ...keep, category: "canceled", last: "canceled", lease: false };
    case "escalate":
      return { category: "unstarted", queue: "esc", holder: "-", seqDelta: 1, last: "escalated", lease: false };
  }
}

async function build(t: T, layout: Layout, situation: Situation): Promise<Subject> {
  const { queue } = layout;
  const id =
    situation === "backlog"
      ? await t.run((ctx) => ctx.runMutation(api.open, { queue, actor: REQ, title: "matrix", to: "triage" }))
      : await t.run((ctx) => ctx.runMutation(api.open, { queue, actor: REQ, title: "matrix" }));
  if (situation === "canceled") await t.run((ctx) => ctx.runMutation(api.cancel, { ticketId: id, actor: REQ }));
  if (situation !== "backlog" && situation !== "unstarted" && situation !== "canceled") {
    const seq = claimedSeq(await t.run((ctx) => ctx.runMutation(api.claim, { ticketId: id, actor: A })));
    if (situation === "waitingRequester") {
      await t.run((ctx) => ctx.runMutation(api.requestInput, { ticketId: id, actor: A, claimSeq: seq, body: "Which one?" }));
    }
    if (situation === "waitingExternal") {
      await t.run((ctx) => ctx.runMutation(api.hold, { ticketId: id, actor: A, claimSeq: seq, waitingOn: "external" }));
    }
    if (situation === "done") {
      await t.run((ctx) => ctx.runMutation(api.resolve, { ticketId: id, actor: A, claimSeq: seq, resolution: "completed" }));
    }
  }
  const ticket = await ticketOf(t, id);
  return { id, seq: ticket.claimSeq, transitions: (await typesOf(t, id)).length, situation, layout };
}

async function observe(t: T, s: Subject): Promise<Shape> {
  const detail = await detailOf(t, s.id);
  const types = await typesOf(t, s.id);
  return {
    category: detail.ticket.category,
    queue: detail.ticket.queue,
    holder: detail.ticket.assigneeRef ?? "-",
    seqDelta: detail.ticket.claimSeq - s.seq,
    last: types.length > s.transitions ? (types.at(-1) ?? "none") : "none",
    lease: detail.leaseExpiresAt !== undefined,
    state: detail.ticket.state,
  };
}

describe("every move from every category", () => {
  test.each(LAYOUTS)(
    "the moves table holds for queue $queue (lease $lease, custom states $custom)",
    async (layout) => {
      const t = setup();
      await t.run((ctx) => matrix.sync(ctx));
      const problems: string[] = [];
      const situations = SITUATIONS.filter((situation) => layout.custom || situation !== "backlog");
      for (const situation of situations) {
        const shared = await build(t, layout, situation);
        const before = await detailOf(t, shared.id);
        for (const move of MOVES) {
          const label = `${layout.queue} ${situation} ${move}`;
          const wanted = EXPECTED[move][situation];
          if (!applicable(move, shared)) continue;
          if (wanted === OK) {
            const fresh = await build(t, layout, situation);
            const got = await outcomeOf(t.run((ctx) => RUN[move](ctx, fresh)));
            if (got !== OK) {
              problems.push(`${label}: expected ok, got ${got}`);
              continue;
            }
            const expected = expectedAfter(move, fresh);
            const actual = await observe(t, fresh);
            const comparable = { ...actual, state: expected.state === undefined ? undefined : actual.state };
            if (JSON.stringify(comparable) !== JSON.stringify(expected)) {
              problems.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(comparable)}`);
            }
            continue;
          }
          const got = await outcomeOf(t.run((ctx) => RUN[move](ctx, shared)));
          if (got !== wanted) problems.push(`${label}: expected ${wanted}, got ${got}`);
          if (JSON.stringify(await detailOf(t, shared.id)) !== JSON.stringify(before)) {
            problems.push(`${label}: a refused move changed the ticket`);
          }
        }
      }
      expect(problems).toEqual([]);
    },
    60_000,
  );
});

describe("the project example, end to end", () => {
  test("a lead and a coder take an export through the project queue and a human then holds the unblocked review for two days", async () => {
    const t = setup();
    await syncLab(t);
    const exportId = await t.run((ctx) =>
      lab.open(ctx, { queue: "proj", actor: LEAD, title: "Add CSV export", to: "backlog", fields: { estimate: 3 } }),
    );
    const reviewId = await t.run((ctx) => lab.open(ctx, { queue: "proj", actor: LEAD, title: "Review CSV export", blockedBy: [exportId] }));
    expect(await ticketOf(t, exportId)).toMatchObject({ state: "backlog", category: "backlog", fields: { estimate: 3 } });
    expect(await ticketOf(t, reviewId)).toMatchObject({ state: "todo", category: "unstarted", openBlockers: 1 });
    expect(await t.run((ctx) => lab.claim(ctx, { queue: "proj", actor: HUMAN }))).toEqual({ ok: false, reason: "EMPTY" });
    expect(await t.run((ctx) => lab.claim(ctx, { ticketId: reviewId, actor: HUMAN }))).toMatchObject({ ok: false, reason: "BLOCKED" });

    await t.run((ctx) => lab.move(ctx, { queue: "proj", ticketId: exportId, actor: LEAD, to: "todo" }));
    await t.run((ctx) => lab.assign(ctx, { ticketId: exportId, actor: LEAD, assignee: CODER }));
    expect(await t.run((ctx) => lab.claim(ctx, { ticketId: exportId, actor: HUMAN }))).toMatchObject({ ok: false, reason: "RESERVED" });

    const claimed = await t.run((ctx) => lab.claim(ctx, { ticketId: exportId, actor: CODER }));
    const seq = claimedSeq(claimed);
    expect(await ticketOf(t, exportId)).toMatchObject({ state: "in_progress", category: "started", assigneeRef: CODER.ref });
    expect((await detailOf(t, exportId)).leaseExpiresAt).toBeUndefined();

    await t.run((ctx) => lab.move(ctx, { queue: "proj", ticketId: exportId, actor: CODER, claimSeq: seq, to: "in_review" }));
    expect(await ticketOf(t, exportId)).toMatchObject({ state: "in_review", category: "started" });
    await t.run((ctx) => lab.resolve(ctx, { ticketId: exportId, actor: CODER, claimSeq: seq, resolution: "completed" }));
    expect(await ticketOf(t, exportId)).toMatchObject({ state: "done", category: "done", resolution: "completed" });

    expect(await ticketOf(t, reviewId)).toMatchObject({ category: "unstarted", openBlockers: 0 });
    await drain(t);
    expect(await eventTypes(t, reviewId)).toEqual(["opened", "unblocked"]);
    expect(await eventTypes(t, exportId)).toEqual(["opened", "moved", "assigned", "claimed", "moved", "resolved"]);
    expect(await typesOf(t, exportId)).toEqual(["opened", "moved", "assigned", "claimed", "moved", "resolved"]);

    const reviewSeq = claimedSeq(await t.run((ctx) => lab.claim(ctx, { ticketId: reviewId, actor: HUMAN })));
    expect(await ticketOf(t, reviewId)).toMatchObject({ state: "in_progress", category: "started", assigneeRef: HUMAN.ref });
    await drain(t, 2 * DAY);
    const held = await detailOf(t, reviewId);
    expect(held.leaseExpiresAt).toBeUndefined();
    expect(held.ticket).toMatchObject({ category: "started", assigneeRef: HUMAN.ref, claimSeq: reviewSeq });
    expect(await typesOf(t, reviewId)).not.toContain("lease_expired");
    await t.run((ctx) => lab.move(ctx, { queue: "proj", ticketId: reviewId, actor: HUMAN, claimSeq: reviewSeq, to: "in_review" }));
    expect(await ticketOf(t, reviewId)).toMatchObject({ state: "in_review", category: "started" });
  });
});

const keeper = new Tickets(components.strictTickets, {
  queues: { forever: defineQueue({ policy: { reopenWindowMs: null } }) },
  retentionMs: 30 * DAY,
});

type MountName = "tickets" | "strictTickets";

function purgeRef(mount: MountName) {
  const ref = componentsGeneric()[mount]?.internal_mutations?.purge;
  if (!ref) throw new Error(`the ${mount} mount has no purge function`);
  return ref;
}

async function strictDetail(t: T, ticketId: string): Promise<TicketDetail | null> {
  return await t.run((ctx) => strictTickets.get(ctx, { ticketId, view: "internal" }));
}

async function strictHistory(t: T, ticketId: string): Promise<number> {
  const result = await t.run((ctx) => strictTickets.listTransitions(ctx, { ticketId, paginationOpts: { cursor: null, numItems: 200 } }));
  return result.page.length;
}

async function strictMessages(t: T, ticketId: string): Promise<number> {
  const result = await t.run((ctx) =>
    strictTickets.listMessages(ctx, { ticketId, view: "internal", paginationOpts: { cursor: null, numItems: 200 } }),
  );
  return result.page.length;
}

async function strictResolved(t: T, actor: Party, title: string): Promise<{ id: string; seq: number }> {
  const id = await t.run((ctx) => strictTickets.open(ctx, { queue: "jobs", actor, title }));
  const seq = claimedSeq(await t.run((ctx) => strictTickets.claim(ctx, { ticketId: id, actor: A })));
  await t.run((ctx) => strictTickets.resolve(ctx, { queue: "jobs", ticketId: id, actor: A, claimSeq: seq, resolution: "completed" }));
  return { id, seq };
}

describe("retention", () => {
  test("the purge deletes a sealed ticket older than retention with its history and keeps newer and unsealed tickets", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = setup();
    await t.run((ctx) => strictTickets.sync(ctx));
    const old = await t.run((ctx) => strictTickets.open(ctx, { queue: "jobs", actor: REQ, title: "old", body: "first" }));
    const seq = claimedSeq(await t.run((ctx) => strictTickets.claim(ctx, { ticketId: old, actor: A })));
    await t.run((ctx) => strictTickets.reply(ctx, { ticketId: old, actor: REQ, body: "ping" }));
    await t.run((ctx) => strictTickets.link(ctx, { ticketId: old, actor: A, relation: "ref", refKind: "label", ref: "vip" }));
    await t.run((ctx) =>
      strictTickets.resolve(ctx, { queue: "jobs", ticketId: old, actor: A, claimSeq: seq, resolution: "completed", body: "done" }),
    );
    await t.run((ctx) => strictTickets.close(ctx, { ticketId: old, actor: LEAD }));
    expect(await strictHistory(t, old)).toBeGreaterThan(0);
    expect(await strictMessages(t, old)).toBe(3);

    await drain(t, 20 * DAY);
    const fresh = await strictResolved(t, LEAD, "fresh");
    await t.run((ctx) => strictTickets.close(ctx, { ticketId: fresh.id, actor: LEAD }));
    const pending = await t.run((ctx) => strictTickets.open(ctx, { queue: "jobs", actor: LEAD, title: "pending" }));

    await drain(t, 9 * DAY);
    expect(await t.mutation(purgeRef("strictTickets"), {})).toEqual({ deleted: 0, more: false });
    expect(await strictDetail(t, old)).not.toBeNull();

    await drain(t, 2 * DAY);
    const first = await t.mutation(purgeRef("strictTickets"), {});
    expect(first.more).toBe(true);
    expect(first.deleted).toBeGreaterThan(0);
    await drain(t);

    expect(await strictDetail(t, old)).toBeNull();
    expect(await strictHistory(t, old)).toBe(0);
    expect(await strictMessages(t, old)).toBe(0);
    const labels = await t.run((ctx) => strictTickets.listByRef(ctx, { refKind: "label", ref: "vip", paginationOpts: { cursor: null, numItems: 10 } }));
    expect(labels.page).toHaveLength(0);

    expect((await strictDetail(t, fresh.id))?.ticket.closedAt).toBeDefined();
    expect(await strictHistory(t, fresh.id)).toBeGreaterThan(0);
    expect((await strictDetail(t, pending))?.ticket).toMatchObject({ category: "unstarted" });
    expect(await t.mutation(purgeRef("strictTickets"), {})).toEqual({ deleted: 0, more: false });
  });

  test("retention counts from the seal: a ticket sealed by its timer is purged retentionMs after the seal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = setup();
    await t.run((ctx) => strictTickets.sync(ctx));
    const { id } = await strictResolved(t, REQ, "timer sealed");
    await drain(t, 8 * DAY);
    expect((await strictDetail(t, id))?.ticket.closedAt).toBeDefined();

    await drain(t, 28 * DAY);
    expect(await t.mutation(purgeRef("strictTickets"), {})).toEqual({ deleted: 0, more: false });
    expect(await strictDetail(t, id)).not.toBeNull();

    await drain(t, 3 * DAY);
    await t.mutation(purgeRef("strictTickets"), {});
    await drain(t);
    expect(await strictDetail(t, id)).toBeNull();
  });

  test("a purge with a small batch takes several passes and removes the ticket only when its rows are gone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = setup();
    await t.run((ctx) => strictTickets.sync(ctx));
    const id = await t.run((ctx) => strictTickets.open(ctx, { queue: "jobs", actor: REQ, title: "busy", body: "one" }));
    const seq = claimedSeq(await t.run((ctx) => strictTickets.claim(ctx, { ticketId: id, actor: A })));
    await t.run((ctx) => strictTickets.reply(ctx, { ticketId: id, actor: REQ, body: "two" }));
    await t.run((ctx) => strictTickets.resolve(ctx, { queue: "jobs", ticketId: id, actor: A, claimSeq: seq, resolution: "completed" }));
    await t.run((ctx) => strictTickets.close(ctx, { ticketId: id, actor: LEAD }));
    await drain(t, 31 * DAY);

    const first = await t.mutation(purgeRef("strictTickets"), { batch: 2 });
    expect(first.more).toBe(true);
    expect(await strictDetail(t, id)).not.toBeNull();
    expect(await strictMessages(t, id)).toBe(0);
    expect(await strictHistory(t, id)).toBe(2);

    await drain(t);
    expect(await strictDetail(t, id)).toBeNull();
    expect(await strictHistory(t, id)).toBe(0);
  });

  test("with retention off the purge deletes nothing, however old the sealed ticket is", async () => {
    const t = setup();
    await syncLab(t);
    const { id } = await resolvedAgent(t);
    await t.run((ctx) => lab.close(ctx, { ticketId: id, actor: LEAD }));
    await drain(t, 400 * DAY);
    expect(await t.mutation(purgeRef("tickets"), {})).toEqual({ deleted: 0, more: false });
    expect((await ticketOf(t, id)).closedAt).toBeDefined();
    expect(await typesOf(t, id)).toContain("resolved");
  });

  test("a ticket in a queue that never seals is never purged", async () => {
    const t = setup();
    await t.run((ctx) => keeper.sync(ctx));
    const id = await t.run((ctx) => keeper.open(ctx, { queue: "forever", actor: REQ, title: "keep" }));
    const seq = claimedSeq(await t.run((ctx) => keeper.claim(ctx, { ticketId: id, actor: A })));
    await t.run((ctx) => keeper.resolve(ctx, { queue: "forever", ticketId: id, actor: A, claimSeq: seq, resolution: "completed" }));
    await drain(t, 100 * DAY);
    expect(await t.mutation(purgeRef("strictTickets"), {})).toEqual({ deleted: 0, more: false });
    const detail = await t.run((ctx) => keeper.get(ctx, { ticketId: id }));
    expect(detail?.ticket).toMatchObject({ category: "done" });
    expect(detail?.ticket.closedAt).toBeUndefined();
  });

  test("the component registers a daily purge cron on its internal purge function", () => {
    expect(PURGE_INTERVAL).toEqual({ hours: 24 });
    expect(crons.crons["tickets:purge"]).toMatchObject({
      name: "internal_mutations:purge",
      args: [{}],
      schedule: { type: "interval", hours: 24 },
    });
    expect(Object.keys(crons.crons)).toEqual(["tickets:purge"]);
  });
});
