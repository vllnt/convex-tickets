/// <reference types="vite/client" />
import { makeFunctionReference } from "convex/server";
import type { ObjectType } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Tickets, defineQueue, ticketEvent, toQueueDef, toValues } from "../../src/client/index.js";
import type { ClaimResult, Party, Visibility } from "../../src/client/index.js";
import { agentQueue, deskQueue, projectQueue } from "../../src/client/presets.js";
import { TOOL_NAMES, ticketTools } from "../../src/client/tools.js";
import { components } from "./_generated/api.js";
import { A, B, C, DAY, HUMAN, LEAD, MINUTE, REQ, drain, events, expectCode, lab, setup, syncLab } from "./harness.helper.js";
import type { T } from "./harness.helper.js";
import { strictTickets } from "./tickets.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function present<V>(value: V | null | undefined): V {
  if (value === null || value === undefined) throw new Error("expected a value, got none");
  return value;
}

function claimSeqOf(result: ClaimResult): number {
  if (!result.ok) throw new Error(`claim was refused: ${result.reason}`);
  return result.claimSeq;
}

async function transitionsOf(t: T, client: Pick<typeof lab, "listTransitions">, ticketId: string) {
  const page = await t.run((ctx) => client.listTransitions(ctx, { ticketId, paginationOpts: { cursor: null, numItems: 100 } }));
  return page.page;
}

async function eventsFor(t: T, ticketId: string) {
  return (await events(t)).filter((row) => row.ticketId === ticketId);
}

function toolsFor(party: Party, view?: Visibility) {
  return ticketTools(lab, { party, view });
}

const hookRef = makeFunctionReference<"mutation", ObjectType<typeof ticketEvent>>("hooks:recordOnly");
const hookRefWithBody = makeFunctionReference<"mutation", ObjectType<typeof ticketEvent> & { body: string }>(
  "hooks:recordOnly",
);

