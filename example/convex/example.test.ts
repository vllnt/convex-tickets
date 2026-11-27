/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from "vitest";
import testSupport, { register } from "../../src/test.js";
import { api, internal } from "./_generated/api.js";
import { drain, events, expectCode, setup } from "./harness.helper.js";
import { parties, tickets } from "./tickets.js";

afterEach(() => {
  vi.useRealTimers();
});

test("published test support exposes registration assets", () => {
  expect(testSupport.register).toBe(register);
  expect(testSupport.schema).toBeDefined();
  expect(testSupport.modules).toBeDefined();
});

describe("the refund example, end to end", () => {
  test("an agent queue and a human queue resolve a refund with a typed result", async () => {
    const t = setup();
    await t.mutation(internal.example.syncTickets, {});

    const ticketId = await t.mutation(api.example.openRefund, {
      conversationId: "conv_7f3",
      customerRef: "customer:8841",
      amount: 49,
      currency: "EUR",
    });
    const retry = await t.mutation(api.example.openRefund, {
      conversationId: "conv_7f3",
      customerRef: "customer:8841",
      amount: 49,
      currency: "EUR",
    });
    expect(retry).toBe(ticketId);

    await drain(t);
    let detail = await t.run((ctx) => tickets.get(ctx, { ticketId, view: "internal" }));
    expect(detail?.ticket).toMatchObject({ state: "waiting", waitingOn: "requester", assigneeRef: parties.billing.ref });
    expect(detail?.leaseExpiresAt).toBeUndefined();
    expect(detail?.messages.at(-1)).toMatchObject({ kind: "input_request", requestedFields: ["orderId"] });

    expect(await t.mutation(api.example.answerOrderId, { ticketId, orderId: "A-1042" })).toBe(true);
    await drain(t);

    detail = await t.run((ctx) => tickets.get(ctx, { ticketId }));
    expect(detail?.ticket).toMatchObject({ category: "waiting", waitingOn: "blockers", openBlockers: 1 });
    expect(detail?.ticket.fields).toMatchObject({ orderId: "A-1042" });

    const inbox = await t.query(api.example.approvalsInbox, { paginationOpts: { cursor: null, numItems: 10 } });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.amount).toBe(49);

    vi.advanceTimersByTime(20 * 60_000);
    await t.mutation(api.example.decideApproval, { ticketId: inbox[0]?.ticketId ?? "", approved: true });
    await drain(t);

    expect(await t.query(api.example.refundOutcome, { ticketId })).toEqual({
      state: "resolved",
      refunded: true,
      refundId: "re_A-1042",
    });
    const types = (await events(t)).filter((e) => e.ticketId === ticketId).map((e) => e.type);
    expect(types).toEqual(["opened", "claimed", "input_requested", "input_provided", "held", "resumed", "resolved"]);
  });

  test("a refused approval resolves the refund as rejected", async () => {
    const t = setup();
    await t.mutation(internal.example.syncTickets, {});
    const ticketId = await t.mutation(api.example.openRefund, {
      conversationId: "c2",
      customerRef: "customer:1",
      amount: 10,
      currency: "USD",
    });
    await drain(t);
    await t.mutation(api.example.answerOrderId, { ticketId, orderId: "B-7" });
    await drain(t);
    const [approval] = await t.query(api.example.approvalsInbox, { paginationOpts: { cursor: null, numItems: 10 } });
    await t.mutation(api.example.decideApproval, { ticketId: approval?.ticketId ?? "", approved: false });
    await drain(t);
    expect(await t.query(api.example.refundOutcome, { ticketId })).toEqual({
      state: "resolved",
      refunded: false,
      refundId: undefined,
    });
    const detail = await t.run((ctx) => tickets.get(ctx, { ticketId }));
    expect(detail?.ticket.resolution).toBe("rejected");
  });

  test("the scripted agent and the approver ignore work that is not theirs", async () => {
    const t = setup();
    await t.mutation(internal.example.syncTickets, {});
    const missing = await t.run(async (ctx) => {
      const id = await tickets.open(ctx, { queue: "approvals", actor: parties.lead, title: "x", fields: { amount: 1 } });
      return id;
    });
    await t.mutation(internal.example.runBillingAgent, { ticketId: missing });
    expect(await t.query(api.example.refundOutcome, { ticketId: missing })).toBeNull();

    const ticketId = await t.mutation(api.example.openRefund, {
      conversationId: "c3",
      customerRef: "customer:2",
      amount: 5,
      currency: "EUR",
    });
    await t.run((ctx) => tickets.claim(ctx, { ticketId, actor: parties.lead }));
    await drain(t);
    await t.mutation(internal.example.runBillingAgent, { ticketId });
    const detail = await t.run((ctx) => tickets.get(ctx, { ticketId }));
    expect(detail?.ticket.assigneeRef).toBe(parties.lead.ref);

    await t.run((ctx) => tickets.claim(ctx, { ticketId: missing, actor: parties.lead }));
    await expect(t.mutation(api.example.decideApproval, { ticketId: missing, approved: true })).rejects.toThrow(/TAKEN/);
    await expectCode(
      t.run((ctx) => tickets.get(ctx, { ticketId: missing, queue: "billing" })),
      "WRONG_QUEUE",
    );
  });
});
