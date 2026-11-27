import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import { components } from "./_generated/api.js";
import { Tickets, defineQueue } from "../../src/client/index.js";
import type { Party, RunMutationCtx, TicketView, TypedTicket } from "../../src/client/index.js";
import { deskQueue, projectQueue } from "../../src/client/presets.js";

afterEach(() => {
  vi.useRealTimers();
});

const billingQueue = defineQueue({
  fields: {
    amount: { type: "number", required: true },
    currency: { type: "enum", options: ["EUR", "USD"], required: true },
    orderId: { type: "string" },
  },
  result: {
    refunded: { type: "boolean", required: true },
    refundId: { type: "string" },
  },
});
const plainQueue = defineQueue({});

const tickets = new Tickets(components.tickets, {
  queues: {
    billing: billingQueue,
    eng: defineQueue(projectQueue({ fields: { estimate: { type: "number" } } })),
    desk: defineQueue(deskQueue()),
    plain: plainQueue,
  },
});

type Name = keyof typeof tickets.queues & string;
type OpenArgs<K extends Name> = Parameters<typeof tickets.open<K>>[1];
type MoveArgs<K extends Name> = Parameters<typeof tickets.move<K>>[1];
type ClaimArgs<K extends Name> = Parameters<typeof tickets.claim<K>>[1];
type ReplyArgs<K extends Name> = Parameters<typeof tickets.reply<K>>[1];
type RequestInputArgs<K extends Name> = Parameters<typeof tickets.requestInput<K>>[1];
type HandoffArgs<K extends Name> = Parameters<typeof tickets.handoff<K>>[1];
type ResolveArgs<K extends Name> = Parameters<typeof tickets.resolve<K>>[1];
type DefineArgs = Parameters<typeof defineQueue>[0];

/** True when a value of type `A` can be passed where `B` is expected. */
type IsAssignable<A, B> = [A] extends [B] ? true : false;

/** Like `IsAssignable`, and also false when `Candidate` has a key `Shape` does not declare, as a fresh object literal would. */
type Accepts<Shape, Candidate> = [Candidate] extends [Shape]
  ? [Exclude<keyof Candidate, keyof Shape>] extends [never]
    ? true
    : false
  : false;

type BillingOpen<F> = { queue: "billing"; actor: Party; title: string; fields: F };
type BillingFields = OpenArgs<"billing">["fields"];
type Holder = { ticketId: string; actor: Party; claimSeq: number };

/** Every call here must compile; this function is never run. */
async function validCalls(ctx: RunMutationCtx, actor: Party): Promise<void> {
  await tickets.open(ctx, { queue: "billing", actor, title: "refund", fields: { amount: 49, currency: "EUR" } });
  await tickets.open(ctx, {
    queue: "billing",
    actor,
    title: "refund",
    to: "working",
    priority: 1,
    subjectRef: "customer:1",
    parentId: "p1",
    blockedBy: ["b1"],
    idempotencyKey: "k",
    body: "please",
    fields: { amount: 49, currency: "USD", orderId: "A-1" },
  });
  await tickets.open(ctx, { queue: "billing", actor, title: "refund", fields: { amount: 1, currency: "EUR", orderId: null } });
  await tickets.open(ctx, { queue: "eng", actor, title: "task", to: "backlog" });
  await tickets.open(ctx, { queue: "eng", actor, title: "task", fields: { estimate: 3 } });
  await tickets.open(ctx, { queue: "desk", actor, title: "question" });
  await tickets.open(ctx, { queue: "plain", actor, title: "anything", to: "working" });
  await tickets.claim(ctx, { actor, queue: "eng", to: "in_review" });
  await tickets.claim(ctx, { actor, ticketId: "t1" });
  await tickets.move(ctx, { ticketId: "t1", actor, queue: "eng", to: "in_progress" });
  await tickets.move(ctx, { ticketId: "t1", actor, queue: "desk", to: "on_hold", trusted: true });
  await tickets.requestInput(ctx, { ticketId: "t1", actor, claimSeq: 1, queue: "billing", body: "which order?", fields: ["orderId"] });
  await tickets.reply(ctx, { ticketId: "t1", actor, queue: "billing", body: "here", fields: { orderId: "A-1" } });
  await tickets.handoff(ctx, { ticketId: "t1", actor, claimSeq: 1, toQueue: "billing", fields: { amount: 5 } });
  await tickets.resolve(ctx, { ticketId: "t1", actor, claimSeq: 1, queue: "billing", resolution: "completed", result: { refunded: true } });
  await tickets.resolve(ctx, { ticketId: "t1", actor, claimSeq: 1, queue: "desk", resolution: "rejected", to: "solved" });
}