describe("the host hook", () => {
  test("the hook receives exactly one event per transition, in seq order, with the spec's fields", async () => {
    const t = setup();
    await syncLab(t);
    const ticketId = await t.run((ctx) =>
      lab.open(ctx, { queue: "agent", actor: REQ, title: "refund", fields: { amount: 49, currency: "EUR" } }),
    );
    await drain(t);
    const claimSeq = claimSeqOf(await t.run((ctx) => lab.claim(ctx, { ticketId, actor: A })));
    await drain(t);
    await t.run((ctx) =>
      lab.requestInput(ctx, { queue: "agent", ticketId, actor: A, claimSeq, body: "which note?", fields: ["note"] }),
    );
    await drain(t);
    await t.run((ctx) =>
      lab.reply(ctx, { queue: "agent", ticketId, actor: REQ, body: "this one", fields: { note: "n-1" } }),
    );
    await drain(t);
    await t.run((ctx) =>
      lab.resolve(ctx, { queue: "agent", ticketId, actor: A, claimSeq, resolution: "completed", result: { ok: true } }),
    );
    await drain(t);

    const transitions = await transitionsOf(t, lab, ticketId);
    const delivered = await eventsFor(t, ticketId);
    expect(transitions.map((row) => row.type)).toEqual(["opened", "claimed", "input_requested", "input_provided", "resolved"]);
    expect(delivered.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(delivered.map((row) => row.seq)).toEqual(transitions.map((row) => row.seq));
    expect(delivered.map((row) => row.type)).toEqual(transitions.map((row) => row.type));
    expect(delivered.map((row) => row.at)).toEqual(transitions.map((row) => row.at));
    expect(
      delivered.map((row) => ({
        type: row.type,
        queue: row.queue,
        state: row.state,
        category: row.category,
        blocked: row.blocked,
        actorRef: row.actorRef,
        assigneeRef: row.assigneeRef,
      })),
    ).toEqual([
      { type: "opened", queue: "agent", state: "open", category: "unstarted", blocked: false, actorRef: REQ.ref, assigneeRef: undefined },
      { type: "claimed", queue: "agent", state: "working", category: "started", blocked: false, actorRef: A.ref, assigneeRef: A.ref },
      { type: "input_requested", queue: "agent", state: "waiting", category: "waiting", blocked: false, actorRef: A.ref, assigneeRef: A.ref },
      { type: "input_provided", queue: "agent", state: "working", category: "started", blocked: false, actorRef: REQ.ref, assigneeRef: A.ref },
      { type: "resolved", queue: "agent", state: "resolved", category: "done", blocked: false, actorRef: A.ref, assigneeRef: A.ref },
    ]);
    expect(delivered.every((row) => row.ticketId === ticketId)).toBe(true);
    expect(transitions.map((row) => [row.toState, row.toCategory, row.actorRef])).toEqual(
      delivered.map((row) => [row.state, row.category, row.actorRef]),
    );
  });

  test("two transitions made by one mutation arrive as two events in seq order", async () => {
    const t = setup();
    await syncLab(t);
    const ticketId = await t.run((ctx) => lab.open(ctx, { queue: "instant", actor: REQ, title: "sealed at once" }));
    await drain(t);
    const claimSeq = claimSeqOf(await t.run((ctx) => lab.claim(ctx, { ticketId, actor: A })));
    await drain(t);
    await t.run((ctx) => lab.resolve(ctx, { ticketId, actor: A, claimSeq, resolution: "completed" }));
    await drain(t);

    const transitions = await transitionsOf(t, lab, ticketId);
    const delivered = await eventsFor(t, ticketId);
    expect(transitions.map((row) => row.type)).toEqual(["opened", "claimed", "resolved", "closed"]);
    expect(delivered.map((row) => row.type)).toEqual(["opened", "claimed", "resolved", "closed"]);
    expect(delivered.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(delivered.at(-1)).toMatchObject({ category: "done", actorRef: "system:tickets" });
  });

  test("an event says blocked while a blocker is open and the ticket gets an unblocked event when it completes", async () => {
    const t = setup();
    await syncLab(t);
    const blockerId = await t.run((ctx) => lab.open(ctx, { queue: "people", actor: REQ, title: "export" }));
    const reviewId = await t.run((ctx) =>
      lab.open(ctx, { queue: "people", actor: REQ, title: "review", blockedBy: [blockerId] }),
    );
    await drain(t);
    expect((await eventsFor(t, reviewId)).map((row) => [row.type, row.blocked])).toEqual([["opened", true]]);

    const claimSeq = claimSeqOf(await t.run((ctx) => lab.claim(ctx, { ticketId: blockerId, actor: A })));
    await t.run((ctx) => lab.resolve(ctx, { ticketId: blockerId, actor: A, claimSeq, resolution: "completed" }));
    await drain(t);

    const review = await eventsFor(t, reviewId);
    expect(review.map((row) => [row.type, row.blocked, row.category])).toEqual([
      ["opened", true, "unstarted"],
      ["unblocked", false, "unstarted"],
    ]);
    expect(review.at(-1)?.actorRef).toBe("system:tickets");
    expect(review.at(-1)?.assigneeRef).toBeUndefined();
  });

  test("an event carries no message bodies or fields, and a hook refuses an event that has them", async () => {
    const keys = Object.keys(ticketEvent);
    for (const banned of ["body", "fields", "data", "title", "result", "message"]) {
      expect(keys, `ticketEvent must not have ${banned}`).not.toContain(banned);
    }
    expect(keys).toEqual(
      expect.arrayContaining(["ticketId", "type", "queue", "state", "category", "blocked", "actor", "seq", "assigneeRef"]),
    );

    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = setup();
    await syncLab(t);
    const ticketId = await t.run((ctx) =>
      lab.open(ctx, {
        queue: "agent",
        actor: REQ,
        title: "private title",
        body: "private body text",
        fields: { amount: 7, note: "private field value" },
      }),
    );
    await drain(t);
    expect((await eventsFor(t, ticketId)).map((row) => row.type)).toEqual(["opened"]);
    expect(errors).not.toHaveBeenCalled();

    const sample: ObjectType<typeof ticketEvent> = {
      ticketId: "sample",
      seq: 1,
      type: "opened",
      queue: "agent",
      state: "open",
      category: "unstarted",
      blocked: false,
      openBlockers: 0,
      priority: 2,
      requesterRef: REQ.ref,
      claimSeq: 0,
      actor: REQ,
      at: 1,
    };
    await t.run(async (ctx) => {
      await ctx.scheduler.runAfter(0, hookRef, sample);
      await ctx.scheduler.runAfter(0, hookRefWithBody, { ...sample, ticketId: "with body", body: "private body text" });
    });
    await drain(t);
    expect((await eventsFor(t, "sample")).length).toBe(1);
    expect((await eventsFor(t, "with body")).length).toBe(0);
    expect(errors.mock.calls.flat().map(String).join("\n")).toContain("Unexpected field `body`");
  });

  test("a hook that throws leaves the ticket move in place", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = setup();
    await t.run(async (ctx) => {
      await strictTickets.sync(ctx);
    });
    const ticketId = await t.run((ctx) => strictTickets.open(ctx, { queue: "jobs", actor: REQ, title: "job" }));
    await drain(t);
    const claimSeq = claimSeqOf(await t.run((ctx) => strictTickets.claim(ctx, { ticketId, actor: A })));
    await drain(t);

    const claimed = present(await t.run((ctx) => strictTickets.get(ctx, { ticketId })));
    expect(claimed.ticket).toMatchObject({ state: "working", category: "started", assigneeRef: A.ref, claimSeq });

    await t.run((ctx) => strictTickets.resolve(ctx, { ticketId, actor: A, claimSeq, resolution: "completed" }));
    await drain(t);
    const resolved = present(await t.run((ctx) => strictTickets.get(ctx, { ticketId })));
    expect(resolved.ticket).toMatchObject({ state: "resolved", category: "done", resolution: "completed" });
    expect((await transitionsOf(t, strictTickets, ticketId)).map((row) => row.type)).toEqual(["opened", "claimed", "resolved"]);

    const failures = errors.mock.calls.filter((args) => args.map(String).join(" ").includes("this hook fails on purpose"));
    expect(failures).toHaveLength(3);
    expect(await events(t)).toHaveLength(0);
  });

  test("a mount without onEvent moves tickets and records no events", async () => {
    const quiet = new Tickets(components.tickets, { queues: { work: defineQueue({}) } });
    const t = setup();
    await t.run(async (ctx) => {
      await quiet.sync(ctx);
    });
    const ticketId = await t.run((ctx) => quiet.open(ctx, { queue: "work", actor: REQ, title: "quiet" }));
    const claimSeq = claimSeqOf(await t.run((ctx) => quiet.claim(ctx, { ticketId, actor: A })));
    await t.run((ctx) => quiet.resolve(ctx, { ticketId, actor: A, claimSeq, resolution: "completed" }));
    await drain(t);

    const detail = present(await t.run((ctx) => quiet.get(ctx, { ticketId })));
    expect(detail.ticket).toMatchObject({ state: "resolved", category: "done" });
    expect((await transitionsOf(t, quiet, ticketId)).map((row) => row.type)).toEqual(["opened", "claimed", "resolved"]);
    expect(await events(t)).toHaveLength(0);
  });

  test("sync without onEvent clears the hook, and a later sync with it restores delivery", async () => {
    const quiet = new Tickets(components.tickets, { queues: lab.queues });
    const t = setup();
    await syncLab(t);
    const ticketId = await t.run((ctx) => lab.open(ctx, { queue: "people", actor: REQ, title: "watched" }));
    await drain(t);
    expect((await eventsFor(t, ticketId)).map((row) => row.type)).toEqual(["opened"]);

    const resync = await t.run((ctx) => quiet.sync(ctx));
    expect(resync.created).toEqual([]);
    expect(resync.updated).toEqual([]);
    const claimSeq = claimSeqOf(await t.run((ctx) => quiet.claim(ctx, { ticketId, actor: A })));
    await drain(t);
    const moved = present(await t.run((ctx) => quiet.get(ctx, { ticketId })));
    expect(moved.ticket.category).toBe("started");
    expect((await eventsFor(t, ticketId)).map((row) => row.type)).toEqual(["opened"]);

    await syncLab(t);
    await t.run((ctx) => lab.release(ctx, { ticketId, actor: A, claimSeq }));
    await drain(t);
    expect((await eventsFor(t, ticketId)).map((row) => row.type)).toEqual(["opened", "released"]);
  });

  test("two mounts are isolated: the same queue name holds different tickets and different definitions", async () => {
    const mine = new Tickets(components.tickets, { queues: { jobs: defineQueue({ policy: { leaseMs: null } }) } });
    const t = setup();
    await t.run(async (ctx) => {
      await mine.sync(ctx);
      await strictTickets.sync(ctx);
    });
    const mineId = await t.run((ctx) => mine.open(ctx, { queue: "jobs", actor: REQ, title: "mount one only" }));
    const theirId = await t.run((ctx) => strictTickets.open(ctx, { queue: "jobs", actor: REQ, title: "mount two first" }));
    const theirLastId = await t.run((ctx) => strictTickets.open(ctx, { queue: "jobs", actor: REQ, title: "mount two second" }));

    const filter = { by: "queue", queue: "jobs" } as const;
    const paginationOpts = { cursor: null, numItems: 10 };
    const mineList = await t.run((ctx) => mine.list(ctx, { filter, paginationOpts }));
    const theirList = await t.run((ctx) => strictTickets.list(ctx, { filter, paginationOpts }));
    expect(mineList.page.map((row) => row.title)).toEqual(["mount one only"]);
    expect(theirList.page.map((row) => row.title).sort()).toEqual(["mount two first", "mount two second"]);

    expect(await t.run((ctx) => mine.get(ctx, { ticketId: theirLastId }))).toBeNull();
    await expectCode(t.run((ctx) => mine.claim(ctx, { ticketId: theirLastId, actor: A })), "NOT_FOUND");
    expect(await t.run((ctx) => mine.search(ctx, { text: "second" }))).toEqual([]);
    expect(await t.run((ctx) => strictTickets.search(ctx, { text: "second" }))).toHaveLength(1);

    const mineQueue = present(await t.run((ctx) => mine.getQueue(ctx, { name: "jobs" })));
    const theirQueue = present(await t.run((ctx) => strictTickets.getQueue(ctx, { name: "jobs" })));
    expect(mineQueue.policy.leaseMs).toBeNull();
    expect(theirQueue.policy.leaseMs).toBe(5 * MINUTE);

    const mineClaim = await t.run((ctx) => mine.claim(ctx, { ticketId: mineId, actor: A }));
    const theirClaim = await t.run((ctx) => strictTickets.claim(ctx, { ticketId: theirId, actor: A }));
    expect(mineClaim.ok && mineClaim.leaseExpiresAt).toBeUndefined();
    expect(theirClaim.ok && theirClaim.leaseExpiresAt).toBeTypeOf("number");
  });
});

describe("the agent tools", () => {
  test("the tool set has exactly the eight names of TOOL_NAMES, each with a name, a description and args", () => {
    const tools = toolsFor(A);
    expect([...TOOL_NAMES]).toEqual(["open", "list", "get", "claim", "reply", "requestInput", "handoff", "resolve"]);
    expect(Object.keys(tools).sort()).toEqual([...TOOL_NAMES].sort());
    for (const [key, tool] of Object.entries(tools)) {
      expect(tool.name).toBe(key);
      expect(tool.description.length).toBeGreaterThan(30);
      expect(Object.keys(tool.args).length).toBeGreaterThan(0);
      expect(typeof tool.handler).toBe("function");
    }
  });

  test("the party and the view are bound: no tool takes an actor, a trusted flag or a view", () => {
    for (const tool of Object.values(toolsFor(A, "internal"))) {
      const names = Object.keys(tool.args);
      for (const banned of ["actor", "party", "actorRef", "partyRef", "trusted", "view", "requester", "assignee"]) {
        expect(names, `${tool.name} must not take ${banned}`).not.toContain(banned);
      }
    }
  });

  test("no host move exists in the tool set", () => {
    const names = Object.keys(toolsFor(LEAD, "internal"));
    for (const hostMove of ["assign", "close", "move", "hold", "release", "renew", "resume", "cancel", "reopen", "escalate", "link", "unlink"]) {
      expect(names, `${hostMove} is not a default tool`).not.toContain(hostMove);
    }
  });

  test("a smuggled actor argument cannot change who a tool acts as", async () => {
    const t = setup();
    await syncLab(t);
    const tools = toolsFor(REQ);
    const smuggledOpen = { queue: "people", title: "mine", actor: B };
    const ticketId = await t.run((ctx) => tools.open.handler(ctx, smuggledOpen));
    const smuggledReply = { ticketId, body: "from me", actor: B };
    await t.run((ctx) => tools.reply.handler(ctx, smuggledReply));

    const detail = present(await t.run((ctx) => tools.get.handler(ctx, { ticketId })));
    expect(detail.ticket.requesterRef).toBe(REQ.ref);
    expect(detail.messages.map((message) => message.authorRef)).toEqual([REQ.ref]);
    expect((await transitionsOf(t, lab, ticketId)).map((row) => row.actorRef)).toEqual([REQ.ref]);
  });

  test("a ticket moves through open, claim, reply, handoff and resolve by tools only, each write recorded as the bound party", async () => {
    const t = setup();
    await syncLab(t);
    const requester = toolsFor(REQ);
    const worker = toolsFor(A, "internal");
    const finisher = toolsFor(B, "internal");

    const ticketId = await t.run((ctx) => requester.open.handler(ctx, { queue: "agent", title: "refund", fields: { amount: 49 } }));
    const claimSeq = claimSeqOf(await t.run((ctx) => worker.claim.handler(ctx, { ticketId })));
    await t.run((ctx) => worker.reply.handler(ctx, { ticketId, body: "card is expired", visibility: "internal" }));
    await t.run((ctx) => worker.requestInput.handler(ctx, { ticketId, claimSeq, body: "which order?", fields: ["note"] }));
    const answer = await t.run((ctx) =>
      requester.reply.handler(ctx, { ticketId, body: "order A-1042", fields: { note: "A-1042" } }),
    );
    expect(answer).toMatchObject({ ok: true, resumed: true });
    const handoff = await t.run((ctx) =>
      worker.handoff.handler(ctx, { ticketId, claimSeq, toQueue: "people", reason: "needs a person" }),
    );
    expect(handoff).toMatchObject({ ok: true, queue: "people", state: "open" });
    const finisherSeq = claimSeqOf(await t.run((ctx) => finisher.claim.handler(ctx, { queue: "people" })));
    await t.run((ctx) =>
      finisher.resolve.handler(ctx, { ticketId, claimSeq: finisherSeq, resolution: "completed", body: "refunded by hand" }),
    );

    const transitions = await transitionsOf(t, lab, ticketId);
    expect(transitions.map((row) => [row.type, row.actorRef, row.actorKind])).toEqual([
      ["opened", REQ.ref, "agent"],
      ["claimed", A.ref, "agent"],
      ["input_requested", A.ref, "agent"],
      ["input_provided", REQ.ref, "agent"],
      ["handed_off", A.ref, "agent"],
      ["claimed", B.ref, "agent"],
      ["resolved", B.ref, "agent"],
    ]);
    const detail = present(await t.run((ctx) => finisher.get.handler(ctx, { ticketId })));
    expect(detail.messages.map((message) => [message.authorRef, message.visibility, message.body])).toEqual([
      [A.ref, "internal", "card is expired"],
      [A.ref, "public", "which order?"],
      [REQ.ref, "public", "order A-1042"],
      [B.ref, "public", "refunded by hand"],
    ]);
    expect(detail.ticket).toMatchObject({ queue: "people", state: "resolved", resolution: "completed", assigneeRef: B.ref, hopCount: 1 });
  });

  test("the requester reads a typed result as data after a refund runs through the tools", async () => {
    const t = setup();
    await syncLab(t);
    const support = toolsFor(REQ);
    const billing = toolsFor(A);
    const opened = { queue: "agent", title: "double charge", fields: { amount: 49, currency: "EUR" }, idempotencyKey: "refund:conv_1" };
    const ticketId = await t.run((ctx) => support.open.handler(ctx, opened));
    expect(await t.run((ctx) => support.open.handler(ctx, opened))).toBe(ticketId);

    const claim = await t.run((ctx) => billing.claim.handler(ctx, { queue: "agent" }));
    const claimSeq = claimSeqOf(claim);
    expect(claim).toMatchObject({ ok: true, ticketId, state: "working" });
    await t.run((ctx) => billing.requestInput.handler(ctx, { ticketId, claimSeq, body: "which order?", fields: ["note"] }));
    const waiting = present(await t.run((ctx) => support.get.handler(ctx, { ticketId })));
    expect(waiting.ticket).toMatchObject({ state: "waiting", category: "waiting", waitingOn: "requester", assigneeRef: A.ref });
    expect(waiting.leaseExpiresAt).toBeUndefined();
    expect(waiting.messages.at(-1)).toMatchObject({ kind: "input_request", requestedFields: ["note"] });

    await t.run((ctx) => support.reply.handler(ctx, { ticketId, body: "A-1042", fields: { note: "A-1042" } }));
    const working = present(await t.run((ctx) => support.get.handler(ctx, { ticketId })));
    expect(working.ticket).toMatchObject({ state: "working", fields: { amount: 49, currency: "EUR", note: "A-1042" } });
    expect(working.leaseExpiresAt).toBeTypeOf("number");

    await t.run((ctx) =>
      billing.resolve.handler(ctx, {
        ticketId,
        claimSeq,
        resolution: "completed",
        result: { ok: true, ref: "re_301" },
        body: "Refunded the amount.",
      }),
    );
    const done = present(await t.run((ctx) => support.get.handler(ctx, { ticketId })));
    expect(done.ticket).toMatchObject({ state: "resolved", resolution: "completed", result: { ok: true, ref: "re_301" } });
    expect(lab.isIn(done.ticket, "agent")).toBe(true);
    expect(done.messages.map((message) => message.body)).toEqual(["which order?", "A-1042", "Refunded the amount."]);
  });

  test("a tool call with a stale claim number gets CLAIM_LOST after the host reassigns the ticket", async () => {
    const t = setup();
    await syncLab(t);
    const ticketId = await t.run((ctx) => lab.open(ctx, { queue: "people", actor: REQ, title: "reassigned" }));
    const first = toolsFor(A);
    const claimSeq = claimSeqOf(await t.run((ctx) => first.claim.handler(ctx, { ticketId })));
    await t.run((ctx) => lab.assign(ctx, { ticketId, actor: LEAD, assignee: B }));

    await expectCode(t.run((ctx) => first.resolve.handler(ctx, { ticketId, claimSeq, resolution: "completed" })), "CLAIM_LOST");
    await expectCode(t.run((ctx) => first.requestInput.handler(ctx, { ticketId, claimSeq, body: "still mine?" })), "CLAIM_LOST");
    await expectCode(t.run((ctx) => first.handoff.handler(ctx, { ticketId, claimSeq, toQueue: "humans" })), "CLAIM_LOST");
  });

  test("a tool call from a party that does not hold the ticket gets NOT_HOLDER", async () => {
    const t = setup();
    await syncLab(t);
    const ticketId = await t.run((ctx) => lab.open(ctx, { queue: "people", actor: REQ, title: "someone else's" }));
    const claimSeq = claimSeqOf(await t.run((ctx) => toolsFor(A).claim.handler(ctx, { ticketId })));

    const outsider = toolsFor(C);
    await expectCode(t.run((ctx) => outsider.resolve.handler(ctx, { ticketId, claimSeq, resolution: "completed" })), "NOT_HOLDER");
    await expectCode(t.run((ctx) => outsider.requestInput.handler(ctx, { ticketId, claimSeq, body: "hi" })), "NOT_HOLDER");
  });

  test("tools refuse bad input with coded errors: unknown queue, unknown field, wrong type, missing result, empty handoff", async () => {
    const t = setup();
    await syncLab(t);
    const tools = toolsFor(A);
    await expectCode(t.run((ctx) => tools.open.handler(ctx, { queue: "nowhere", title: "x" })), "UNKNOWN_QUEUE");
    await expectCode(t.run((ctx) => tools.open.handler(ctx, { queue: "agent", title: "x", fields: { amount: 1, color: "red" } })), "UNKNOWN_FIELD");
    await expectCode(t.run((ctx) => tools.open.handler(ctx, { queue: "agent", title: "x", fields: { amount: "one" } })), "INVALID_FIELD");
    await expectCode(t.run((ctx) => tools.open.handler(ctx, { queue: "agent", title: "x" })), "MISSING_FIELD");

    const ticketId = await t.run((ctx) => tools.open.handler(ctx, { queue: "agent", title: "needs a result", fields: { amount: 1 } }));
    const claimSeq = claimSeqOf(await t.run((ctx) => tools.claim.handler(ctx, { ticketId })));
    await expectCode(t.run((ctx) => tools.resolve.handler(ctx, { ticketId, claimSeq, resolution: "completed" })), "MISSING_FIELD");
    await expectCode(t.run((ctx) => tools.handoff.handler(ctx, { ticketId, claimSeq })), "INVALID_ARGUMENT");
    const refused = await t.run((ctx) => tools.resolve.handler(ctx, { ticketId, claimSeq, resolution: "failed" }));
    expect(refused).toMatchObject({ category: "done" });
  });

  test("a handoff through the tool is allowed at maxHops and refused past it, and the ticket escalates", async () => {
    const hops = new Tickets(components.tickets, {
      queues: {
        left: defineQueue({ policy: { maxHops: 1, escalateTo: "right" } }),
        right: defineQueue({ policy: { maxHops: 1, escalateTo: "left" } }),
      },
    });
    const t = setup();
    await t.run(async (ctx) => {
      await hops.sync(ctx);
    });
    const first = ticketTools(hops, { party: A });
    const second = ticketTools(hops, { party: B });
    const ticketId = await t.run((ctx) => first.open.handler(ctx, { queue: "left", title: "bouncing" }));
    const firstSeq = claimSeqOf(await t.run((ctx) => first.claim.handler(ctx, { ticketId })));

    const allowed = await t.run((ctx) => first.handoff.handler(ctx, { ticketId, claimSeq: firstSeq, toQueue: "right" }));
    expect(allowed).toMatchObject({ ok: true, queue: "right", state: "open" });
    const secondSeq = claimSeqOf(await t.run((ctx) => second.claim.handler(ctx, { ticketId })));

    const refused = await t.run((ctx) => second.handoff.handler(ctx, { ticketId, claimSeq: secondSeq, toQueue: "left" }));
    expect(refused).toEqual({ ok: false, reason: "HOP_LIMIT", escalated: true });
    const detail = present(await t.run((ctx) => second.get.handler(ctx, { ticketId })));
    expect(detail.ticket).toMatchObject({ queue: "left", category: "unstarted", hopCount: 1, priority: 1 });
    expect((await transitionsOf(t, hops, ticketId)).map((row) => row.type)).toEqual(["opened", "claimed", "handed_off", "claimed", "escalated"]);
  });

  test("a result with a wrong type or an unknown key is refused through the resolve tool and the ticket stays held", async () => {
    const t = setup();
    await syncLab(t);
    const tools = toolsFor(A);
    const ticketId = await t.run((ctx) => tools.open.handler(ctx, { queue: "agent", title: "strict result", fields: { amount: 1 } }));
    const claimSeq = claimSeqOf(await t.run((ctx) => tools.claim.handler(ctx, { ticketId })));

    await expectCode(
      t.run((ctx) => tools.resolve.handler(ctx, { ticketId, claimSeq, resolution: "completed", result: { ok: "yes" } })),
      "INVALID_FIELD",
    );
    await expectCode(
      t.run((ctx) => tools.resolve.handler(ctx, { ticketId, claimSeq, resolution: "completed", result: { ok: true, color: "red" } })),
      "UNKNOWN_FIELD",
    );
    const held = present(await t.run((ctx) => tools.get.handler(ctx, { ticketId })));
    expect(held.ticket).toMatchObject({ category: "started", assigneeRef: A.ref });

    const done = await t.run((ctx) =>
      tools.resolve.handler(ctx, { ticketId, claimSeq, resolution: "completed", result: { ok: true, ref: "r-1" } }),
    );
    expect(done).toMatchObject({ category: "done" });
    const finished = present(await t.run((ctx) => tools.get.handler(ctx, { ticketId })));
    expect(finished.ticket).toMatchObject({ category: "done", resolution: "completed", result: { ok: true, ref: "r-1" } });
  });

  test("open through the tool links a parent and blockers, and repeating an idempotency key returns the first ticket", async () => {
    const t = setup();
    await syncLab(t);
    const requester = toolsFor(REQ);
    const parentId = await t.run((ctx) => requester.open.handler(ctx, { queue: "people", title: "parent" }));
    const blockerId = await t.run((ctx) => requester.open.handler(ctx, { queue: "people", title: "blocker" }));
    const childId = await t.run((ctx) =>
      requester.open.handler(ctx, {
        queue: "people",
        title: "child",
        parentId,
        blockedBy: [blockerId],
        idempotencyKey: "child-1",
      }),
    );
    const again = await t.run((ctx) =>
      requester.open.handler(ctx, { queue: "people", title: "child", parentId, blockedBy: [blockerId], idempotencyKey: "child-1" }),
    );
    expect(again).toBe(childId);

    const detail = present(await t.run((ctx) => requester.get.handler(ctx, { ticketId: childId })));
    expect(detail.ticket).toMatchObject({ parentId, openBlockers: 1, requesterRef: REQ.ref });
    expect(detail.blockers).toMatchObject([{ ticketId: blockerId, completed: false }]);
    const children = await t.run((ctx) => requester.list.handler(ctx, { by: "parent", value: parentId }));
    expect(children.page.map((row) => row.title)).toEqual(["child"]);
  });

  describe("reply", () => {
    const chatty = new Tickets(components.tickets, {
      queues: {
        chat: defineQueue({ policy: { maxMessages: 2, escalateTo: "desk" } }),
        desk: defineQueue({}),
        solo: defineQueue({ policy: { maxMessages: 1 } }),
      },
    });

    async function syncChatty(t: T) {
      await t.run(async (ctx) => {
        await chatty.sync(ctx);
      });
    }

    test("a reply is allowed up to maxMessages and refused past it with MESSAGE_LIMIT, and the ticket escalates", async () => {
      const t = setup();
      await syncChatty(t);
      const requester = ticketTools(chatty, { party: REQ });
      const ticketId = await t.run((ctx) => requester.open.handler(ctx, { queue: "chat", title: "talky" }));

      const first = await t.run((ctx) => requester.reply.handler(ctx, { ticketId, body: "one" }));
      const second = await t.run((ctx) => requester.reply.handler(ctx, { ticketId, body: "two" }));
      expect(first).toMatchObject({ ok: true, resumed: false, duplicate: false });
      expect(second).toMatchObject({ ok: true, resumed: false, duplicate: false });

      const third = await t.run((ctx) => requester.reply.handler(ctx, { ticketId, body: "three" }));
      expect(third).toEqual({ ok: false, reason: "MESSAGE_LIMIT", escalated: true });
      const detail = present(await t.run((ctx) => requester.get.handler(ctx, { ticketId })));
      expect(detail.ticket).toMatchObject({ queue: "desk", messageCount: 2 });
      expect(detail.messages.map((message) => message.body)).toEqual(["one", "two"]);
    });

    test("a refused reply reports escalated false when the queue has no escalation target", async () => {
      const t = setup();
      await syncChatty(t);
      const requester = ticketTools(chatty, { party: REQ });
      const ticketId = await t.run((ctx) => requester.open.handler(ctx, { queue: "solo", title: "terse" }));

      const allowed = await t.run((ctx) => requester.reply.handler(ctx, { ticketId, body: "only" }));
      expect(allowed).toMatchObject({ ok: true });
      const refused = await t.run((ctx) => requester.reply.handler(ctx, { ticketId, body: "more" }));
      expect(refused).toEqual({ ok: false, reason: "MESSAGE_LIMIT", escalated: false });
      const detail = present(await t.run((ctx) => requester.get.handler(ctx, { ticketId })));
      expect(detail.ticket).toMatchObject({ queue: "solo", messageCount: 1 });
    });

    test("a reply repeated with the same idempotency key adds no second message and counts as a duplicate", async () => {
      const t = setup();
      await syncChatty(t);
      const requester = ticketTools(chatty, { party: REQ });
      const ticketId = await t.run((ctx) => requester.open.handler(ctx, { queue: "chat", title: "retry" }));

      const first = await t.run((ctx) => requester.reply.handler(ctx, { ticketId, body: "once", idempotencyKey: "m-1" }));
      const second = await t.run((ctx) => requester.reply.handler(ctx, { ticketId, body: "once", idempotencyKey: "m-1" }));
      if (!first.ok || !second.ok) throw new Error("both replies should be accepted");
      expect(first.duplicate).toBe(false);
      expect(second).toMatchObject({ duplicate: true, messageId: first.messageId });
      const detail = present(await t.run((ctx) => requester.get.handler(ctx, { ticketId })));
      expect(detail.ticket.messageCount).toBe(1);
    });
  });

  describe("claim", () => {
    test("claim next returns EMPTY, not an error, when nothing in the queue is claimable", async () => {
      const t = setup();
      await syncLab(t);
      const result = await t.run((ctx) => toolsFor(A).claim.handler(ctx, { queue: "agent" }));
      expect(result).toEqual({ ok: false, reason: "EMPTY" });
    });

    test("the second of two claims on one ticket gets TAKEN, not an error", async () => {
      const t = setup();
      await syncLab(t);
      const ticketId = await t.run((ctx) => lab.open(ctx, { queue: "people", actor: REQ, title: "contested" }));
      const first = await t.run((ctx) => toolsFor(A).claim.handler(ctx, { ticketId }));
      const second = await t.run((ctx) => toolsFor(B).claim.handler(ctx, { ticketId }));
      expect(first).toMatchObject({ ok: true, ticketId });
      expect(second).toEqual({ ok: false, reason: "TAKEN", ticketId });
      const next = await t.run((ctx) => toolsFor(B).claim.handler(ctx, { queue: "people" }));
      expect(next).toEqual({ ok: false, reason: "EMPTY" });
    });

    test("a blocked ticket gives BLOCKED on a direct claim and is skipped by claim next", async () => {
      const t = setup();
      await syncLab(t);
      const requester = toolsFor(REQ);
      const blockerId = await t.run((ctx) => requester.open.handler(ctx, { queue: "people", title: "first" }));
      const blockedId = await t.run((ctx) =>
        requester.open.handler(ctx, { queue: "people", title: "second", blockedBy: [blockerId] }),
      );

      const direct = await t.run((ctx) => toolsFor(A).claim.handler(ctx, { ticketId: blockedId }));
      expect(direct).toEqual({ ok: false, reason: "BLOCKED", ticketId: blockedId });
      const next = await t.run((ctx) => toolsFor(A).claim.handler(ctx, { queue: "people" }));
      expect(next).toMatchObject({ ok: true, ticketId: blockerId });
      const none = await t.run((ctx) => toolsFor(B).claim.handler(ctx, { queue: "people" }));
      expect(none).toEqual({ ok: false, reason: "EMPTY" });
    });

    test("a ticket reserved for another party gives RESERVED, and claim next hands a party its reserved ticket first", async () => {
      const t = setup();
      await syncLab(t);
      const urgent = toolsFor(REQ);
      const plainId = await t.run((ctx) => urgent.open.handler(ctx, { queue: "people", title: "urgent, open to all", priority: 0 }));
      const reservedId = await t.run((ctx) => urgent.open.handler(ctx, { queue: "people", title: "low, reserved for B", priority: 4 }));
      await t.run((ctx) => lab.assign(ctx, { ticketId: reservedId, actor: LEAD, assignee: B }));

      const refused = await t.run((ctx) => toolsFor(A).claim.handler(ctx, { ticketId: reservedId }));
      expect(refused).toEqual({ ok: false, reason: "RESERVED", ticketId: reservedId });
      const reservedFirst = await t.run((ctx) => toolsFor(B).claim.handler(ctx, { queue: "people" }));
      expect(reservedFirst).toMatchObject({ ok: true, ticketId: reservedId });
      const rest = await t.run((ctx) => toolsFor(A).claim.handler(ctx, { queue: "people" }));
      expect(rest).toMatchObject({ ok: true, ticketId: plainId });
    });

    test("claim next takes unreserved tickets by priority, then by age", async () => {
      const t = setup();
      await syncLab(t);
      const requester = toolsFor(REQ);
      const oldNormal = await t.run((ctx) => requester.open.handler(ctx, { queue: "people", title: "old normal" }));
      const newNormal = await t.run((ctx) => requester.open.handler(ctx, { queue: "people", title: "new normal" }));
      const urgent = await t.run((ctx) => requester.open.handler(ctx, { queue: "people", title: "urgent", priority: 0 }));

      const order: string[] = [];
      for (const party of [A, B, C]) {
        const result = await t.run((ctx) => toolsFor(party).claim.handler(ctx, { queue: "people" }));
        order.push(result.ok ? result.ticketId : result.reason);
      }
      expect(order).toEqual([urgent, oldNormal, newNormal]);
    });

    test("a ticket that already ended gives NOT_CLAIMABLE", async () => {
      const t = setup();
      await syncLab(t);
      const ticketId = await t.run((ctx) => lab.open(ctx, { queue: "people", actor: REQ, title: "done soon" }));
      const claimSeq = claimSeqOf(await t.run((ctx) => lab.claim(ctx, { ticketId, actor: A })));
      await t.run((ctx) => lab.resolve(ctx, { ticketId, actor: A, claimSeq, resolution: "completed" }));
      const result = await t.run((ctx) => toolsFor(B).claim.handler(ctx, { ticketId }));
      expect(result).toEqual({ ok: false, reason: "NOT_CLAIMABLE", ticketId });
    });
  });

  describe("list", () => {
    async function seedPeople(t: T) {
      const requester = toolsFor(REQ);
      const ids = {
        one: await t.run((ctx) => requester.open.handler(ctx, { queue: "people", title: "one", subjectRef: "customer:1" })),
        two: await t.run((ctx) => requester.open.handler(ctx, { queue: "people", title: "two", subjectRef: "customer:1" })),
        three: await t.run((ctx) => requester.open.handler(ctx, { queue: "people", title: "three", subjectRef: "customer:2" })),
      };
      const child = await t.run((ctx) => toolsFor(LEAD).open.handler(ctx, { queue: "people", title: "child", parentId: ids.one }));
      await t.run((ctx) => toolsFor(B).claim.handler(ctx, { ticketId: ids.one }));
      return { ...ids, child };
    }
    const titles = (page: { page: { title: string }[] }) => page.page.map((row) => row.title).sort();

    test("list by queue reads every ticket, one state, or one category", async () => {
      const t = setup();
      await syncLab(t);
      await seedPeople(t);
      const reader = toolsFor(A);
      const all = await t.run((ctx) => reader.list.handler(ctx, { by: "queue", value: "people" }));
      expect(titles(all)).toEqual(["child", "one", "three", "two"]);
      expect(all.isDone).toBe(true);
      const working = await t.run((ctx) => reader.list.handler(ctx, { by: "queue", value: "people", state: "working" }));
      expect(titles(working)).toEqual(["one"]);
      const unstarted = await t.run((ctx) => reader.list.handler(ctx, { by: "queue", value: "people", category: "unstarted" }));
      expect(titles(unstarted)).toEqual(["child", "three", "two"]);
      const elsewhere = await t.run((ctx) => reader.list.handler(ctx, { by: "queue", value: "humans" }));
      expect(elsewhere.page).toEqual([]);
    });

    test("list refuses a state and a category together with INVALID_ARGUMENT", async () => {
      const t = setup();
      await syncLab(t);
      await expectCode(
        t.run((ctx) => toolsFor(A).list.handler(ctx, { by: "queue", value: "people", state: "open", category: "unstarted" })),
        "INVALID_ARGUMENT",
      );
    });

    test("list by assignee reads the holder's tickets, optionally one category", async () => {
      const t = setup();
      await syncLab(t);
      await seedPeople(t);
      const reader = toolsFor(A);
      const held = await t.run((ctx) => reader.list.handler(ctx, { by: "assignee", value: B.ref }));
      expect(titles(held)).toEqual(["one"]);
      const started = await t.run((ctx) => reader.list.handler(ctx, { by: "assignee", value: B.ref, category: "started" }));
      expect(titles(started)).toEqual(["one"]);
      const waiting = await t.run((ctx) => reader.list.handler(ctx, { by: "assignee", value: B.ref, category: "waiting" }));
      expect(waiting.page).toEqual([]);
      const nobody = await t.run((ctx) => reader.list.handler(ctx, { by: "assignee", value: C.ref }));
      expect(nobody.page).toEqual([]);
    });

    test("list by requester reads what a party asked for, optionally one category", async () => {
      const t = setup();
      await syncLab(t);
      await seedPeople(t);
      const reader = toolsFor(A);
      const asked = await t.run((ctx) => reader.list.handler(ctx, { by: "requester", value: REQ.ref }));
      expect(titles(asked)).toEqual(["one", "three", "two"]);
      const started = await t.run((ctx) => reader.list.handler(ctx, { by: "requester", value: REQ.ref, category: "started" }));
      expect(titles(started)).toEqual(["one"]);
      const lead = await t.run((ctx) => reader.list.handler(ctx, { by: "requester", value: LEAD.ref }));
      expect(titles(lead)).toEqual(["child"]);
    });

    test("list by subject and by parent read one index range each", async () => {
      const t = setup();
      await syncLab(t);
      const ids = await seedPeople(t);
      const reader = toolsFor(A);
      const subject = await t.run((ctx) => reader.list.handler(ctx, { by: "subject", value: "customer:1" }));
      expect(titles(subject)).toEqual(["one", "two"]);
      const noSubject = await t.run((ctx) => reader.list.handler(ctx, { by: "subject", value: "customer:9" }));
      expect(noSubject.page).toEqual([]);
      const children = await t.run((ctx) => reader.list.handler(ctx, { by: "parent", value: ids.one }));
      expect(titles(children)).toEqual(["child"]);
      const childless = await t.run((ctx) => reader.list.handler(ctx, { by: "parent", value: ids.two }));
      expect(childless.page).toEqual([]);
    });

    test("list pages with a cursor until isDone, with no row repeated or missed", async () => {
      const t = setup();
      await syncLab(t);
      const requester = toolsFor(REQ);
      for (const title of ["a", "b", "c", "d", "e"]) {
        await t.run((ctx) => requester.open.handler(ctx, { queue: "people", title }));
      }
      const reader = toolsFor(A);
      const first = await t.run((ctx) => reader.list.handler(ctx, { by: "queue", value: "people", numItems: 2 }));
      expect(first.page).toHaveLength(2);
      expect(first.isDone).toBe(false);
      const second = await t.run((ctx) =>
        reader.list.handler(ctx, { by: "queue", value: "people", numItems: 2, cursor: first.continueCursor }),
      );
      expect(second.page).toHaveLength(2);
      expect(second.isDone).toBe(false);
      const third = await t.run((ctx) =>
        reader.list.handler(ctx, { by: "queue", value: "people", numItems: 2, cursor: second.continueCursor }),
      );
      expect(third.page).toHaveLength(1);
      expect(third.isDone).toBe(true);
      expect(titles({ page: [...first.page, ...second.page, ...third.page] })).toEqual(["a", "b", "c", "d", "e"]);
      const byDefault = await t.run((ctx) => reader.list.handler(ctx, { by: "queue", value: "people", cursor: null }));
      expect(byDefault.page).toHaveLength(5);
    });

    test("list returns at most 100 rows a page: 100 is allowed, 101 and more are capped to 100, the default is 20", async () => {
      const bulk = new Tickets(components.tickets, {
        queues: { bulk: defineQueue({ policy: { maxOpenPerRequester: 1000 } }) },
        limits: { opensPerMinute: 1000 },
      });
      const t = setup();
      await t.run(async (ctx) => {
        await bulk.sync(ctx);
        for (let index = 0; index < 101; index += 1) {
          await bulk.open(ctx, { queue: "bulk", actor: REQ, title: `ticket ${index}` });
        }
      });
      const reader = ticketTools(bulk, { party: A });
      const atLimit = await t.run((ctx) => reader.list.handler(ctx, { by: "queue", value: "bulk", numItems: 100 }));
      expect(atLimit.page).toHaveLength(100);
      expect(atLimit.isDone).toBe(false);
      const pastLimit = await t.run((ctx) => reader.list.handler(ctx, { by: "queue", value: "bulk", numItems: 101 }));
      expect(pastLimit.page).toHaveLength(100);
      const wayPast = await t.run((ctx) => reader.list.handler(ctx, { by: "queue", value: "bulk", numItems: 100_000 }));
      expect(wayPast.page).toHaveLength(100);
      const byDefault = await t.run((ctx) => reader.list.handler(ctx, { by: "queue", value: "bulk" }));
      expect(byDefault.page).toHaveLength(20);
      const last = await t.run((ctx) =>
        reader.list.handler(ctx, { by: "queue", value: "bulk", numItems: 100, cursor: atLimit.continueCursor }),
      );
      expect(last.page).toHaveLength(1);
      expect(last.isDone).toBe(true);
    });
  });

  describe("get", () => {
    test("a public binding never sees an internal note, an internal binding does", async () => {
      const t = setup();
      await syncLab(t);
      const requester = toolsFor(REQ);
      const holder = toolsFor(A, "internal");
      const ticketId = await t.run((ctx) => requester.open.handler(ctx, { queue: "people", title: "notes", body: "hello" }));
      await t.run((ctx) => holder.claim.handler(ctx, { ticketId }));
      await t.run((ctx) => holder.reply.handler(ctx, { ticketId, body: "the card is expired", visibility: "internal" }));
      await t.run((ctx) => holder.reply.handler(ctx, { ticketId, body: "looking into it" }));

      const publicDetail = present(await t.run((ctx) => requester.get.handler(ctx, { ticketId })));
      expect(publicDetail.messages.map((message) => [message.visibility, message.body])).toEqual([
        ["public", "hello"],
        ["public", "looking into it"],
      ]);
      const explicitPublic = present(await t.run((ctx) => toolsFor(A, "public").get.handler(ctx, { ticketId })));
      expect(explicitPublic.messages.map((message) => message.body)).toEqual(["hello", "looking into it"]);
      const internalDetail = present(await t.run((ctx) => holder.get.handler(ctx, { ticketId })));
      expect(internalDetail.messages.map((message) => [message.visibility, message.body])).toEqual([
        ["public", "hello"],
        ["internal", "the card is expired"],
        ["public", "looking into it"],
      ]);
    });

    test("get returns the state, category, fields, blockers and the lease the holder needs", async () => {
      const t = setup();
      await syncLab(t);
      const requester = toolsFor(REQ);
      const blockerId = await t.run((ctx) => requester.open.handler(ctx, { queue: "people", title: "first" }));
      const ticketId = await t.run((ctx) =>
        requester.open.handler(ctx, { queue: "agent", title: "second", fields: { amount: 3, urgent: true } }),
      );
      await t.run((ctx) => lab.link(ctx, { ticketId: blockerId, actor: REQ, relation: "blocks", toTicketId: ticketId }));

      const detail = present(await t.run((ctx) => requester.get.handler(ctx, { ticketId })));
      expect(detail.ticket).toMatchObject({ state: "open", category: "unstarted", openBlockers: 1, fields: { amount: 3, urgent: true } });
      expect(detail.blockers).toMatchObject([{ ticketId: blockerId, category: "unstarted", completed: false }]);
      expect(detail.leaseExpiresAt).toBeUndefined();
    });
  });
});

describe("presets and client helpers", () => {
  const reportQueue = (opts: { escalateTo: string }) =>
    ({
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
      policy: { leaseMs: null, dueInMs: DAY, escalateTo: opts.escalateTo },
    }) as const;

  const kit = new Tickets(components.tickets, {
    queues: {
      board: defineQueue(
        agentQueue({
          fields: { amount: { type: "number", required: true } },
          result: { ok: { type: "boolean", required: true } },
        }),
      ),
      desk: defineQueue(deskQueue()),
      eng: defineQueue(projectQueue({ fields: { estimate: { type: "number" } } })),
      reports: defineQueue(reportQueue({ escalateTo: "trust-leads" })),
      "trust-leads": defineQueue(deskQueue()),
    },
  });

  async function syncedKit() {
    const t = setup();
    await t.run(async (ctx) => {
      await kit.sync(ctx);
    });
    return t;
  }

  test("an agent queue has the default five states and a five-minute lease that returns an unrenewed ticket", async () => {
    const t = await syncedKit();
    const definition = toQueueDef("board", kit.queues.board);
    expect(definition.states.map((state) => [state.name, state.category])).toEqual([
      ["open", "unstarted"],
      ["working", "started"],
      ["waiting", "waiting"],
      ["resolved", "done"],
      ["canceled", "canceled"],
    ]);
    expect(definition.policy.leaseMs).toBe(5 * MINUTE);

    const ticketId = await t.run((ctx) => kit.open(ctx, { queue: "board", actor: REQ, title: "lease", fields: { amount: 1 } }));
    const claim = await t.run((ctx) => kit.claim(ctx, { ticketId, actor: A }));
    const claimedAt = (await transitionsOf(t, kit, ticketId)).find((row) => row.type === "claimed")?.at;
    expect(claim.ok && claim.leaseExpiresAt).toBe((claimedAt ?? 0) + 5 * MINUTE);

    await drain(t, 4 * MINUTE);
    const stillHeld = present(await t.run((ctx) => kit.get(ctx, { ticketId })));
    expect(stillHeld.ticket).toMatchObject({ category: "started", assigneeRef: A.ref });
    await drain(t, 2 * MINUTE);
    const returned = present(await t.run((ctx) => kit.get(ctx, { ticketId })));
    expect(returned.ticket).toMatchObject({ state: "open", category: "unstarted", leaseExpiryCount: 1 });
    expect(returned.ticket.assigneeRef).toBeUndefined();
  });

  test("a desk queue lands waiting tickets in pending or on_hold by what they wait on and runs with no lease", async () => {
    const t = await syncedKit();
    const stored = present(await t.run((ctx) => kit.getQueue(ctx, { name: "desk" })));
    expect(stored.states).toEqual([
      { name: "new", category: "unstarted" },
      { name: "open", category: "started" },
      { name: "pending", category: "waiting", on: "requester" },
      { name: "on_hold", category: "waiting", on: "external" },
      { name: "solved", category: "done" },
      { name: "canceled", category: "canceled" },
    ]);
    expect(stored.policy.leaseMs).toBeNull();

    const ticketId = await t.run((ctx) => kit.open(ctx, { queue: "desk", actor: REQ, title: "help" }));
    expect(present(await t.run((ctx) => kit.get(ctx, { ticketId }))).ticket.state).toBe("new");
    const claim = await t.run((ctx) => kit.claim(ctx, { ticketId, actor: HUMAN }));
    const claimSeq = claimSeqOf(claim);
    expect(claim.ok && claim.state).toBe("open");
    expect(claim.ok && claim.leaseExpiresAt).toBeUndefined();

    await t.run((ctx) => kit.requestInput(ctx, { queue: "desk", ticketId, actor: HUMAN, claimSeq, body: "more details?" }));
    expect(present(await t.run((ctx) => kit.get(ctx, { ticketId }))).ticket).toMatchObject({ state: "pending", waitingOn: "requester" });
    await t.run((ctx) => kit.reply(ctx, { queue: "desk", ticketId, actor: REQ, body: "here" }));
    expect(present(await t.run((ctx) => kit.get(ctx, { ticketId }))).ticket.state).toBe("open");

    await t.run((ctx) => kit.hold(ctx, { ticketId, actor: HUMAN, claimSeq, waitingOn: "external" }));
    expect(present(await t.run((ctx) => kit.get(ctx, { ticketId }))).ticket).toMatchObject({ state: "on_hold", waitingOn: "external" });
    await t.run((ctx) => kit.resume(ctx, { ticketId, actor: HUMAN, claimSeq }));
    await t.run((ctx) => kit.resolve(ctx, { queue: "desk", ticketId, actor: HUMAN, claimSeq, resolution: "completed" }));
    expect(present(await t.run((ctx) => kit.get(ctx, { ticketId }))).ticket).toMatchObject({ state: "solved", category: "done" });
  });

  test("a project queue has backlog, todo, in_progress, in_review, done and canceled, no lease, and is never sealed", async () => {
    const t = await syncedKit();
    const stored = present(await t.run((ctx) => kit.getQueue(ctx, { name: "eng" })));
    expect(stored.states.map((state) => [state.name, state.category])).toEqual([
      ["backlog", "backlog"],
      ["todo", "unstarted"],
      ["in_progress", "started"],
      ["in_review", "started"],
      ["done", "done"],
      ["canceled", "canceled"],
    ]);
    expect(stored.policy).toMatchObject({ leaseMs: null, reopenWindowMs: null });

    const ticketId = await t.run((ctx) => kit.open(ctx, { queue: "eng", actor: REQ, title: "csv export", to: "backlog", fields: { estimate: 3 } }));
    expect(present(await t.run((ctx) => kit.get(ctx, { ticketId }))).ticket.category).toBe("backlog");
    await t.run((ctx) => kit.move(ctx, { queue: "eng", ticketId, actor: LEAD, to: "todo" }));
    const claim = await t.run((ctx) => kit.claim(ctx, { ticketId, actor: A }));
    const claimSeq = claimSeqOf(claim);
    expect(claim.ok && claim.state).toBe("in_progress");
    expect(claim.ok && claim.leaseExpiresAt).toBeUndefined();
    await t.run((ctx) => kit.move(ctx, { queue: "eng", ticketId, actor: A, claimSeq, to: "in_review" }));
    await t.run((ctx) => kit.resolve(ctx, { queue: "eng", ticketId, actor: A, claimSeq, resolution: "completed" }));
    expect(present(await t.run((ctx) => kit.get(ctx, { ticketId }))).ticket.state).toBe("done");

    await drain(t, 400 * DAY);
    const later = present(await t.run((ctx) => kit.get(ctx, { ticketId })));
    expect(later.ticket.closedAt).toBeUndefined();
    const reopened = await t.run((ctx) => kit.reopen(ctx, { ticketId, actor: REQ }));
    expect(reopened).toMatchObject({ state: "todo", category: "unstarted" });
  });

  test("policy overrides passed to a preset win over the preset's own values", () => {
    const agent = toQueueDef("a", defineQueue(agentQueue({ policy: { leaseMs: MINUTE, maxHops: 2 } })));
    expect(agent.policy).toMatchObject({ leaseMs: MINUTE, maxHops: 2, maxReturns: 3 });
    const desk = toQueueDef("d", defineQueue(deskQueue({ policy: { leaseMs: 10_000, reopenWindowMs: 0 } })));
    expect(desk.policy).toMatchObject({ leaseMs: 10_000, reopenWindowMs: 0 });
    const project = toQueueDef("p", defineQueue(projectQueue({ policy: { reopenWindowMs: DAY } })));
    expect(project.policy).toMatchObject({ leaseMs: null, reopenWindowMs: DAY });
    const leased = toQueueDef("p", defineQueue(projectQueue({ policy: { leaseMs: 1000 } })));
    expect(leased.policy).toMatchObject({ leaseMs: 1000, reopenWindowMs: null });
    const kept = toQueueDef(
      "f",
      defineQueue(deskQueue({ fields: { topic: { type: "string", required: true } }, result: { code: { type: "number" } } })),
    );
    expect(kept.fields).toEqual([{ key: "topic", type: "string", required: true, options: undefined }]);
    expect(kept.resultFields).toEqual([{ key: "code", type: "number", required: false, options: undefined }]);
  });

  test("a custom preset function like the spec's reportQueue works with defineQueue, sync and a full report", async () => {
    const t = await syncedKit();
    const stored = present(await t.run((ctx) => kit.getQueue(ctx, { name: "reports" })));
    expect(stored.states).toEqual([
      { name: "new", category: "unstarted" },
      { name: "reviewing", category: "started" },
      { name: "need_info", category: "waiting", on: "requester" },
      { name: "actioned", category: "done" },
      { name: "dismissed", category: "done" },
      { name: "withdrawn", category: "canceled" },
    ]);
    expect(stored.fields).toEqual([{ key: "reason", type: "enum", required: true, options: ["cheating", "abuse", "spam"] }]);
    expect(stored.resultFields).toEqual([{ key: "action", type: "enum", required: true, options: ["none", "warning", "ban"] }]);
    expect(stored.policy).toMatchObject({ leaseMs: null, dueInMs: DAY, escalateTo: "trust-leads" });

    const untyped = ticketTools(kit, { party: REQ });
    await expectCode(t.run((ctx) => untyped.open.handler(ctx, { queue: "reports", title: "r", fields: { reason: "rude" } })), "INVALID_FIELD");
    const ticketId = await t.run((ctx) => kit.open(ctx, { queue: "reports", actor: REQ, title: "cheater", fields: { reason: "cheating" } }));
    const opened = present(await t.run((ctx) => kit.get(ctx, { ticketId })));
    expect(opened.ticket).toMatchObject({ state: "new", dueAt: opened.ticket.createdAt + DAY });

    const claim = await t.run((ctx) => kit.claim(ctx, { ticketId, actor: A }));
    const claimSeq = claimSeqOf(claim);
    expect(claim.ok && claim.state).toBe("reviewing");
    await t.run((ctx) => kit.requestInput(ctx, { queue: "reports", ticketId, actor: A, claimSeq, body: "which match?", fields: ["reason"] }));
    expect(present(await t.run((ctx) => kit.get(ctx, { ticketId }))).ticket.state).toBe("need_info");
    await t.run((ctx) => kit.reply(ctx, { queue: "reports", ticketId, actor: REQ, body: "match 7", fields: { reason: "abuse" } }));
    expect(present(await t.run((ctx) => kit.get(ctx, { ticketId }))).ticket).toMatchObject({ state: "reviewing", fields: { reason: "abuse" } });

    await expectCode(t.run((ctx) => kit.resolve(ctx, { queue: "reports", ticketId, actor: A, claimSeq, resolution: "completed" })), "MISSING_FIELD");
    await t.run((ctx) => kit.resolve(ctx, { queue: "reports", ticketId, actor: A, claimSeq, resolution: "completed", result: { action: "ban" } }));
    expect(present(await t.run((ctx) => kit.get(ctx, { ticketId }))).ticket).toMatchObject({ state: "actioned", result: { action: "ban" } });

    const second = await t.run((ctx) => kit.open(ctx, { queue: "reports", actor: REQ, title: "false alarm", fields: { reason: "spam" } }));
    const secondSeq = claimSeqOf(await t.run((ctx) => kit.claim(ctx, { ticketId: second, actor: A })));
    await t.run((ctx) =>
      kit.resolve(ctx, { queue: "reports", ticketId: second, actor: A, claimSeq: secondSeq, resolution: "rejected", result: { action: "none" }, to: "dismissed" }),
    );
    expect(present(await t.run((ctx) => kit.get(ctx, { ticketId: second }))).ticket).toMatchObject({ state: "dismissed", resolution: "rejected" });

    const third = await t.run((ctx) => kit.open(ctx, { queue: "reports", actor: REQ, title: "changed my mind", fields: { reason: "spam" } }));
    await t.run((ctx) => kit.cancel(ctx, { ticketId: third, actor: REQ }));
    expect(present(await t.run((ctx) => kit.get(ctx, { ticketId: third }))).ticket).toMatchObject({ state: "withdrawn", category: "canceled" });
  });

  test("toQueueDef fills every default: five states, the agent lease, a seven-day reopen window and the guardrail counts", () => {
    const definition = toQueueDef("plain", defineQueue({}));
    expect(definition).toEqual({
      name: "plain",
      states: [
        { name: "open", category: "unstarted" },
        { name: "working", category: "started" },
        { name: "waiting", category: "waiting" },
        { name: "resolved", category: "done" },
        { name: "canceled", category: "canceled" },
      ],
      fields: [],
      resultFields: [],
      policy: {
        leaseMs: 5 * MINUTE,
        dueInMs: undefined,
        reopenWindowMs: 7 * DAY,
        maxHops: 6,
        maxReturns: 3,
        maxMessages: 200,
        maxOpenPerRequester: 50,
        escalateTo: undefined,
        escalateOnDue: undefined,
      },
    });
  });

  test("toQueueDef keeps explicit null, zero and false policy values instead of replacing them with defaults", () => {
    const definition = toQueueDef(
      "explicit",
      defineQueue({
        policy: { leaseMs: null, reopenWindowMs: null, maxHops: 0, maxReturns: 0, maxMessages: 0, maxOpenPerRequester: 0, escalateOnDue: false },
      }),
    );
    expect(definition.policy).toMatchObject({
      leaseMs: null,
      reopenWindowMs: null,
      maxHops: 0,
      maxReturns: 0,
      maxMessages: 0,
      maxOpenPerRequester: 0,
      escalateOnDue: false,
    });
    expect(toQueueDef("zero", defineQueue({ policy: { reopenWindowMs: 0 } })).policy.reopenWindowMs).toBe(0);
  });

  test("toQueueDef copies field definitions: required defaults to false and options only exist on enums", () => {
    const options = ["EUR", "USD"] as const;
    const definition = toQueueDef(
      "fields",
      defineQueue({
        fields: {
          amount: { type: "number", required: true },
          note: { type: "string" },
          urgent: { type: "boolean" },
          currency: { type: "enum", options },
        },
        result: { ok: { type: "boolean", required: true } },
      }),
    );
    expect(definition.fields).toEqual([
      { key: "amount", type: "number", required: true, options: undefined },
      { key: "note", type: "string", required: false, options: undefined },
      { key: "urgent", type: "boolean", required: false, options: undefined },
      { key: "currency", type: "enum", required: false, options: ["EUR", "USD"] },
    ]);
    expect(definition.resultFields).toEqual([{ key: "ok", type: "boolean", required: true, options: undefined }]);
    expect(definition.fields[3]?.options).not.toBe(options);
  });

  test("toQueueDef keeps a custom queue's states in order with the waiting target", () => {
    const definition = toQueueDef("custom", defineQueue(reportQueue({ escalateTo: "x" })));
    expect(definition.states.map((state) => state.name)).toEqual(["new", "reviewing", "need_info", "actioned", "dismissed", "withdrawn"]);
    expect(definition.states[2]).toEqual({ name: "need_info", category: "waiting", on: "requester" });
    expect(definition.policy).toMatchObject({ leaseMs: null, dueInMs: DAY, escalateTo: "x" });
  });

  test("toValues drops undefined, keeps null and every scalar, and passes undefined through", () => {
    expect(toValues(undefined)).toBeUndefined();
    expect(toValues({})).toEqual({});
    const values = toValues({ a: 1, b: undefined, c: null, d: "text", e: false, f: 0, g: "" });
    expect(values).toEqual({ a: 1, c: null, d: "text", e: false, f: 0, g: "" });
    expect(values).not.toHaveProperty("b");
    expect(Object.keys(values ?? {})).toEqual(["a", "c", "d", "e", "f", "g"]);
  });

  describe("isIn", () => {
    async function agentTicket(options: { resolve: boolean }) {
      const t = setup();
      await syncLab(t);
      const ticketId = await t.run((ctx) =>
        lab.open(ctx, { queue: "agent", actor: REQ, title: "typed", fields: { amount: 49, currency: "EUR", note: "n" } }),
      );
      if (options.resolve) {
        const claimSeq = claimSeqOf(await t.run((ctx) => lab.claim(ctx, { ticketId, actor: A })));
        await t.run((ctx) =>
          lab.resolve(ctx, { ticketId, actor: A, claimSeq, resolution: "completed", result: { ok: true, ref: "r1" } }),
        );
      }
      return present(await t.run((ctx) => lab.get(ctx, { ticketId }))).ticket;
    }

    test("isIn accepts a ticket of that queue whose fields and result fit the definition", async () => {
      const ticket = await agentTicket({ resolve: true });
      expect(lab.isIn(ticket, "agent")).toBe(true);
      expect(lab.isIn({ ...ticket, fields: { ...ticket.fields, note: null } }, "agent")).toBe(true);
    });

    test("isIn narrows the ticket so declared fields have their declared types", async () => {
      const ticket = await agentTicket({ resolve: true });
      if (!lab.isIn(ticket, "agent")) throw new Error("the ticket should be in the agent queue");
      const amount: number | null | undefined = ticket.fields.amount;
      const ok: boolean | null | undefined = ticket.result?.ok;
      expect(amount).toBe(49);
      expect(ok).toBe(true);
    });

    test("isIn refuses a ticket from another queue", async () => {
      const ticket = await agentTicket({ resolve: false });
      expect(lab.isIn(ticket, "people")).toBe(false);
      expect(lab.isIn(ticket, "humans")).toBe(false);
    });

    test("isIn refuses a field value of the wrong type or outside the enum options", async () => {
      const ticket = await agentTicket({ resolve: false });
      expect(lab.isIn({ ...ticket, fields: { amount: "49" } }, "agent")).toBe(false);
      expect(lab.isIn({ ...ticket, fields: { amount: 49, urgent: "yes" } }, "agent")).toBe(false);
      expect(lab.isIn({ ...ticket, fields: { amount: 49, note: 3 } }, "agent")).toBe(false);
      expect(lab.isIn({ ...ticket, fields: { amount: 49, currency: "GBP" } }, "agent")).toBe(false);
      expect(lab.isIn({ ...ticket, fields: { amount: 49, currency: 1 } }, "agent")).toBe(false);
    });

    test("isIn refuses a result value that does not fit the result definition", async () => {
      const ticket = await agentTicket({ resolve: true });
      expect(lab.isIn({ ...ticket, result: { ok: "yes" } }, "agent")).toBe(false);
      expect(lab.isIn({ ...ticket, result: { ok: true, ref: 5 } }, "agent")).toBe(false);
    });
  });
});
