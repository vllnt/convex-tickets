import { v } from "convex/values";
import { ticketEvent } from "../../src/client/index.js";
import type { TicketEvent } from "../../src/client/index.js";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";
import { parties } from "./tickets.js";

async function record(ctx: MutationCtx, mount: string, e: TicketEvent): Promise<void> {
  await ctx.db.insert("ticketEvents", {
    mount,
    ticketId: e.ticketId,
    seq: e.seq,
    type: e.type,
    queue: e.queue,
    state: e.state,
    category: e.category,
    blocked: e.blocked,
    actorRef: e.actor.ref,
    assigneeRef: e.assigneeRef,
    at: e.at,
  });
}

/**
 * The example's hook. The component schedules it after every transition.
 * It logs the event, then wakes the billing agent when there is work for it:
 * new, returned or unblocked billing work, or an answer or resume on a ticket
 * it holds. A real app would enqueue an agent run on @convex-dev/workpool here.
 */
export const onEvent = internalMutation({
  args: ticketEvent,
  returns: v.null(),
  handler: async (ctx, e): Promise<null> => {
    await record(ctx, "tickets", e);
    const newWork = e.queue === "billing" && e.category === "unstarted" && !e.blocked;
    const wakeHolder = (e.type === "input_provided" || e.type === "resumed") && e.assigneeRef === parties.billing.ref;
    if (newWork || wakeHolder) {
      await ctx.scheduler.runAfter(0, internal.example.runBillingAgent, { ticketId: e.ticketId });
    }
    return null;
  },
});

/** A hook that only logs. Tests use it to check delivery and order. */
export const recordOnly = internalMutation({
  args: ticketEvent,
  returns: v.null(),
  handler: async (ctx, e): Promise<null> => {
    await record(ctx, "tickets", e);
    return null;
  },
});

/** A hook that always throws: the ticket move it follows must stay in place. */
export const failingHook = internalMutation({
  args: ticketEvent,
  returns: v.null(),
  handler: async (): Promise<null> => {
    throw new Error("this hook fails on purpose");
  },
});
