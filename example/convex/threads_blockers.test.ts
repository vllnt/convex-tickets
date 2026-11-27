/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from "vitest";
import { SYSTEM_PARTY, Tickets, defineQueue, isTicketsError } from "../../src/client/index.js";
import type {
  Party,
  ReplyResult,
  Resolution,
  RunMutationCtx,
  Scalar,
  TicketDetail,
  TicketsErrorCode,
  Visibility,
} from "../../src/client/index.js";
import { deskQueue, projectQueue } from "../../src/client/presets.js";
import { components, internal } from "./_generated/api.js";
import { A, B, C, DAY, HUMAN, LEAD, MINUTE, REQ, drain, events, expectCode, lab, setup, syncLab } from "./harness.helper.js";
import type { T } from "./harness.helper.js";

afterEach(() => {
  vi.useRealTimers();
});

/** Small caps so every limit is cheap to reach: 3 messages per ticket, 5 per minute, 10 characters per body. */
const chat = new Tickets(components.tickets, {
  queues: {
    talk: defineQueue({
      fields: { note: { type: "string" } },
      policy: { leaseMs: null, maxMessages: 3, escalateTo: "humans" },
    }),
    solo: defineQueue({ policy: { leaseMs: null, maxMessages: 2 } }),
    plain: defineQueue({ policy: { leaseMs: null } }),
    humans: defineQueue(deskQueue({ policy: { maxMessages: 3 } })),
  },
  limits: { messagesPerMinute: 5, maxBodyChars: 10 },
  onEvent: internal.hooks.recordOnly,
});

/** Small graph caps: 2 blockers per ticket, 2 dependents per blocker, a walk of 3 tickets. */
const graph = new Tickets(components.tickets, {
  queues: {
    g: defineQueue(projectQueue()),
    w: defineQueue({ policy: { leaseMs: null } }),
  },
  limits: { maxBlockers: 2, maxBlocked: 2, maxGraphWalk: 3 },
  onEvent: internal.hooks.recordOnly,
});

const PAGE = { cursor: null, numItems: 100 };