function narrowsBilling(ticket: TicketView): number | null | undefined {
  if (!tickets.isIn(ticket, "billing")) return undefined;
  expectTypeOf(ticket.queue).toEqualTypeOf<string>();
  expectTypeOf(ticket.fields.amount).toEqualTypeOf<number | null | undefined>();
  expectTypeOf(ticket.fields.currency).toEqualTypeOf<"EUR" | "USD" | null | undefined>();
  expectTypeOf(ticket.fields.orderId).toEqualTypeOf<string | null | undefined>();
  expectTypeOf(ticket.result?.refunded).toEqualTypeOf<boolean | null | undefined>();
  return ticket.fields.amount;
}

function narrowsEng(ticket: TicketView): number | null | undefined {
  if (!tickets.isIn(ticket, "eng")) return undefined;
  expectTypeOf(ticket.fields.estimate).toEqualTypeOf<number | null | undefined>();
  return ticket.fields.estimate;
}

describe("a queue name", () => {
  test("must be one the client was built with", () => {
    const known: IsAssignable<"billing", Name> = true;
    const alsoKnown: IsAssignable<"plain", Name> = true;
    const unknown: IsAssignable<"nowhere", Name> = false;
    const casing: IsAssignable<"Billing", Name> = false;
    expectTypeOf<Name>().toEqualTypeOf<"billing" | "eng" | "desk" | "plain">();
    expect([known, alsoKnown, unknown, casing]).toEqual([true, true, false, false]);
  });

  test("is the only way to name a queue for isIn", () => {
    type IsInQueue = Parameters<typeof tickets.isIn>[1];
    const known: IsAssignable<"eng", IsInQueue> = true;
    const unknown: IsAssignable<"nowhere", IsInQueue> = false;
    expect([known, unknown]).toEqual([true, false]);
  });
});

