import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server.js";
import { parties, strictTickets, tickets } from "./tickets.js";

/** Run once per deploy: writes queues, states, field types and the hook handle. */
export const syncTickets = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    await tickets.sync(ctx);
    await strictTickets.sync(ctx);
    return null;
  },
});

/**
 * Agent queue, step 1. The support agent opens a refund ticket in `billing`.
 * The hook then wakes the billing agent. A retry with the same conversation
 * returns the same ticket.
 */
export const openRefund = mutation({
  args: { conversationId: v.string(), customerRef: v.string(), amount: v.number(), currency: v.union(v.literal("EUR"), v.literal("USD")) },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    return await tickets.open(ctx, {
      queue: "billing",
      actor: parties.support,
      title: "Refund for a double charge",
      subjectRef: args.customerRef,
      fields: { amount: args.amount, currency: args.currency },
      idempotencyKey: `refund:${args.conversationId}`,
    });
  },
});

/**
 * The billing agent, scripted. A real app runs an LLM here (for example with
 * @convex-dev/agent); this one follows the refund example's steps so the flow
 * runs end to end: claim, ask for the order number, ask a human to approve,
 * then resolve with a typed result.
 */
export const runBillingAgent = internalMutation({
  args: { ticketId: v.string() },
  returns: v.null(),
  handler: async (ctx, { ticketId }): Promise<null> => {
    const actor = parties.billing;
    const detail = await tickets.get(ctx, { ticketId, view: "internal" });
    if (!detail || !tickets.isIn(detail.ticket, "billing")) return null;
    const ticket = detail.ticket;
    let claimSeq = ticket.claimSeq;
    if (ticket.category === "unstarted") {
      const claim = await tickets.claim(ctx, { ticketId, actor });
      if (!claim.ok) return null;
      claimSeq = claim.claimSeq;
    } else if (ticket.category !== "started" || ticket.assigneeRef !== actor.ref) {
      return null;
    }
    if (ticket.fields.orderId === undefined) {
      await tickets.requestInput(ctx, {
        queue: "billing",
        ticketId,
        actor,
        claimSeq,
        body: "Which order was charged twice?",
        fields: ["orderId"],
      });
      return null;
    }
    const [approval] = detail.blockers;
    if (!approval) {
      const childId = await tickets.open(ctx, {
        queue: "approvals",
        actor,
        title: `Approve a refund of ${ticket.fields.amount ?? 0} ${ticket.fields.currency ?? ""}`,
        parentId: ticketId,
        fields: { amount: ticket.fields.amount ?? 0 },
      });
      await tickets.hold(ctx, { ticketId, actor, claimSeq, blockers: [childId], reason: "needs a human approval" });
      return null;
    }
    const child = await tickets.get(ctx, { ticketId: approval.ticketId });
    const approved = approval.completed && child?.ticket.result?.approved === true;
    await tickets.resolve(ctx, {
      queue: "billing",
      ticketId,
      actor,
      claimSeq,
      resolution: approved ? "completed" : "rejected",
      result: approved ? { refunded: true, refundId: `re_${ticket.fields.orderId}` } : { refunded: false },
      body: approved ? "Refunded to the original card." : "The refund was not approved.",
    });
    return null;
  },
});

/** Agent queue, step 2. The support agent answers the billing agent's question with a typed field. */
export const answerOrderId = mutation({
  args: { ticketId: v.string(), orderId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const reply = await tickets.reply(ctx, {
      queue: "billing",
      ticketId: args.ticketId,
      actor: parties.support,
      body: `Order ${args.orderId}.`,
      fields: { orderId: args.orderId },
    });
    return reply.ok && reply.resumed;
  },
});

/** Human queue. What an approver's screen lists: unstarted work in `approvals`. Reactive. */
export const approvalsInbox = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.array(v.object({ ticketId: v.string(), title: v.string(), amount: v.number() })),
  handler: async (ctx, args): Promise<Array<{ ticketId: string; title: string; amount: number }>> => {
    const page = await tickets.list(ctx, {
      filter: { by: "queue", queue: "approvals", category: "unstarted" },
      paginationOpts: args.paginationOpts,
    });
    return page.page.flatMap((t) =>
      tickets.isIn(t, "approvals") ? [{ ticketId: t.ticketId, title: t.title, amount: t.fields.amount ?? 0 }] : [],
    );
  },
});

/**
 * Human queue. An approver claims and decides. The queue has no lease, so the
 * claim never expires on its own: a person may take a day.
 */
export const decideApproval = mutation({
  args: { ticketId: v.string(), approved: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const claim = await tickets.claim(ctx, { ticketId: args.ticketId, actor: parties.approver });
    if (!claim.ok) throw new Error(`cannot claim: ${claim.reason}`);
    await tickets.resolve(ctx, {
      queue: "approvals",
      ticketId: args.ticketId,
      actor: parties.approver,
      claimSeq: claim.claimSeq,
      resolution: "completed",
      result: { approved: args.approved },
    });
    return null;
  },
});

/** The support agent reads the outcome as data. */
export const refundOutcome = query({
  args: { ticketId: v.string() },
  returns: v.union(
    v.object({ state: v.string(), refunded: v.optional(v.boolean()), refundId: v.optional(v.string()) }),
    v.null(),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<{ state: string; refunded?: boolean; refundId?: string } | null> => {
    const detail = await tickets.get(ctx, { ticketId: args.ticketId });
    if (!detail || !tickets.isIn(detail.ticket, "billing")) return null;
    const result = detail.ticket.result;
    return {
      state: detail.ticket.state,
      refunded: result?.refunded ?? undefined,
      refundId: result?.refundId ?? undefined,
    };
  },
});