function must<V>(value: V | null | undefined, what: string): V {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

async function ready(): Promise<T> {
  const t = setup();
  await syncLab(t);
  return t;
}

async function readyWith(client: { sync(ctx: RunMutationCtx): Promise<unknown> }): Promise<T> {
  const t = setup();
  await t.run(async (ctx) => {
    await client.sync(ctx);
  });
  return t;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function retryAtOf(error: unknown): number | undefined {
  return isTicketsError(error) ? error.data.retryAt : undefined;
}

/** Resolve to true when the call worked, to false when it failed with `code`; any other failure is rethrown. */
async function allowing(promise: Promise<unknown>, code: TicketsErrorCode): Promise<boolean> {
  try {
    await promise;
    return true;
  } catch (error: unknown) {
    if (isTicketsError(error, code)) return false;
    throw error;
  }
}

function accepted(result: ReplyResult): { messageId: string; resumed: boolean; duplicate: boolean } {
  if (!result.ok) throw new Error(`reply refused: ${result.reason}`);
  return result;
}

async function detail(t: T, ticketId: string, view?: Visibility): Promise<TicketDetail> {
  return must(await t.run((ctx) => lab.get(ctx, { ticketId, view })), `ticket ${ticketId}`);
}

async function history(t: T, ticketId: string) {
  const page = await t.run((ctx) => lab.listTransitions(ctx, { ticketId, paginationOpts: PAGE }));
  return page.page;
}

async function historyTypes(t: T, ticketId: string): Promise<string[]> {
  return (await history(t, ticketId)).map((row) => row.type);
}

async function thread(t: T, ticketId: string, view?: Visibility) {
  const page = await t.run((ctx) => lab.listMessages(ctx, { ticketId, view, paginationOpts: PAGE }));
  return page.page;
}

/** Hook event types for one ticket in seq order: the hooks of one batch of transitions may arrive in any order. */
async function eventTypes(t: T, ticketId: string): Promise<string[]> {
  await drain(t);
  return (await events(t))
    .filter((row) => row.ticketId === ticketId)
    .sort((x, y) => x.seq - y.seq)
    .map((row) => row.type);
}

async function lastTransitionAt(t: T, ticketId: string): Promise<number> {
  return must((await history(t, ticketId)).at(-1), "last transition").at;
}

async function counter(t: T, ticketId: string): Promise<number> {
  return (await detail(t, ticketId)).ticket.openBlockers;
}

async function openAgent(t: T, fields: { amount: number; note?: string } = { amount: 1 }): Promise<string> {
  return await t.run((ctx) => lab.open(ctx, { queue: "agent", actor: REQ, title: "job", fields }));
}

async function openPeople(t: T): Promise<string> {
  return await t.run((ctx) => lab.open(ctx, { queue: "people", actor: REQ, title: "approval" }));
}

async function openDesk(t: T): Promise<string> {
  return await t.run((ctx) => lab.open(ctx, { queue: "humans", actor: REQ, title: "question" }));
}

async function openProj(t: T, title: string, extra: { blockedBy?: string[]; to?: "backlog" | "todo" } = {}): Promise<string> {
  return await t.run((ctx) => lab.open(ctx, { queue: "proj", actor: LEAD, title, ...extra }));
}

async function openSealed(t: T): Promise<string> {
  const ticketId = await t.run((ctx) => lab.open(ctx, { queue: "instant", actor: REQ, title: "sealed at once" }));
  const claimSeq = await take(t, ticketId, A);
  await t.run((ctx) => lab.resolve(ctx, { ticketId, actor: A, claimSeq, resolution: "completed" }));
  return ticketId;
}

async function take(t: T, ticketId: string, actor: Party): Promise<number> {
  const result = await t.run((ctx) => lab.claim(ctx, { ticketId, actor }));
  if (!result.ok) throw new Error(`claim of ${ticketId} failed: ${result.reason}`);
  return result.claimSeq;
}

/** Claim a ticket of a queue with no required result and end it with `resolution`. */
async function complete(t: T, ticketId: string, actor: Party = A, resolution: Resolution = "completed"): Promise<void> {
  const claimSeq = await take(t, ticketId, actor);
  await t.run((ctx) => lab.resolve(ctx, { ticketId, actor, claimSeq, resolution }));
}

async function endBlocker(t: T, ticketId: string, how: "canceled" | Resolution): Promise<void> {
  if (how === "canceled") await t.run((ctx) => lab.cancel(ctx, { ticketId, actor: LEAD, trusted: true }));
  else await complete(t, ticketId, HUMAN, how);
}

async function reopenTicket(t: T, ticketId: string): Promise<void> {
  await t.run((ctx) => lab.reopen(ctx, { ticketId, actor: LEAD, trusted: true }));
}

function say(t: T, ticketId: string, actor: Party, body: string, visibility?: Visibility) {
  return t.run(async (ctx) => accepted(await lab.reply(ctx, { ticketId, actor, body, visibility })));
}

function block(t: T, blocker: string, blocked: string): Promise<string> {
  return t.run((ctx) => lab.link(ctx, { ticketId: blocker, actor: LEAD, relation: "blocks", toTicketId: blocked }));
}

function linkTo(t: T, ticketId: string, relation: "duplicates" | "relates", toTicketId: string): Promise<string> {
  return t.run((ctx) => lab.link(ctx, { ticketId, actor: LEAD, relation, toTicketId }));
}

function label(t: T, ticketId: string, name: string, refKind = "label"): Promise<string> {
  return t.run((ctx) => lab.link(ctx, { ticketId, actor: LEAD, relation: "ref", refKind, ref: name }));
}

function hold(t: T, ticketId: string, actor: Party, claimSeq: number, extra: { blockers?: string[]; waitingOn?: "blockers" | "external" } = {}) {
  return t.run((ctx) => lab.hold(ctx, { ticketId, actor, claimSeq, ...extra }));
}

function askRaw(t: T, args: { ticketId: string; actor: Party; claimSeq: number; fields: string[] }) {
  return t.run((ctx) => ctx.runMutation(lab.component.mutations.requestInput, { ...args, body: "Which?" }));
}

function replyRaw(t: T, args: { ticketId: string; actor: Party; body: string; fields: Record<string, Scalar> }) {
  return t.run((ctx) => ctx.runMutation(lab.component.mutations.reply, args));
}

describe("the thread: public and internal views", () => {
  test("get never returns an internal note by default and returns it for the internal view", async () => {
    const t = await ready();
    const id = await openAgent(t);
    await take(t, id, A);
    await say(t, id, REQ, "public from the requester");
    await say(t, id, A, "internal: the card is expired", "internal");
    await say(t, id, A, "public from the holder");

    const publicView = await detail(t, id);
    expect(publicView.messages.map((m) => m.body)).toEqual(["public from the requester", "public from the holder"]);
    expect(publicView.messages.every((m) => m.visibility === "public")).toBe(true);

    const internalView = await detail(t, id, "internal");
    expect(internalView.messages.map((m) => [m.visibility, m.body])).toEqual([
      ["public", "public from the requester"],
      ["internal", "internal: the card is expired"],
      ["public", "public from the holder"],
    ]);
    expect(publicView.ticket.messageCount).toBe(3);
  });

  test("listMessages gives the same two views in seq order, also when paged one at a time", async () => {
    const t = await ready();
    const id = await openAgent(t);
    await take(t, id, A);
    await say(t, id, A, "one");
    await say(t, id, B, "two internal", "internal");
    await say(t, id, REQ, "three");
    await say(t, id, A, "four internal", "internal");

    expect((await thread(t, id)).map((m) => [m.seq, m.body])).toEqual([
      [1, "one"],
      [3, "three"],
    ]);
    const internal = await thread(t, id, "internal");
    expect(internal.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(internal.map((m) => m.authorRef)).toEqual([A.ref, B.ref, REQ.ref, A.ref]);

    const first = await t.run((ctx) => lab.listMessages(ctx, { ticketId: id, paginationOpts: { cursor: null, numItems: 1 } }));
    const second = await t.run((ctx) =>
      lab.listMessages(ctx, { ticketId: id, paginationOpts: { cursor: first.continueCursor, numItems: 1 } }),
    );
    expect([...first.page, ...second.page].map((m) => m.body)).toEqual(["one", "three"]);
  });
});

describe("requestInput", () => {
  test("the holder moves a started ticket to waiting on the requester and the lease stops", async () => {
    const t = await ready();
    const id = await openAgent(t);
    const claimSeq = await take(t, id, A);
    expect((await detail(t, id)).leaseExpiresAt).toBeDefined();

    const asked = await t.run((ctx) =>
      lab.requestInput(ctx, { queue: "agent", ticketId: id, actor: A, claimSeq, body: "Which note?", fields: ["note", "urgent"] }),
    );
    expect(asked).toMatchObject({ queue: "agent", state: "waiting", category: "waiting", claimSeq });

    const after = await detail(t, id);
    expect(after.ticket).toMatchObject({ state: "waiting", category: "waiting", waitingOn: "requester", assigneeRef: A.ref });
    expect(after.leaseExpiresAt).toBeUndefined();
    expect(after.messages.at(-1)).toMatchObject({
      kind: "input_request",
      visibility: "public",
      authorRef: A.ref,
      body: "Which note?",
      requestedFields: ["note", "urgent"],
    });

    await drain(t, 10 * MINUTE);
    expect((await detail(t, id)).ticket).toMatchObject({ category: "waiting", assigneeRef: A.ref, leaseExpiryCount: 0 });
  });

  test("a desk queue lands requestInput on pending and hold on on_hold, and the requester's reply returns it to open", async () => {
    const t = await ready();
    const id = await openDesk(t);
    const claimSeq = await take(t, id, A);
    expect((await detail(t, id)).ticket.state).toBe("open");

    const asked = await t.run((ctx) => lab.requestInput(ctx, { queue: "humans", ticketId: id, actor: A, claimSeq, body: "Which order?" }));
    expect(asked).toMatchObject({ state: "pending", category: "waiting" });
    expect((await detail(t, id)).ticket).toMatchObject({ state: "pending", waitingOn: "requester" });

    expect(await say(t, id, REQ, "Order 7")).toMatchObject({ resumed: true });
    expect((await detail(t, id)).ticket).toMatchObject({ state: "open", category: "started" });

    expect(await hold(t, id, A, claimSeq)).toMatchObject({ state: "on_hold", category: "waiting" });
    expect((await detail(t, id)).ticket).toMatchObject({ state: "on_hold", waitingOn: "external" });
  });

  test("requestInput names only fields the queue declares: an unknown one is UNKNOWN_FIELD and nothing changes", async () => {
    const t = await ready();
    const id = await openAgent(t);
    const claimSeq = await take(t, id, A);

    await expectCode(askRaw(t, { ticketId: id, actor: A, claimSeq, fields: ["note", "nope"] }), "UNKNOWN_FIELD");

    const after = await detail(t, id);
    expect(after.ticket).toMatchObject({ category: "started", messageCount: 0 });
    expect(after.messages).toEqual([]);
  });

  test("requestInput is refused for a non-holder with NOT_HOLDER and for a stale claimSeq with CLAIM_LOST", async () => {
    const t = await ready();
    const id = await openAgent(t);
    const first = await take(t, id, A);
    const ask = (actor: Party, claimSeq: number) =>
      t.run((ctx) => lab.requestInput(ctx, { queue: "agent", ticketId: id, actor, claimSeq, body: "Which?" }));

    await expectCode(ask(B, first), "NOT_HOLDER");
    await t.run((ctx) => lab.release(ctx, { ticketId: id, actor: A, claimSeq: first }));
    const second = await take(t, id, A);
    expect(second).toBeGreaterThan(first);
    await expectCode(ask(A, first), "CLAIM_LOST");
    await expectCode(ask(B, second), "NOT_HOLDER");

    const after = await detail(t, id);
    expect(after.ticket).toMatchObject({ category: "started", assigneeRef: A.ref, messageCount: 0 });
  });

  test("requestInput with the thread one message under the cap works and at the cap fails with MESSAGE_LIMIT", async () => {
    const t = await readyWith(chat);
    const openTalk = () => t.run((ctx) => chat.open(ctx, { queue: "talk", actor: REQ, title: "capped" }));
    const claimed = async (ticketId: string) => await take(t, ticketId, A);

    const under = await openTalk();
    const underSeq = await claimed(under);
    await say(t, under, A, "one");
    await say(t, under, A, "two");
    const asked = await t.run((ctx) => chat.requestInput(ctx, { queue: "talk", ticketId: under, actor: A, claimSeq: underSeq, body: "ask", fields: ["note"] }));
    expect(asked.category).toBe("waiting");
    expect((await detail(t, under)).ticket.messageCount).toBe(3);

    const full = await openTalk();
    const fullSeq = await claimed(full);
    await say(t, full, A, "one");
    await say(t, full, A, "two");
    await say(t, full, A, "three");
    await expectCode(
      t.run((ctx) => chat.requestInput(ctx, { queue: "talk", ticketId: full, actor: A, claimSeq: fullSeq, body: "ask" })),
      "MESSAGE_LIMIT",
    );
    expect((await detail(t, full)).ticket).toMatchObject({ category: "started", messageCount: 3 });
  });
});

describe("reply from the requester", () => {
  test("a requester reply with fields patches the ticket, returns it to started and restarts the lease", async () => {
    const t = await ready();
    const id = await openAgent(t, { amount: 49, note: "keep" });
    const claimSeq = await take(t, id, A);
    const firstLease = must((await detail(t, id)).leaseExpiresAt, "first lease");
    await drain(t, MINUTE);
    await t.run((ctx) =>
      lab.requestInput(ctx, { queue: "agent", ticketId: id, actor: A, claimSeq, body: "Which currency?", fields: ["currency"] }),
    );
    await drain(t, MINUTE);

    const result = await t.run((ctx) =>
      lab.reply(ctx, { queue: "agent", ticketId: id, actor: REQ, body: "EUR please", fields: { currency: "EUR", amount: 50 } }),
    );
    expect(result).toMatchObject({ ok: true, resumed: true, duplicate: false });

    const after = await detail(t, id);
    expect(after.ticket).toMatchObject({
      state: "working",
      category: "started",
      assigneeRef: A.ref,
      claimSeq,
      fields: { amount: 50, currency: "EUR", note: "keep" },
    });
    expect(after.ticket.waitingOn).toBeUndefined();
    expect(after.leaseExpiresAt).toBe((await lastTransitionAt(t, id)) + 5 * MINUTE);
    expect(after.leaseExpiresAt).toBeGreaterThan(firstLease);
    expect(after.messages.at(-1)).toMatchObject({ authorRef: REQ.ref, body: "EUR please", data: { currency: "EUR", amount: 50 } });
    expect(await historyTypes(t, id)).toEqual(["opened", "claimed", "input_requested", "input_provided"]);
    expect(await eventTypes(t, id)).toContain("input_provided");
  });

  test("after the requester answers, the old lease timer does not take the ticket and the new lease expires on its own", async () => {
    const t = await ready();
    const id = await openAgent(t);
    const claimSeq = await take(t, id, A);
    await drain(t, 2 * MINUTE);
    await t.run((ctx) => lab.requestInput(ctx, { queue: "agent", ticketId: id, actor: A, claimSeq, body: "Which?" }));
    await say(t, id, REQ, "this one");

    await drain(t, 3 * MINUTE + 1000);
    expect((await detail(t, id)).ticket).toMatchObject({ category: "started", assigneeRef: A.ref, leaseExpiryCount: 0 });

    await drain(t, 3 * MINUTE);
    expect((await detail(t, id)).ticket).toMatchObject({ category: "unstarted", leaseExpiryCount: 1 });
    expect(await historyTypes(t, id)).toEqual(["opened", "claimed", "input_requested", "input_provided", "lease_expired"]);
  });

  test("the holder's claimSeq still works after the requester answers", async () => {
    const t = await ready();
    const id = await openAgent(t);
    const claimSeq = await take(t, id, A);
    await t.run((ctx) => lab.requestInput(ctx, { queue: "agent", ticketId: id, actor: A, claimSeq, body: "Which?" }));
    await say(t, id, REQ, "answer");

    const done = await t.run((ctx) => lab.resolve(ctx, { queue: "agent", ticketId: id, actor: A, claimSeq, resolution: "completed", result: { ok: true } }));
    expect(done).toMatchObject({ state: "resolved", category: "done" });
  });

  test("null in a reply clears an optional field and a required field refuses null", async () => {
    const t = await ready();
    const id = await openAgent(t, { amount: 3, note: "old" });
    const claimSeq = await take(t, id, A);
    await t.run((ctx) => lab.requestInput(ctx, { queue: "agent", ticketId: id, actor: A, claimSeq, body: "Still true?", fields: ["note"] }));

    await expectCode(
      t.run((ctx) => lab.reply(ctx, { queue: "agent", ticketId: id, actor: REQ, body: "no amount", fields: { amount: null } })),
      "MISSING_FIELD",
    );
    expect((await detail(t, id)).ticket).toMatchObject({ category: "waiting", fields: { amount: 3, note: "old" } });

    await t.run((ctx) => lab.reply(ctx, { queue: "agent", ticketId: id, actor: REQ, body: "drop the note", fields: { note: null } }));
    const after = await detail(t, id);
    expect(after.ticket.category).toBe("started");
    expect(after.ticket.fields).toEqual({ amount: 3 });
  });

  test("reply fields are type-checked and a refused reply writes nothing and leaves the ticket waiting", async () => {
    const t = await ready();
    const id = await openAgent(t, { amount: 3 });
    const claimSeq = await take(t, id, A);
    await t.run((ctx) => lab.requestInput(ctx, { queue: "agent", ticketId: id, actor: A, claimSeq, body: "Details?" }));
    const attempt = (fields: Record<string, Scalar>) => replyRaw(t, { ticketId: id, actor: REQ, body: "here", fields });

    await expectCode(attempt({ amount: "lots" }), "INVALID_FIELD");
    await expectCode(attempt({ urgent: "yes" }), "INVALID_FIELD");
    await expectCode(attempt({ currency: "GBP" }), "INVALID_FIELD");
    await expectCode(attempt({ nope: 1 }), "UNKNOWN_FIELD");

    const after = await detail(t, id);
    expect(after.ticket).toMatchObject({ category: "waiting", waitingOn: "requester", messageCount: 1, fields: { amount: 3 } });
    expect(after.messages.map((m) => m.kind)).toEqual(["input_request"]);
  });
});

describe("replies that only add a message", () => {
  test("a reply by someone else while the ticket waits on the requester adds a message and resumes nothing", async () => {
    const t = await ready();
    const id = await openAgent(t);
    const claimSeq = await take(t, id, A);
    await t.run((ctx) => lab.requestInput(ctx, { queue: "agent", ticketId: id, actor: A, claimSeq, body: "Which?" }));

    expect(await say(t, id, B, "I can see it too")).toMatchObject({ resumed: false, duplicate: false });
    expect(await say(t, id, A, "still waiting")).toMatchObject({ resumed: false });
    const after = await detail(t, id);
    expect(after.ticket).toMatchObject({ category: "waiting", waitingOn: "requester", messageCount: 3 });
    expect(await historyTypes(t, id)).toEqual(["opened", "claimed", "input_requested"]);
  });

  test("supplying fields as anyone but the requester answering is FIELDS_NOT_ACCEPTED and writes nothing", async () => {
    const t = await ready();
    const id = await openAgent(t);
    const claimSeq = await take(t, id, A);
    await t.run((ctx) => lab.requestInput(ctx, { queue: "agent", ticketId: id, actor: A, claimSeq, body: "Which?" }));

    await expectCode(
      t.run((ctx) => lab.reply(ctx, { queue: "agent", ticketId: id, actor: B, body: "I know", fields: { note: "from B" } })),
      "FIELDS_NOT_ACCEPTED",
    );
    const after = await detail(t, id);
    expect(after.ticket).toMatchObject({ category: "waiting", waitingOn: "requester", fields: { amount: 1 }, messageCount: 1 });

    const running = await openAgent(t);
    await take(t, running, A);
    await expectCode(
      t.run((ctx) => lab.reply(ctx, { queue: "agent", ticketId: running, actor: REQ, body: "not waiting", fields: { note: "late" } })),
      "FIELDS_NOT_ACCEPTED",
    );
    const untouched = await detail(t, running);
    expect(untouched.ticket).toMatchObject({ category: "started", fields: { amount: 1 }, messageCount: 0 });
  });

  test("the requester replying when the ticket is not waiting on them only adds a message", async () => {
    const t = await ready();
    const id = await openPeople(t);
    expect(await say(t, id, REQ, "while unstarted")).toMatchObject({ resumed: false });
    expect((await detail(t, id)).ticket.category).toBe("unstarted");

    const claimSeq = await take(t, id, A);
    expect(await say(t, id, REQ, "while started")).toMatchObject({ resumed: false });
    expect((await detail(t, id)).ticket.category).toBe("started");

    await hold(t, id, A, claimSeq);
    expect(await say(t, id, REQ, "while waiting on something outside")).toMatchObject({ resumed: false });
    expect((await detail(t, id)).ticket).toMatchObject({ category: "waiting", waitingOn: "external" });

    await expectCode(replyRaw(t, { ticketId: id, actor: REQ, body: "with fields", fields: { note: "x" } }), "FIELDS_NOT_ACCEPTED");
  });

  test("the requester replying while the ticket waits on blockers only adds a message", async () => {
    const t = await ready();
    const blocker = await openPeople(t);
    const id = await openPeople(t);
    const claimSeq = await take(t, id, A);
    await hold(t, id, A, claimSeq, { blockers: [blocker] });

    expect(await say(t, id, REQ, "any news?")).toMatchObject({ resumed: false });
    expect((await detail(t, id)).ticket).toMatchObject({ category: "waiting", waitingOn: "blockers", openBlockers: 1 });
  });

  test("a reply on a resolved ticket that is not sealed adds a message and does not reopen it", async () => {
    const t = await ready();
    const id = await openAgent(t);
    const claimSeq = await take(t, id, A);
    await t.run((ctx) => lab.resolve(ctx, { queue: "agent", ticketId: id, actor: A, claimSeq, resolution: "completed", result: { ok: true } }));

    expect(await say(t, id, REQ, "thank you")).toMatchObject({ resumed: false, duplicate: false });
    const after = await detail(t, id);
    expect(after.ticket).toMatchObject({ category: "done", resolution: "completed", messageCount: 1 });
    expect(after.ticket.closedAt).toBeUndefined();
    expect(after.messages.map((m) => m.body)).toEqual(["thank you"]);
    expect(await historyTypes(t, id)).toEqual(["opened", "claimed", "resolved"]);
    await expectCode(replyRaw(t, { ticketId: id, actor: REQ, body: "and more", fields: { note: "x" } }), "FIELDS_NOT_ACCEPTED");
  });

  test("a reply on a sealed ticket is SEALED", async () => {
    const t = await ready();
    const id = await openSealed(t);
    expect((await detail(t, id)).ticket.closedAt).toBeDefined();

    await expectCode(
      t.run((ctx) => lab.reply(ctx, { ticketId: id, actor: REQ, body: "too late" })),
      "SEALED",
    );
    expect((await detail(t, id)).ticket.messageCount).toBe(0);
  });
});

describe("reply idempotency", () => {
  test("a repeated idempotency key returns the first message with duplicate true and writes nothing", async () => {
    const t = await ready();
    const id = await openAgent(t);
    await take(t, id, A);
    const send = () => t.run(async (ctx) => accepted(await lab.reply(ctx, { ticketId: id, actor: A, body: "once", idempotencyKey: "k1" })));

    const first = await send();
    const before = (await history(t, id)).length;
    const second = await send();

    expect(first.duplicate).toBe(false);
    expect(second).toEqual({ ok: true, messageId: first.messageId, resumed: false, duplicate: true });
    expect((await thread(t, id)).map((m) => m.body)).toEqual(["once"]);
    expect((await detail(t, id)).ticket.messageCount).toBe(1);
    expect((await history(t, id)).length).toBe(before);
  });

  test("repeating the answering reply does not resume or write a second time", async () => {
    const t = await ready();
    const id = await openAgent(t);
    const claimSeq = await take(t, id, A);
    await t.run((ctx) => lab.requestInput(ctx, { queue: "agent", ticketId: id, actor: A, claimSeq, body: "Which?", fields: ["note"] }));
    const answer = () =>
      t.run(async (ctx) => accepted(await lab.reply(ctx, { queue: "agent", ticketId: id, actor: REQ, body: "this", fields: { note: "n" }, idempotencyKey: "ans" })));

    const first = await answer();
    const second = await answer();

    expect(first).toMatchObject({ resumed: true, duplicate: false });
    expect(second).toEqual({ ok: true, messageId: first.messageId, resumed: false, duplicate: true });
    expect((await historyTypes(t, id)).filter((type) => type === "input_provided")).toHaveLength(1);
    expect((await detail(t, id)).ticket.messageCount).toBe(2);
  });
});

describe("message cap, rate limit and body size", () => {
  test("at maxMessages the reply returns MESSAGE_LIMIT and escalates, and a second refused reply does not escalate again", async () => {
    const t = await readyWith(chat);
    const id = await t.run((ctx) => chat.open(ctx, { queue: "talk", actor: REQ, title: "chatty" }));
    await say(t, id, A, "one");
    await say(t, id, A, "two");
    await say(t, id, A, "three");
    expect((await detail(t, id)).ticket).toMatchObject({ queue: "talk", messageCount: 3 });

    const refused = await t.run((ctx) => chat.reply(ctx, { ticketId: id, actor: A, body: "four" }));
    expect(refused).toEqual({ ok: false, reason: "MESSAGE_LIMIT", escalated: true });

    const escalated = await detail(t, id);
    expect(escalated.ticket).toMatchObject({ queue: "humans", state: "new", category: "unstarted", priority: 1, messageCount: 3 });
    expect(escalated.ticket.escalatedAt).toBeDefined();
    expect(escalated.messages.map((m) => m.body)).toEqual(["one", "two", "three"]);
    const trail = await history(t, id);
    expect(trail.at(-1)).toMatchObject({ type: "escalated", actorRef: SYSTEM_PARTY.ref, fromQueue: "talk", toQueue: "humans", reason: "message limit of 3 reached" });

    const again = await t.run((ctx) => chat.reply(ctx, { ticketId: id, actor: B, body: "five" }));
    expect(again).toEqual({ ok: false, reason: "MESSAGE_LIMIT", escalated: false });
    expect(await historyTypes(t, id)).toEqual(["opened", "escalated"]);
    expect((await detail(t, id)).ticket.priority).toBe(1);
    expect(await eventTypes(t, id)).toEqual(["opened", "escalated"]);
  });

  test("a queue with no escalation target refuses the reply at the cap and the ticket stays put", async () => {
    const t = await readyWith(chat);
    const id = await t.run((ctx) => chat.open(ctx, { queue: "solo", actor: REQ, title: "no escape" }));
    expect(await say(t, id, A, "one")).toMatchObject({ resumed: false });
    expect(await say(t, id, A, "two")).toMatchObject({ resumed: false });

    const refused = await t.run((ctx) => chat.reply(ctx, { ticketId: id, actor: A, body: "three" }));
    expect(refused).toEqual({ ok: false, reason: "MESSAGE_LIMIT", escalated: false });
    expect((await detail(t, id)).ticket).toMatchObject({ queue: "solo", category: "unstarted", messageCount: 2 });
    expect(await historyTypes(t, id)).toEqual(["opened"]);
  });

  test("a refused reply on a resolved ticket does not escalate it", async () => {
    const t = await readyWith(chat);
    const id = await t.run((ctx) => chat.open(ctx, { queue: "talk", actor: REQ, title: "done and capped" }));
    const claimSeq = await take(t, id, A);
    await say(t, id, A, "one");
    await say(t, id, A, "two");
    await say(t, id, A, "three");
    await t.run((ctx) => chat.resolve(ctx, { queue: "talk", ticketId: id, actor: A, claimSeq, resolution: "completed" }));

    const refused = await t.run((ctx) => chat.reply(ctx, { ticketId: id, actor: REQ, body: "thanks" }));
    expect(refused).toEqual({ ok: false, reason: "MESSAGE_LIMIT", escalated: false });
    expect((await detail(t, id)).ticket).toMatchObject({ queue: "talk", category: "done" });
  });

  test("a party over messagesPerMinute gets RATE_LIMITED with a retry time, others are not affected and the limit refills", async () => {
    const t = await readyWith(chat);
    const id = await t.run((ctx) => chat.open(ctx, { queue: "plain", actor: REQ, title: "rate" }));
    for (const body of ["m1", "m2", "m3", "m4", "m5"]) await say(t, id, A, body);

    const error = await caught(say(t, id, A, "m6"));
    expect(isTicketsError(error, "RATE_LIMITED")).toBe(true);
    expect(retryAtOf(error)).toBeGreaterThan(Date.now());
    expect(retryAtOf(error)).toBeLessThanOrEqual(Date.now() + MINUTE);
    expect((await detail(t, id)).ticket.messageCount).toBe(5);

    expect(await say(t, id, B, "from b")).toMatchObject({ duplicate: false });

    await drain(t, MINUTE);
    expect(await say(t, id, A, "m7")).toMatchObject({ duplicate: false });
  });

  test("a retried idempotent reply at the rate limit returns the first message instead of RATE_LIMITED", async () => {
    const t = await readyWith(chat);
    const id = await t.run((ctx) => chat.open(ctx, { queue: "plain", actor: REQ, title: "retry" }));
    const keyed = () => t.run(async (ctx) => accepted(await chat.reply(ctx, { ticketId: id, actor: A, body: "last", idempotencyKey: "last" })));
    for (const body of ["m1", "m2", "m3", "m4"]) await say(t, id, A, body);
    const first = await keyed();

    await expectCode(say(t, id, A, "m6"), "RATE_LIMITED");
    expect(await keyed()).toEqual({ ok: true, messageId: first.messageId, resumed: false, duplicate: true });
  });

  test("a reply body at maxBodyChars is accepted and one character more is TOO_LONG", async () => {
    const t = await readyWith(chat);
    const id = await t.run((ctx) => chat.open(ctx, { queue: "plain", actor: REQ, title: "long" }));
    const claimSeq = await take(t, id, A);

    await say(t, id, A, "x".repeat(10));
    await expectCode(say(t, id, A, "x".repeat(11)), "TOO_LONG");
    await expectCode(
      t.run((ctx) => chat.requestInput(ctx, { queue: "plain", ticketId: id, actor: A, claimSeq, body: "y".repeat(11) })),
      "TOO_LONG",
    );
    expect((await detail(t, id)).ticket).toMatchObject({ category: "started", messageCount: 1 });

    const asked = await t.run((ctx) => chat.requestInput(ctx, { queue: "plain", ticketId: id, actor: A, claimSeq, body: "y".repeat(10) }));
    expect(asked.category).toBe("waiting");
  });
});

describe("blockers: counter, claim-next and events", () => {
  test("claim-next skips a ticket with three blockers until the third completes, and a direct claim gets BLOCKED", async () => {
    const t = await ready();
    const b1 = await openProj(t, "b1");
    const b2 = await openProj(t, "b2");
    const b3 = await openProj(t, "b3");
    const dependent = await openProj(t, "dependent", { blockedBy: [b1, b2, b3] });
    const free = await openProj(t, "free");
    expect((await detail(t, dependent)).ticket).toMatchObject({ category: "unstarted", openBlockers: 3 });

    const s1 = await take(t, b1, A);
    const s2 = await take(t, b2, B);
    const s3 = await take(t, b3, C);
    const next = () => t.run((ctx) => lab.claim(ctx, { actor: HUMAN, queue: "proj" }));
    const direct = () => t.run((ctx) => lab.claim(ctx, { actor: HUMAN, ticketId: dependent }));

    expect(await next()).toMatchObject({ ok: true, ticketId: free });
    expect(await next()).toEqual({ ok: false, reason: "EMPTY" });
    expect(await direct()).toEqual({ ok: false, reason: "BLOCKED", ticketId: dependent });

    await t.run((ctx) => lab.resolve(ctx, { ticketId: b1, actor: A, claimSeq: s1, resolution: "completed" }));
    expect(await counter(t, dependent)).toBe(2);
    expect(await next()).toEqual({ ok: false, reason: "EMPTY" });

    await t.run((ctx) => lab.resolve(ctx, { ticketId: b2, actor: B, claimSeq: s2, resolution: "completed" }));
    expect(await counter(t, dependent)).toBe(1);
    expect(await next()).toEqual({ ok: false, reason: "EMPTY" });
    expect(await direct()).toEqual({ ok: false, reason: "BLOCKED", ticketId: dependent });
    expect(await eventTypes(t, dependent)).toEqual(["opened"]);

    await t.run((ctx) => lab.resolve(ctx, { ticketId: b3, actor: C, claimSeq: s3, resolution: "completed" }));
    expect((await detail(t, dependent)).ticket).toMatchObject({ category: "unstarted", openBlockers: 0 });
    expect(await next()).toMatchObject({ ok: true, ticketId: dependent });
  });

  test("the unblocked event fires once, at zero, for a dependent nobody holds", async () => {
    const t = await ready();
    const b1 = await openProj(t, "b1");
    const b2 = await openProj(t, "b2");
    const dependent = await openProj(t, "dependent", { blockedBy: [b1, b2] });

    await complete(t, b1);
    expect(await eventTypes(t, dependent)).toEqual(["opened"]);
    await complete(t, b2);

    expect(await eventTypes(t, dependent)).toEqual(["opened", "unblocked"]);
    const unblocked = (await events(t)).find((row) => row.ticketId === dependent && row.type === "unblocked");
    expect(unblocked).toMatchObject({ blocked: false, category: "unstarted", actorRef: SYSTEM_PARTY.ref });
    expect(await historyTypes(t, dependent)).toEqual(["opened", "unblocked"]);
  });

  test("a dependent in the backlog gets unblocked at zero and stays in the backlog", async () => {
    const t = await ready();
    const blocker = await openProj(t, "blocker");
    const dependent = await openProj(t, "planned", { to: "backlog", blockedBy: [blocker] });
    expect((await detail(t, dependent)).ticket).toMatchObject({ category: "backlog", openBlockers: 1 });

    await complete(t, blocker);

    expect((await detail(t, dependent)).ticket).toMatchObject({ category: "backlog", state: "backlog", openBlockers: 0 });
    expect(await eventTypes(t, dependent)).toEqual(["opened", "unblocked"]);
  });

  test("open with blockedBy counts only blockers that are not completed yet and ignores repeats", async () => {
    const t = await ready();
    const finished = await openProj(t, "finished");
    const pending = await openProj(t, "pending");
    await complete(t, finished);

    const dependent = await openProj(t, "dependent", { blockedBy: [finished, pending, pending] });
    const view = await detail(t, dependent);
    expect(view.ticket.openBlockers).toBe(1);
    expect(view.blockers.map((b) => [b.ticketId, b.completed]).sort()).toEqual([[finished, true], [pending, false]].sort());
    await drain(t);
    expect((await events(t)).find((row) => row.ticketId === dependent && row.type === "opened")).toMatchObject({ blocked: true });

    const clear = await openProj(t, "clear", { blockedBy: [finished] });
    expect(await counter(t, clear)).toBe(0);
    expect(await t.run((ctx) => lab.claim(ctx, { actor: HUMAN, ticketId: clear }))).toMatchObject({ ok: true });
  });

  test("a blocker linked to a started ticket raises its counter without stopping its work", async () => {
    const t = await ready();
    const worker = await openProj(t, "worker");
    const blocker = await openProj(t, "late blocker");
    const claimSeq = await take(t, worker, A);

    await block(t, blocker, worker);
    expect((await detail(t, worker)).ticket).toMatchObject({ category: "started", openBlockers: 1 });
    expect(await t.run((ctx) => lab.move(ctx, { ticketId: worker, actor: A, claimSeq, to: "in_review" }))).toMatchObject({ state: "in_review" });

    await complete(t, blocker, HUMAN);
    expect((await detail(t, worker)).ticket).toMatchObject({ category: "started", state: "in_review", openBlockers: 0 });
  });

  test("get returns each blocker with its state and completed flag, and the links of each ticket", async () => {
    const t = await ready();
    const finished = await openProj(t, "finished");
    const pending = await openProj(t, "pending");
    const canceled = await openProj(t, "canceled");
    const failed = await openProj(t, "failed");
    const dependent = await openProj(t, "dependent", { blockedBy: [finished, pending, canceled, failed] });
    await label(t, dependent, "bug");
    await complete(t, finished);
    await endBlocker(t, canceled, "canceled");
    await endBlocker(t, failed, "failed");

    const view = await detail(t, dependent);
    const flags = (ticketId: string) => view.blockers.find((b) => b.ticketId === ticketId);
    expect(flags(finished)).toMatchObject({ category: "done", resolution: "completed", completed: true });
    expect(flags(pending)).toMatchObject({ category: "unstarted", completed: false });
    expect(flags(canceled)).toMatchObject({ category: "canceled", completed: false });
    expect(flags(failed)).toMatchObject({ category: "done", resolution: "failed", completed: false });
    expect(view.blockers).toHaveLength(4);
    expect(view.ticket.openBlockers).toBe(3);
    expect(view.links.map((l) => [l.relation, l.refKind, l.ref])).toEqual([["ref", "label", "bug"]]);

    const outgoing = (await detail(t, finished)).links;
    expect(outgoing).toMatchObject([{ relation: "blocks", ticketId: finished, toTicketId: dependent, createdByRef: LEAD.ref }]);
    expect(flags(finished)?.linkId).toBe(outgoing.at(0)?.linkId);
  });
});

describe("blockers that end without completing", () => {
  test.each(["canceled", "failed", "rejected"] as const)(
    "a blocker that ends as %s clears nothing, tells the dependent with blocker_failed and keeps it blocked",
    async (how) => {
      const t = await ready();
      const blocker = await openProj(t, "blocker");
      const dependent = await openProj(t, "dependent", { blockedBy: [blocker] });

      await endBlocker(t, blocker, how);

      expect((await detail(t, dependent)).ticket).toMatchObject({ category: "unstarted", openBlockers: 1 });
      expect(await t.run((ctx) => lab.claim(ctx, { actor: HUMAN, ticketId: dependent }))).toEqual({ ok: false, reason: "BLOCKED", ticketId: dependent });
      expect(await t.run((ctx) => lab.claim(ctx, { actor: HUMAN, queue: "proj" }))).toEqual({ ok: false, reason: "EMPTY" });
      const trail = await history(t, dependent);
      expect(trail.map((row) => row.type)).toEqual(["opened", "blocker_failed"]);
      expect(trail.at(-1)?.reason).toBe(`blocker ${blocker} ended as ${how}`);
      expect(trail.at(-1)?.actorRef).toBe(SYSTEM_PARTY.ref);
      expect(await eventTypes(t, dependent)).toEqual(["opened", "blocker_failed"]);
    },
  );

  test("a dependent whose blocker failed becomes claimable again once the blocker is reopened and completed", async () => {
    const t = await ready();
    const blocker = await openProj(t, "blocker");
    const dependent = await openProj(t, "dependent", { blockedBy: [blocker] });
    await endBlocker(t, blocker, "canceled");

    await reopenTicket(t, blocker);
    expect(await counter(t, dependent)).toBe(1);
    await complete(t, blocker, HUMAN);

    expect((await detail(t, dependent)).ticket.openBlockers).toBe(0);
    expect(await historyTypes(t, dependent)).toEqual(["opened", "blocker_failed", "unblocked"]);
    expect(await t.run((ctx) => lab.claim(ctx, { actor: HUMAN, ticketId: dependent }))).toMatchObject({ ok: true });
  });

  test("a dependent whose blocker was canceled becomes claimable again once the link is removed", async () => {
    const t = await ready();
    const blocker = await openProj(t, "blocker");
    const dependent = await openProj(t, "dependent", { blockedBy: [blocker] });
    await endBlocker(t, blocker, "canceled");
    const linkId = must((await detail(t, dependent)).blockers.at(0), "blocker link").linkId;

    await t.run((ctx) => lab.unlink(ctx, { linkId }));

    expect((await detail(t, dependent)).ticket.openBlockers).toBe(0);
    expect(await historyTypes(t, dependent)).toEqual(["opened", "blocker_failed", "unblocked"]);
    expect(await t.run((ctx) => lab.claim(ctx, { actor: HUMAN, ticketId: dependent }))).toMatchObject({ ok: true });
  });
});

describe("a held dependent waiting on blockers", () => {
  test("resumes by itself when the last blocker completes, back to started with a restarted lease", async () => {
    const t = await ready();
    const blocker = await openPeople(t);
    const id = await openAgent(t);
    const claimSeq = await take(t, id, A);
    await hold(t, id, A, claimSeq, { blockers: [blocker] });

    const held = await detail(t, id);
    expect(held.ticket).toMatchObject({ category: "waiting", waitingOn: "blockers", openBlockers: 1, assigneeRef: A.ref });
    expect(held.leaseExpiresAt).toBeUndefined();

    await drain(t, 2 * MINUTE);
    await complete(t, blocker, HUMAN);

    const resumed = await detail(t, id);
    expect(resumed.ticket).toMatchObject({ state: "working", category: "started", openBlockers: 0, assigneeRef: A.ref, claimSeq });
    expect(resumed.ticket.waitingOn).toBeUndefined();
    expect(resumed.leaseExpiresAt).toBe((await lastTransitionAt(t, id)) + 5 * MINUTE);
    expect(await historyTypes(t, id)).toEqual(["opened", "claimed", "held", "resumed"]);
    expect(await eventTypes(t, id)).toEqual(["opened", "claimed", "held", "resumed"]);

    const done = await t.run((ctx) => lab.resolve(ctx, { queue: "agent", ticketId: id, actor: A, claimSeq, resolution: "completed", result: { ok: true } }));
    expect(done.category).toBe("done");
  });

  test("stays waiting while any blocker is still open", async () => {
    const t = await ready();
    const first = await openPeople(t);
    const second = await openPeople(t);
    const id = await openPeople(t);
    const claimSeq = await take(t, id, A);
    await hold(t, id, A, claimSeq, { blockers: [first, second] });
    expect((await detail(t, id)).ticket).toMatchObject({ category: "waiting", waitingOn: "blockers", openBlockers: 2 });

    await complete(t, first, HUMAN);
    expect((await detail(t, id)).ticket).toMatchObject({ category: "waiting", openBlockers: 1 });
    await complete(t, second, HUMAN);
    expect((await detail(t, id)).ticket).toMatchObject({ category: "started", openBlockers: 0 });
  });

  test.each(["canceled", "failed", "rejected"] as const)(
    "resumes at once with blocker_failed when its blocker ends as %s, and still counts that blocker as open",
    async (how) => {
      const t = await ready();
      const blocker = await openPeople(t);
      const id = await openAgent(t);
      const claimSeq = await take(t, id, A);
      await hold(t, id, A, claimSeq, { blockers: [blocker] });

      await endBlocker(t, blocker, how);

      const after = await detail(t, id);
      expect(after.ticket).toMatchObject({ state: "working", category: "started", openBlockers: 1, assigneeRef: A.ref, claimSeq });
      expect(after.ticket.waitingOn).toBeUndefined();
      expect(after.leaseExpiresAt).toBe((await lastTransitionAt(t, id)) + 5 * MINUTE);
      expect(await historyTypes(t, id)).toEqual(["opened", "claimed", "held", "blocker_failed", "resumed"]);
      expect(await eventTypes(t, id)).toEqual(["opened", "claimed", "held", "blocker_failed", "resumed"]);
    },
  );

  test("resumes when the last open blocker link is removed", async () => {
    const t = await ready();
    const blocker = await openPeople(t);
    const id = await openPeople(t);
    const claimSeq = await take(t, id, A);
    await hold(t, id, A, claimSeq, { blockers: [blocker] });
    const linkId = must((await detail(t, id)).blockers.at(0), "blocker link").linkId;

    await t.run((ctx) => lab.unlink(ctx, { linkId }));

    expect((await detail(t, id)).ticket).toMatchObject({ category: "started", openBlockers: 0 });
    expect(await historyTypes(t, id)).toEqual(["opened", "claimed", "held", "resumed"]);
  });
});

describe("hold", () => {
  test("hold with blockers adds the links and waits on them", async () => {
    const t = await ready();
    const first = await openPeople(t);
    const second = await openPeople(t);
    const id = await openPeople(t);
    const claimSeq = await take(t, id, A);

    const held = await t.run((ctx) => lab.hold(ctx, { ticketId: id, actor: A, claimSeq, blockers: [first, second], reason: "needs two approvals" }));

    expect(held).toMatchObject({ queue: "people", state: "waiting", category: "waiting", claimSeq });
    const view = await detail(t, id);
    expect(view.ticket).toMatchObject({ waitingOn: "blockers", openBlockers: 2, assigneeRef: A.ref });
    expect(view.blockers.map((b) => b.ticketId).sort()).toEqual([first, second].sort());
    expect((await history(t, id)).at(-1)).toMatchObject({ type: "held", reason: "needs two approvals", toState: "waiting" });
  });

  test("hold in a desk queue lands on on_hold when it waits on blockers", async () => {
    const t = await ready();
    const blocker = await openPeople(t);
    const id = await openDesk(t);
    const claimSeq = await take(t, id, A);

    expect(await hold(t, id, A, claimSeq, { blockers: [blocker] })).toMatchObject({ state: "on_hold", category: "waiting" });
    expect((await detail(t, id)).ticket).toMatchObject({ waitingOn: "blockers", openBlockers: 1 });
  });

  test("hold counts a blocker once when it is listed twice or is already linked", async () => {
    const t = await ready();
    const linked = await openPeople(t);
    const fresh = await openPeople(t);
    const id = await openPeople(t);
    const claimSeq = await take(t, id, A);
    await block(t, linked, id);
    expect(await counter(t, id)).toBe(1);

    await hold(t, id, A, claimSeq, { blockers: [linked, fresh, fresh] });

    const view = await detail(t, id);
    expect(view.ticket.openBlockers).toBe(2);
    expect(view.blockers).toHaveLength(2);
  });

  test("hold with only completed blockers is NOT_BLOCKED and changes nothing", async () => {
    const t = await ready();
    const finished = await openPeople(t);
    await complete(t, finished, HUMAN);
    const id = await openPeople(t);
    const claimSeq = await take(t, id, A);

    await expectCode(hold(t, id, A, claimSeq, { blockers: [finished] }), "NOT_BLOCKED");
    await expectCode(hold(t, id, A, claimSeq, { waitingOn: "blockers" }), "NOT_BLOCKED");

    const view = await detail(t, id);
    expect(view.ticket).toMatchObject({ category: "started", openBlockers: 0 });
    expect(view.blockers).toEqual([]);
  });

  test("hold with a completed and an open blocker waits on the open one only", async () => {
    const t = await ready();
    const finished = await openPeople(t);
    await complete(t, finished, HUMAN);
    const open = await openPeople(t);
    const id = await openPeople(t);
    const claimSeq = await take(t, id, A);

    await hold(t, id, A, claimSeq, { blockers: [finished, open] });

    const view = await detail(t, id);
    expect(view.ticket).toMatchObject({ category: "waiting", waitingOn: "blockers", openBlockers: 1 });
    expect(view.blockers.find((b) => b.ticketId === finished)?.completed).toBe(true);
  });

  test("hold with waitingOn blockers waits on blockers that are already linked, and resumes when they complete", async () => {
    const t = await ready();
    const blocker = await openPeople(t);
    const id = await openPeople(t);
    const claimSeq = await take(t, id, A);
    await block(t, blocker, id);

    const held = await hold(t, id, A, claimSeq, { waitingOn: "blockers" });

    expect(held).toMatchObject({ category: "waiting" });
    expect((await detail(t, id)).ticket).toMatchObject({ waitingOn: "blockers", openBlockers: 1 });
    await complete(t, blocker, HUMAN);
    expect((await detail(t, id)).ticket).toMatchObject({ category: "started", openBlockers: 0 });
  });

  test("hold without blockers waits on something outside until the holder resumes", async () => {
    const t = await ready();
    const id = await openPeople(t);
    const claimSeq = await take(t, id, A);

    expect(await hold(t, id, A, claimSeq)).toMatchObject({ state: "waiting", category: "waiting" });
    expect((await detail(t, id)).ticket).toMatchObject({ waitingOn: "external", openBlockers: 0, assigneeRef: A.ref });

    await drain(t, 2 * DAY);
    expect((await detail(t, id)).ticket).toMatchObject({ category: "waiting", waitingOn: "external", assigneeRef: A.ref });

    const resumed = await t.run((ctx) => lab.resume(ctx, { ticketId: id, actor: A, claimSeq }));
    expect(resumed).toMatchObject({ state: "working", category: "started" });
    expect(await historyTypes(t, id)).toEqual(["opened", "claimed", "held", "resumed"]);
  });

  test("hold without blockers can be resumed by a trusted host call", async () => {
    const t = await ready();
    const id = await openPeople(t);
    const claimSeq = await take(t, id, A);
    await hold(t, id, A, claimSeq);

    const resumed = await t.run((ctx) => lab.resume(ctx, { ticketId: id, actor: LEAD, trusted: true }));

    expect(resumed).toMatchObject({ category: "started", claimSeq });
    expect((await detail(t, id)).ticket).toMatchObject({ assigneeRef: A.ref });
    expect((await history(t, id)).at(-1)).toMatchObject({ type: "resumed", actorRef: LEAD.ref });
  });

  test("hold and resume are refused for a non-holder and a stale claimSeq, and resume needs a claimSeq unless trusted", async () => {
    const t = await ready();
    const id = await openPeople(t);
    const claimSeq = await take(t, id, A);

    await expectCode(hold(t, id, B, claimSeq), "NOT_HOLDER");
    await expectCode(hold(t, id, A, claimSeq - 1), "CLAIM_LOST");
    expect((await detail(t, id)).ticket.category).toBe("started");

    await hold(t, id, A, claimSeq);
    await expectCode(t.run((ctx) => lab.resume(ctx, { ticketId: id, actor: B, claimSeq })), "NOT_HOLDER");
    await expectCode(t.run((ctx) => lab.resume(ctx, { ticketId: id, actor: A, claimSeq: claimSeq - 1 })), "CLAIM_LOST");
    await expectCode(t.run((ctx) => lab.resume(ctx, { ticketId: id, actor: A })), "INVALID_ARGUMENT");
    expect((await detail(t, id)).ticket).toMatchObject({ category: "waiting", waitingOn: "external" });
  });

  test("hold on a ticket that is not started is INVALID_MOVE", async () => {
    const t = await ready();
    const id = await openPeople(t);

    await expectCode(hold(t, id, A, 0), "INVALID_MOVE");
  });
});

describe("the cycle check", () => {
  test("a direct cycle is refused with CYCLE and nothing is written", async () => {
    const t = await ready();
    const a = await openProj(t, "a");
    const b = await openProj(t, "b");
    await block(t, a, b);

    await expectCode(block(t, b, a), "CYCLE");

    expect((await detail(t, a)).blockers).toEqual([]);
    expect(await counter(t, a)).toBe(0);
    expect(await counter(t, b)).toBe(1);
  });

  test("a ticket cannot block itself through link", async () => {
    const t = await ready();
    const a = await openProj(t, "a");

    await expectCode(block(t, a, a), "CYCLE");

    expect((await detail(t, a)).links).toEqual([]);
    expect(await counter(t, a)).toBe(0);
  });

  test("a longer chain refuses the link that closes it, and a diamond that does not close it is allowed", async () => {
    const t = await ready();
    const a = await openProj(t, "a");
    const b = await openProj(t, "b");
    const c = await openProj(t, "c");
    const d = await openProj(t, "d");
    await block(t, a, b);
    await block(t, b, c);
    await block(t, c, d);

    await expectCode(block(t, d, a), "CYCLE");
    await expectCode(block(t, d, b), "CYCLE");
    await expectCode(block(t, c, a), "CYCLE");
    expect(await counter(t, a)).toBe(0);

    await block(t, a, d);
    expect(await counter(t, d)).toBe(2);
  });

  test("hold with a blocker that is itself waiting on the holder is CYCLE", async () => {
    const t = await ready();
    const id = await openPeople(t);
    const claimSeq = await take(t, id, A);
    const downstream = await t.run((ctx) => lab.open(ctx, { queue: "people", actor: REQ, title: "downstream", blockedBy: [id] }));

    await expectCode(hold(t, id, A, claimSeq, { blockers: [downstream] }), "CYCLE");

    const view = await detail(t, id);
    expect(view.ticket).toMatchObject({ category: "started", openBlockers: 0 });
    expect(view.blockers).toEqual([]);
  });
});

describe("blocker caps with small limits", () => {
  const openG = (t: T, title: string, blockedBy?: string[]) =>
    t.run((ctx) => graph.open(ctx, { queue: "g", actor: LEAD, title, blockedBy }));
  const ticketCount = async (t: T) => {
    const page = await t.run((ctx) => lab.list(ctx, { filter: { by: "queue", queue: "g" }, paginationOpts: PAGE }));
    return page.page.length;
  };

  test("a ticket may have maxBlockers blockers and one more is TOO_MANY_BLOCKERS, through link and through open", async () => {
    const t = await readyWith(graph);
    const b1 = await openG(t, "b1");
    const b2 = await openG(t, "b2");
    const b3 = await openG(t, "b3");

    const atLimit = await openG(t, "at the limit", [b1, b2]);
    expect(await counter(t, atLimit)).toBe(2);

    await expectCode(block(t, b3, atLimit), "TOO_MANY_BLOCKERS");
    expect((await detail(t, atLimit)).blockers).toHaveLength(2);
    expect(await counter(t, atLimit)).toBe(2);

    const before = await ticketCount(t);
    await expectCode(openG(t, "one past", [b1, b2, b3]), "TOO_MANY_BLOCKERS");
    expect(await ticketCount(t)).toBe(before);
  });

  test("hold may add blockers up to maxBlockers and refuses a list past it without writing any link", async () => {
    const t = await readyWith(graph);
    const b1 = await openG(t, "b1");
    const b2 = await openG(t, "b2");
    const b3 = await openG(t, "b3");
    const openW = (title: string) => t.run((ctx) => graph.open(ctx, { queue: "w", actor: LEAD, title }));
    const past = await openW("past");
    const pastSeq = await take(t, past, A);
    const atLimit = await openW("at the limit");
    const limitSeq = await take(t, atLimit, A);

    await expectCode(hold(t, past, A, pastSeq, { blockers: [b1, b2, b3] }), "TOO_MANY_BLOCKERS");
    const refused = await detail(t, past);
    expect(refused.ticket).toMatchObject({ category: "started", openBlockers: 0 });
    expect(refused.blockers).toEqual([]);

    expect(await hold(t, atLimit, A, limitSeq, { blockers: [b1, b2] })).toMatchObject({ category: "waiting" });
    expect(await counter(t, atLimit)).toBe(2);
  });

  test("a ticket may block maxBlocked others and one more is TOO_MANY_BLOCKED, through link and through open", async () => {
    const t = await readyWith(graph);
    const blocker = await openG(t, "blocker");
    const first = await openG(t, "first", [blocker]);
    const second = await openG(t, "second", [blocker]);
    const third = await openG(t, "third");
    expect(await counter(t, first)).toBe(1);
    expect(await counter(t, second)).toBe(1);

    await expectCode(block(t, blocker, third), "TOO_MANY_BLOCKED");
    expect(await counter(t, third)).toBe(0);

    const before = await ticketCount(t);
    await expectCode(openG(t, "fourth", [blocker]), "TOO_MANY_BLOCKED");
    expect(await ticketCount(t)).toBe(before);
  });

  test("the upstream walk allows a chain of maxGraphWalk tickets and one more is GRAPH_TOO_DEEP", async () => {
    const t = await readyWith(graph);
    const x1 = await openG(t, "x1");
    const x2 = await openG(t, "x2");
    const x3 = await openG(t, "x3");
    const y = await openG(t, "y");
    const y2 = await openG(t, "y2");
    const z = await openG(t, "z");
    await block(t, x1, x2);
    await block(t, x2, x3);

    await block(t, x3, y);
    expect(await counter(t, y)).toBe(1);

    await block(t, z, x1);
    await expectCode(block(t, x3, y2), "GRAPH_TOO_DEEP");
    expect(await counter(t, y2)).toBe(0);
  });
});

describe("link and unlink on blocks", () => {
  test("linking the same blocks pair again returns the same link id and counts the blocker once", async () => {
    const t = await ready();
    const blocker = await openProj(t, "blocker");
    const dependent = await openProj(t, "dependent");
    const viaOpen = await openProj(t, "via open", { blockedBy: [blocker] });

    const first = await block(t, blocker, dependent);
    expect(await block(t, blocker, dependent)).toBe(first);
    expect(await counter(t, dependent)).toBe(1);
    expect((await detail(t, dependent)).blockers).toHaveLength(1);

    const openLink = must((await detail(t, viaOpen)).blockers.at(0), "open link").linkId;
    expect(await block(t, blocker, viaOpen)).toBe(openLink);
    expect(await counter(t, viaOpen)).toBe(1);
  });

  test("link to a sealed blocked ticket is SEALED", async () => {
    const t = await ready();
    const sealed = await openSealed(t);
    const other = await openProj(t, "other");

    await expectCode(block(t, other, sealed), "SEALED");
    await expectCode(linkTo(t, sealed, "relates", other), "SEALED");
    await expectCode(label(t, sealed, "bug"), "SEALED");
    expect((await detail(t, sealed)).links).toEqual([]);
  });

  test("unlink of a blocks link lowers the counter and unblocks the dependent at zero", async () => {
    const t = await ready();
    const first = await openProj(t, "first");
    const second = await openProj(t, "second");
    const dependent = await openProj(t, "dependent", { blockedBy: [first, second] });
    const links = (await detail(t, dependent)).blockers;
    const linkOf = (ticketId: string) => must(links.find((b) => b.ticketId === ticketId), `link of ${ticketId}`).linkId;

    await t.run((ctx) => lab.unlink(ctx, { linkId: linkOf(first) }));
    expect(await counter(t, dependent)).toBe(1);
    expect(await eventTypes(t, dependent)).toEqual(["opened"]);

    await t.run((ctx) => lab.unlink(ctx, { linkId: linkOf(second) }));
    expect(await counter(t, dependent)).toBe(0);
    expect(await eventTypes(t, dependent)).toEqual(["opened", "unblocked"]);
    expect(await t.run((ctx) => lab.claim(ctx, { actor: HUMAN, ticketId: dependent }))).toMatchObject({ ok: true });
  });

  test("unlink of a link whose blocker already completed leaves the counter alone, and a second unlink is NOT_FOUND", async () => {
    const t = await ready();
    const finished = await openProj(t, "finished");
    const open = await openProj(t, "open");
    const dependent = await openProj(t, "dependent", { blockedBy: [finished, open] });
    await complete(t, finished);
    expect(await counter(t, dependent)).toBe(1);
    const linkId = must((await detail(t, dependent)).blockers.find((b) => b.ticketId === finished), "finished link").linkId;

    await t.run((ctx) => lab.unlink(ctx, { linkId }));
    expect(await counter(t, dependent)).toBe(1);
    expect((await detail(t, dependent)).blockers.map((b) => b.ticketId)).toEqual([open]);

    await expectCode(t.run((ctx) => lab.unlink(ctx, { linkId })), "NOT_FOUND");
  });

  test("reopening a completed blocker re-blocks its dependents until it completes again", async () => {
    const t = await ready();
    const blocker = await openProj(t, "blocker");
    const first = await openProj(t, "first", { blockedBy: [blocker] });
    const second = await openProj(t, "second", { blockedBy: [blocker] });
    await complete(t, blocker);
    expect(await counter(t, first)).toBe(0);
    expect(await counter(t, second)).toBe(0);

    await t.run((ctx) => lab.reopen(ctx, { ticketId: blocker, actor: LEAD }));

    expect(await counter(t, first)).toBe(1);
    expect(await counter(t, second)).toBe(1);
    expect(await t.run((ctx) => lab.claim(ctx, { actor: HUMAN, ticketId: first }))).toEqual({ ok: false, reason: "BLOCKED", ticketId: first });

    await complete(t, blocker, HUMAN);
    expect(await counter(t, first)).toBe(0);
    expect(await counter(t, second)).toBe(0);
    expect(await t.run((ctx) => lab.claim(ctx, { actor: HUMAN, ticketId: first }))).toMatchObject({ ok: true });
  });
});

describe("links other than blocks", () => {
  test("duplicates and relates links are stored once, listed on the source ticket and never block anything", async () => {
    const t = await ready();
    const a = await openProj(t, "a");
    const b = await openProj(t, "b");

    const related = await linkTo(t, a, "relates", b);
    const duplicate = await linkTo(t, a, "duplicates", b);
    expect(await linkTo(t, a, "relates", b)).toBe(related);
    expect(await linkTo(t, a, "duplicates", b)).toBe(duplicate);
    expect(duplicate).not.toBe(related);

    const view = await detail(t, a);
    expect(view.links.map((l) => [l.relation, l.toTicketId, l.createdByRef]).sort()).toEqual(
      [
        ["duplicates", b, LEAD.ref],
        ["relates", b, LEAD.ref],
      ].sort(),
    );
    expect(view.ticket.openBlockers).toBe(0);
    expect((await detail(t, b)).blockers).toEqual([]);
    expect(await counter(t, b)).toBe(0);
    expect(await t.run((ctx) => lab.claim(ctx, { actor: HUMAN, ticketId: b }))).toMatchObject({ ok: true });

    await t.run((ctx) => lab.unlink(ctx, { linkId: related }));
    expect((await detail(t, a)).links.map((l) => l.relation)).toEqual(["duplicates"]);
  });

  test("a label is a ref link with refKind label: stored once per ticket and found by listByRef", async () => {
    const t = await ready();
    const p = await openProj(t, "p");
    const q = await openProj(t, "q");
    const r = await openProj(t, "r");
    const bugOnP = await label(t, p, "bug");
    await label(t, q, "bug");
    await label(t, r, "feature");
    await label(t, p, "sprint-1", "cycle");
    expect(await label(t, p, "bug")).toBe(bugOnP);

    const byRef = async (refKind: string, ref: string) => {
      const page = await t.run((ctx) => lab.listByRef(ctx, { refKind, ref, paginationOpts: PAGE }));
      return page.page.map((l) => l.ticketId).sort();
    };
    expect(await byRef("label", "bug")).toEqual([p, q].sort());
    expect(await byRef("label", "feature")).toEqual([r]);
    expect(await byRef("cycle", "sprint-1")).toEqual([p]);
    expect(await byRef("label", "sprint-1")).toEqual([]);
    expect(await byRef("label", "missing")).toEqual([]);
    expect((await detail(t, p)).links.map((l) => [l.refKind, l.ref]).sort()).toEqual([["cycle", "sprint-1"], ["label", "bug"]]);

    await t.run((ctx) => lab.unlink(ctx, { linkId: bugOnP }));
    expect(await byRef("label", "bug")).toEqual([q]);
    expect(await counter(t, p)).toBe(0);
  });

  test("link arguments are validated with INVALID_ARGUMENT and a refused link writes nothing", async () => {
    const t = await ready();
    const a = await openProj(t, "a");
    const b = await openProj(t, "b");
    const send = (args: { relation: "blocks" | "duplicates" | "relates" | "ref"; toTicketId?: string; refKind?: string; ref?: string }) =>
      t.run((ctx) => lab.link(ctx, { ticketId: a, actor: LEAD, ...args }));

    await expectCode(send({ relation: "relates" }), "INVALID_ARGUMENT");
    await expectCode(send({ relation: "duplicates" }), "INVALID_ARGUMENT");
    await expectCode(send({ relation: "blocks" }), "INVALID_ARGUMENT");
    await expectCode(send({ relation: "ref", ref: "bug" }), "INVALID_ARGUMENT");
    await expectCode(send({ relation: "ref", refKind: "label" }), "INVALID_ARGUMENT");
    await expectCode(send({ relation: "ref", refKind: "label", ref: "bug", toTicketId: b }), "INVALID_ARGUMENT");
    await expectCode(send({ relation: "relates", toTicketId: a }), "INVALID_ARGUMENT");
    await expectCode(send({ relation: "duplicates", toTicketId: a }), "INVALID_ARGUMENT");

    expect((await detail(t, a)).links).toEqual([]);
    expect((await detail(t, b)).links).toEqual([]);
    expect(await counter(t, a)).toBe(0);
  });

  test("a ref link with the same kind and ref on two tickets makes two links", async () => {
    const t = await ready();
    const a = await openProj(t, "a");
    const b = await openProj(t, "b");

    const onA = await label(t, a, "shared");
    const onB = await label(t, b, "shared");

    expect(onA).not.toBe(onB);
    expect((await detail(t, a)).links).toHaveLength(1);
    expect((await detail(t, b)).links).toHaveLength(1);
  });
});

/** A small deterministic generator, so a failure replays with the same series. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

interface Stats {
  linked: number;
  cycles: number;
  unlinked: number;
  claimed: number;
  refused: number;
  completed: number;
  failed: number;
  canceled: number;
  reopened: number;
}

async function snapshot(t: T, ids: readonly string[]): Promise<TicketDetail[]> {
  return await t.run(async (ctx) => {
    const found: TicketDetail[] = [];
    for (const ticketId of ids) found.push(must(await lab.get(ctx, { ticketId }), `ticket ${ticketId}`));
    return found;
  });
}

/** Every ticket whose counter differs from a fresh count of its blocks links whose blocker is not completed. */
function drift(snap: readonly TicketDetail[]): string[] {
  return snap.flatMap((view) => {
    const fresh = view.blockers.filter((b) => !b.completed).length;
    return view.ticket.openBlockers === fresh ? [] : [`${view.ticket.title}: counter ${view.ticket.openBlockers}, links say ${fresh}`];
  });
}

function pick(snap: readonly TicketDetail[], next: () => number, applies: (view: TicketDetail) => boolean): TicketDetail | undefined {
  const start = Math.floor(next() * snap.length);
  for (let offset = 0; offset < snap.length; offset += 1) {
    const view = snap[(start + offset) % snap.length];
    if (view && applies(view)) return view;
  }
  return undefined;
}

function isEnded(view: TicketDetail): boolean {
  return view.ticket.category === "done" || view.ticket.category === "canceled";
}

async function randomStep(t: T, next: () => number, snap: readonly TicketDetail[], stats: Stats): Promise<string> {
  const roll = next();
  const wantFree = next() < 0.6;

  if (roll < 0.25) {
    const blocker = must(snap[Math.floor(next() * snap.length)], "blocker");
    const gap = 1 + Math.floor(next() * (snap.length - 1));
    const dependent = must(snap[(snap.indexOf(blocker) + gap) % snap.length], "dependent");
    if (await allowing(block(t, blocker.ticket.ticketId, dependent.ticket.ticketId), "CYCLE")) stats.linked += 1;
    else stats.cycles += 1;
    return `${blocker.ticket.title} blocks ${dependent.ticket.title}`;
  }
  if (roll < 0.33) {
    const target = pick(snap, next, (view) => view.blockers.length > 0);
    const link = target?.blockers[Math.floor(next() * target.blockers.length)];
    if (!target || !link) return "skip unlink";
    await t.run((ctx) => lab.unlink(ctx, { linkId: link.linkId }));
    stats.unlinked += 1;
    return `unlink a blocker of ${target.ticket.title}`;
  }
  if (roll < 0.55) {
    const free = (view: TicketDetail) => view.ticket.category === "unstarted" && (!wantFree || view.ticket.openBlockers === 0);
    const target = pick(snap, next, free) ?? pick(snap, next, (view) => view.ticket.category === "unstarted");
    if (!target) return "skip claim";
    const { ticketId, title, openBlockers } = target.ticket;
    const result = await t.run((ctx) => lab.claim(ctx, { ticketId, actor: A }));
    expect(result.ok, `claim of ${title} with ${openBlockers} open blockers`).toBe(openBlockers === 0);
    if (result.ok) stats.claimed += 1;
    else stats.refused += 1;
    return `claim ${title}`;
  }
  if (roll < 0.75) {
    const target = pick(snap, next, (view) => view.ticket.category === "started");
    if (!target) return "skip resolve";
    const { ticketId, title, claimSeq } = target.ticket;
    const resolution = next() < 0.75 ? "completed" : "failed";
    await t.run((ctx) => lab.resolve(ctx, { ticketId, actor: A, claimSeq, resolution }));
    if (resolution === "completed") stats.completed += 1;
    else stats.failed += 1;
    return `resolve ${title} as ${resolution}`;
  }
  if (roll < 0.82) {
    const target = pick(snap, next, (view) => !isEnded(view));
    if (!target) return "skip cancel";
    await t.run((ctx) => lab.cancel(ctx, { ticketId: target.ticket.ticketId, actor: LEAD }));
    stats.canceled += 1;
    return `cancel ${target.ticket.title}`;
  }
  const target = pick(snap, next, isEnded);
  if (!target) return "skip reopen";
  await t.run((ctx) => lab.reopen(ctx, { ticketId: target.ticket.ticketId, actor: LEAD }));
  stats.reopened += 1;
  return `reopen ${target.ticket.title}`;
}

describe("the blocker counter never drifts from the links", () => {
  test.each([20261127, 7, 424242])(
    "after every step of a random series of links, unlinks, resolves, cancels and reopens (seed %i)",
    async (seed) => {
      const t = await ready();
      const next = lcg(seed);
      const ids: string[] = [];
      for (let index = 0; index < 8; index += 1) ids.push(await openProj(t, `p${index}`));
      const stats: Stats = { linked: 0, cycles: 0, unlinked: 0, claimed: 0, refused: 0, completed: 0, failed: 0, canceled: 0, reopened: 0 };

      let snap = await snapshot(t, ids);
      expect(drift(snap)).toEqual([]);
      for (let step = 1; step <= 160; step += 1) {
        const did = await randomStep(t, next, snap, stats);
        snap = await snapshot(t, ids);
        expect(drift(snap), `after step ${step}: ${did}`).toEqual([]);
      }

      expect(stats.linked).toBeGreaterThanOrEqual(10);
      expect(stats.cycles).toBeGreaterThanOrEqual(1);
      expect(stats.unlinked).toBeGreaterThanOrEqual(2);
      expect(stats.completed).toBeGreaterThanOrEqual(5);
      expect(stats.failed).toBeGreaterThanOrEqual(1);
      expect(stats.canceled).toBeGreaterThanOrEqual(2);
      expect(stats.reopened).toBeGreaterThanOrEqual(3);
      expect(stats.refused).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );
});