describe("opening a ticket", () => {
  test("compiles with the declared required fields and with any optional ones", () => {
    const required: IsAssignable<BillingOpen<{ amount: number; currency: "EUR" }>, OpenArgs<"billing">> = true;
    const everything: IsAssignable<BillingOpen<{ amount: number; currency: "USD"; orderId: string }>, OpenArgs<"billing">> = true;
    const clearedOptional: IsAssignable<BillingOpen<{ amount: number; currency: "EUR"; orderId: null }>, OpenArgs<"billing">> = true;
    expect([required, everything, clearedOptional]).toEqual([true, true, true]);
    expect(validCalls).toBeTypeOf("function");
  });

  test("does not compile with a wrong field name", () => {
    const misspeltRequired: IsAssignable<BillingOpen<{ amuont: number; currency: "EUR" }>, OpenArgs<"billing">> = false;
    const misspeltOptional: Accepts<BillingFields, { amount: number; currency: "EUR"; ordrId: string }> = false;
    const undeclared: Accepts<BillingFields, { amount: number; currency: "EUR"; colour: string }> = false;
    const declared: Accepts<BillingFields, { amount: number; currency: "EUR"; orderId: string }> = true;
    expectTypeOf<keyof NonNullable<BillingFields>>().toEqualTypeOf<"amount" | "currency" | "orderId">();
    expect([misspeltRequired, misspeltOptional, undeclared, declared]).toEqual([false, false, false, true]);
  });

  test("does not compile with a wrong field type", () => {
    const stringForNumber: IsAssignable<BillingOpen<{ amount: string; currency: "EUR" }>, OpenArgs<"billing">> = false;
    const booleanForNumber: IsAssignable<BillingOpen<{ amount: boolean; currency: "EUR" }>, OpenArgs<"billing">> = false;
    const numberForString: IsAssignable<BillingOpen<{ amount: number; currency: "EUR"; orderId: number }>, OpenArgs<"billing">> = false;
    const nullForRequired: IsAssignable<BillingOpen<{ amount: null; currency: "EUR" }>, OpenArgs<"billing">> = false;
    expect([stringForNumber, booleanForNumber, numberForString, nullForRequired]).toEqual([false, false, false, false]);
  });

  test("does not compile with an enum value outside the declared options", () => {
    const outside: IsAssignable<BillingOpen<{ amount: number; currency: "GBP" }>, OpenArgs<"billing">> = false;
    const widened: IsAssignable<BillingOpen<{ amount: number; currency: string }>, OpenArgs<"billing">> = false;
    const inside: IsAssignable<BillingOpen<{ amount: number; currency: "USD" }>, OpenArgs<"billing">> = true;
    expectTypeOf<NonNullable<BillingFields>["currency"]>().toEqualTypeOf<"EUR" | "USD">();
    expect([outside, widened, inside]).toEqual([false, false, true]);
  });

  test("does not compile when a required field is missing, or when fields is left out of a queue that has one", () => {
    const noCurrency: IsAssignable<BillingOpen<{ amount: number }>, OpenArgs<"billing">> = false;
    const noAmount: IsAssignable<BillingOpen<{ currency: "EUR" }>, OpenArgs<"billing">> = false;
    const emptyFields: IsAssignable<BillingOpen<Record<never, never>>, OpenArgs<"billing">> = false;
    const noFields: IsAssignable<{ queue: "billing"; actor: Party; title: string }, OpenArgs<"billing">> = false;
    expect([noCurrency, noAmount, emptyFields, noFields]).toEqual([false, false, false, false]);
  });

  test("lets a queue with no required field leave fields out, and still checks the ones it declares", () => {
    const engBare: IsAssignable<{ queue: "eng"; actor: Party; title: string }, OpenArgs<"eng">> = true;
    const engEstimate: IsAssignable<{ queue: "eng"; actor: Party; title: string; fields: { estimate: number } }, OpenArgs<"eng">> = true;
    const engWrongType: IsAssignable<{ queue: "eng"; actor: Party; title: string; fields: { estimate: string } }, OpenArgs<"eng">> = false;
    const deskBare: IsAssignable<{ queue: "desk"; actor: Party; title: string }, OpenArgs<"desk">> = true;
    const plainBare: IsAssignable<{ queue: "plain"; actor: Party; title: string }, OpenArgs<"plain">> = true;
    expect([engBare, engEstimate, engWrongType, deskBare, plainBare]).toEqual([true, true, false, true, true]);
  });

  test("does not compile with the fields of another queue", () => {
    const engFieldsOnBilling: IsAssignable<BillingOpen<{ estimate: number }>, OpenArgs<"billing">> = false;
    const billingFieldsOnEng: Accepts<NonNullable<OpenArgs<"eng">["fields"]>, { amount: number; currency: "EUR" }> = false;
    const anyFieldOnPlain: Accepts<NonNullable<OpenArgs<"plain">["fields"]>, { anything: number }> = false;
    const wrongQueue: IsAssignable<{ queue: "eng"; actor: Party; title: string }, OpenArgs<"billing">> = false;
    expect([engFieldsOnBilling, billingFieldsOnEng, anyFieldOnPlain, wrongQueue]).toEqual([false, false, false, false]);
  });

  test("does not compile without a title or an actor", () => {
    const noTitle: IsAssignable<{ queue: "eng"; actor: Party }, OpenArgs<"eng">> = false;
    const noActor: IsAssignable<{ queue: "eng"; title: string }, OpenArgs<"eng">> = false;
    const badActor: IsAssignable<{ queue: "eng"; title: string; actor: { ref: string; kind: "robot" } }, OpenArgs<"eng">> = false;
    expect([noTitle, noActor, badActor]).toEqual([false, false, false]);
  });
});

describe("a state name", () => {
  test("is checked against the states of the queue the ticket is in", () => {
    expectTypeOf<NonNullable<OpenArgs<"billing">["to"]>>().toEqualTypeOf<"open" | "working" | "waiting" | "resolved" | "canceled">();
    expectTypeOf<NonNullable<OpenArgs<"plain">["to"]>>().toEqualTypeOf<"open" | "working" | "waiting" | "resolved" | "canceled">();
    expectTypeOf<NonNullable<OpenArgs<"eng">["to"]>>().toEqualTypeOf<
      "backlog" | "todo" | "in_progress" | "in_review" | "done" | "canceled"
    >();
    expectTypeOf<NonNullable<OpenArgs<"desk">["to"]>>().toEqualTypeOf<"new" | "open" | "pending" | "on_hold" | "solved" | "canceled">();
  });

  test("does not compile for open when it belongs to another queue", () => {
    const engStateOnBilling: IsAssignable<"in_progress", NonNullable<OpenArgs<"billing">["to"]>> = false;
    const deskStateOnBilling: IsAssignable<"pending", NonNullable<OpenArgs<"billing">["to"]>> = false;
    const defaultStateOnEng: IsAssignable<"working", NonNullable<OpenArgs<"eng">["to"]>> = false;
    const ownState: IsAssignable<"working", NonNullable<OpenArgs<"billing">["to"]>> = true;
    expect([engStateOnBilling, deskStateOnBilling, defaultStateOnEng, ownState]).toEqual([false, false, false, true]);
  });

  test("does not compile for move, claim, requestInput and resolve when it belongs to another queue", () => {
    const moveToOther: IsAssignable<{ ticketId: string; actor: Party; queue: "eng"; to: "pending" }, MoveArgs<"eng">> = false;
    const moveToOwn: IsAssignable<{ ticketId: string; actor: Party; queue: "eng"; to: "in_review" }, MoveArgs<"eng">> = true;
    const moveToDefault: IsAssignable<{ ticketId: string; actor: Party; queue: "eng"; to: "open" }, MoveArgs<"eng">> = false;
    const claimToOther: IsAssignable<{ actor: Party; queue: "desk"; to: "todo" }, ClaimArgs<"desk">> = false;
    const claimToOwn: IsAssignable<{ actor: Party; queue: "desk"; to: "open" }, ClaimArgs<"desk">> = true;
    const resolveToOther: IsAssignable<Holder & { queue: "desk"; resolution: "completed"; to: "done" }, ResolveArgs<"desk">> = false;
    const resolveToOwn: IsAssignable<Holder & { queue: "desk"; resolution: "completed"; to: "solved" }, ResolveArgs<"desk">> = true;
    const inputToOther: IsAssignable<Holder & { queue: "desk"; body: string; to: "working" }, RequestInputArgs<"desk">> = false;
    expect([moveToOther, moveToOwn, moveToDefault, claimToOther, claimToOwn, resolveToOther, resolveToOwn, inputToOther]).toEqual([
      false,
      true,
      false,
      false,
      true,
      false,
      true,
      false,
    ]);
  });

  test("is a plain string for a state that is not in the queue the call names only through a typed queue", () => {
    const anyString: IsAssignable<string, NonNullable<MoveArgs<"eng">["to"]>> = false;
    expect(anyString).toBe(false);
  });
});

describe("the other typed verbs", () => {
  test("requestInput only names fields the queue declares", () => {
    const declared: IsAssignable<Holder & { queue: "billing"; body: string; fields: ["orderId"] }, RequestInputArgs<"billing">> = true;
    const several: IsAssignable<Holder & { queue: "billing"; body: string; fields: ("amount" | "orderId")[] }, RequestInputArgs<"billing">> =
      true;
    const undeclared: IsAssignable<Holder & { queue: "billing"; body: string; fields: ["colour"] }, RequestInputArgs<"billing">> = false;
    const otherQueue: IsAssignable<Holder & { queue: "billing"; body: string; fields: ["estimate"] }, RequestInputArgs<"billing">> = false;
    expect([declared, several, undeclared, otherQueue]).toEqual([true, true, false, false]);
  });

  test("reply checks the types of the fields a requester supplies, and every key is optional", () => {
    type Reply<F> = { ticketId: string; actor: Party; queue: "billing"; body: string; fields: F };
    const right: IsAssignable<Reply<{ orderId: string }>, ReplyArgs<"billing">> = true;
    const partial: IsAssignable<Reply<Record<never, never>>, ReplyArgs<"billing">> = true;
    const wrongType: IsAssignable<Reply<{ orderId: number }>, ReplyArgs<"billing">> = false;
    const wrongEnum: IsAssignable<Reply<{ currency: "GBP" }>, ReplyArgs<"billing">> = false;
    const wrongName: Accepts<NonNullable<ReplyArgs<"billing">["fields"]>, { orderNo: string }> = false;
    expect([right, partial, wrongType, wrongEnum, wrongName]).toEqual([true, true, false, false, false]);
  });

  test("handoff checks the fields against the target queue", () => {
    type Hand<F> = Holder & { toQueue: "billing"; fields: F };
    const right: IsAssignable<Hand<{ amount: number; currency: "EUR" }>, HandoffArgs<"billing">> = true;
    const wrongType: IsAssignable<Hand<{ amount: string }>, HandoffArgs<"billing">> = false;
    const wrongName: Accepts<NonNullable<HandoffArgs<"billing">["fields"]>, { total: number }> = false;
    expect([right, wrongType, wrongName]).toEqual([true, false, false]);
  });

  test("resolve checks the result against the queue's result fields", () => {
    type Resolve<R> = Holder & { queue: "billing"; resolution: "completed"; result: R };
    const right: IsAssignable<Resolve<{ refunded: boolean; refundId: string }>, ResolveArgs<"billing">> = true;
    const wrongType: IsAssignable<Resolve<{ refunded: string }>, ResolveArgs<"billing">> = false;
    const wrongOptionalType: IsAssignable<Resolve<{ refunded: true; refundId: number }>, ResolveArgs<"billing">> = false;
    const wrongName: Accepts<NonNullable<ResolveArgs<"billing">["result"]>, { refunded: boolean; refundd: string }> = false;
    const ticketFieldAsResult: Accepts<NonNullable<ResolveArgs<"billing">["result"]>, { amount: number }> = false;
    const badResolution: IsAssignable<Holder & { queue: "billing"; resolution: "done" }, ResolveArgs<"billing">> = false;
    expectTypeOf<ResolveArgs<"billing">["resolution"]>().toEqualTypeOf<"completed" | "failed" | "rejected">();
    expect([right, wrongType, wrongOptionalType, wrongName, ticketFieldAsResult, badResolution]).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("defining a queue", () => {
  test("does not compile with a category outside the six, an enum without options or a lease that is not a number", () => {
    const goodState: IsAssignable<{ states: { review: { category: "started" } } }, DefineArgs> = true;
    const badCategory: IsAssignable<{ states: { review: { category: "paused" } } }, DefineArgs> = false;
    const badWaitTarget: IsAssignable<{ states: { review: { category: "waiting"; on: "blockers" } } }, DefineArgs> = false;
    const goodEnum: IsAssignable<{ fields: { kind: { type: "enum"; options: ["a", "b"] } } }, DefineArgs> = true;
    const noOptions: IsAssignable<{ fields: { kind: { type: "enum" } } }, DefineArgs> = false;
    const emptyOptions: IsAssignable<{ fields: { kind: { type: "enum"; options: [] } } }, DefineArgs> = false;
    const badFieldType: IsAssignable<{ fields: { kind: { type: "date" } } }, DefineArgs> = false;
    const badLease: IsAssignable<{ policy: { leaseMs: "5m" } }, DefineArgs> = false;
    const noLease: IsAssignable<{ policy: { leaseMs: null } }, DefineArgs> = true;
    expect([goodState, badCategory, badWaitTarget, goodEnum, noOptions, emptyOptions, badFieldType, badLease, noLease]).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      true,
    ]);
  });
});

describe("narrowing a ticket with isIn", () => {
  test("gives a ticket of the queue the declared field and result types", () => {
    expect(narrowsBilling).toBeTypeOf("function");
    expect(narrowsEng).toBeTypeOf("function");
    type BillingTicket = TypedTicket<typeof billingQueue>;
    expectTypeOf<keyof BillingTicket["fields"]>().toEqualTypeOf<"amount" | "currency" | "orderId">();
    expectTypeOf<BillingTicket["fields"]["amount"]>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<BillingTicket["fields"]["currency"]>().toEqualTypeOf<"EUR" | "USD" | null | undefined>();
    expectTypeOf<BillingTicket["fields"]["orderId"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<keyof NonNullable<BillingTicket["result"]>>().toEqualTypeOf<"refunded" | "refundId">();
    expectTypeOf<NonNullable<BillingTicket["result"]>["refunded"]>().toEqualTypeOf<boolean | null | undefined>();
  });

  test("a field that the queue does not declare is not a key of the narrowed fields", () => {
    type EngFields = TypedTicket<(typeof tickets.queues)["eng"]>["fields"];
    const declared: IsAssignable<"estimate", keyof EngFields> = true;
    const undeclared: IsAssignable<"amount", keyof EngFields> = false;
    expect([declared, undeclared]).toEqual([true, false]);
  });
});

/**
 * The spec's own example writes `defineQueue(...)` inline inside `new Tickets(...)`.
 * The same checks must hold for that form.
 */
const inline = new Tickets(components.tickets, {
  queues: {
    billing: defineQueue({
      fields: {
        amount: { type: "number", required: true },
        currency: { type: "enum", options: ["EUR", "USD"], required: true },
      },
      result: { refunded: { type: "boolean", required: true } },
    }),
    plain: defineQueue({}),
    intake: defineQueue({ fields: { note: { type: "string" } } }),
  },
});
type InlineOpen<K extends keyof typeof inline.queues & string> = Parameters<typeof inline.open<K>>[1];
type InlineResolve<K extends keyof typeof inline.queues & string> = Parameters<typeof inline.resolve<K>>[1];

describe("defineQueue written inline inside new Tickets", () => {
  test("a queue with no states takes only the default five state names", () => {
    expectTypeOf<NonNullable<InlineOpen<"billing">["to"]>>().toEqualTypeOf<"open" | "working" | "waiting" | "resolved" | "canceled">();
    const misspelt: IsAssignable<"workin", NonNullable<InlineOpen<"billing">["to"]>> = false;
    const fromOtherQueue: IsAssignable<"in_progress", NonNullable<InlineOpen<"billing">["to"]>> = false;
    expect([misspelt, fromOtherQueue]).toEqual([false, false]);
  });

  test("a result of the wrong type or with an undeclared key does not compile", () => {
    type Resolve<R> = Holder & { queue: "billing"; resolution: "completed"; result: R };
    const right: IsAssignable<Resolve<{ refunded: boolean }>, InlineResolve<"billing">> = true;
    const wrongType: IsAssignable<Resolve<{ refunded: string }>, InlineResolve<"billing">> = false;
    const wrongName: Accepts<NonNullable<InlineResolve<"billing">["result"]>, { refunded: boolean; refundd: string }> = false;
    expect([right, wrongType, wrongName]).toEqual([true, false, false]);
  });

  test("a queue with no fields takes no field and a queue with no result takes no result key", () => {
    const undeclaredField: Accepts<NonNullable<InlineOpen<"plain">["fields"]>, { anything: number }> = false;
    const undeclaredResult: Accepts<NonNullable<InlineResolve<"intake">["result"]>, { anything: number }> = false;
    const declaredField: Accepts<NonNullable<InlineOpen<"intake">["fields"]>, { note: string }> = true;
    expect([undeclaredField, undeclaredResult, declaredField]).toEqual([false, false, true]);
  });
});

describe("the client at runtime", () => {
  test("keeps the queue definitions it was built with, in order, with their declared fields", () => {
    expect(Object.keys(tickets.queues)).toEqual(["billing", "eng", "desk", "plain"]);
    expect(tickets.queues.billing.fields).toEqual({
      amount: { type: "number", required: true },
      currency: { type: "enum", options: ["EUR", "USD"], required: true },
      orderId: { type: "string" },
    });
    expect(tickets.queues.eng.states).toMatchObject({ in_review: { category: "started" } });
    expect(tickets.queues.desk.states).toMatchObject({ pending: { category: "waiting", on: "requester" } });
    expect(tickets.queues.plain).toEqual({});
  });
});
