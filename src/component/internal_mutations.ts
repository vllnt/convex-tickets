import { v } from "convex/values";
import { SYSTEM_PARTY } from "../shared.js";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import { escalateTicket, makeEnv, queueOf, removeBlocker, seal, stopLease, transition } from "./engine.js";
import { landingState, loadConfig } from "./queues.js";

/** Rows deleted per purge pass before the purge reschedules itself. */
export const PURGE_BATCH = 200;

/**
 * Lease timer. Runs at the lease's expiry. Does nothing when the lease it was set
 * for is gone (a renewal keeps the lease row, a claim or resume makes a new one,
 * so the old timer ends), or when the queue no longer has leases; follows a
 * renewal by rescheduling; otherwise returns the ticket to its queue, or
 * escalates it after `maxReturns` expiries, once.
 *
 * Args: `ticketId`, the `claimSeq` the timer was set for, and its `leaseId`.
 * Returns null. Throws no coded error.
 */
export const expireLease = internalMutation({
  args: { ticketId: v.id("tickets"), claimSeq: v.number(), leaseId: v.id("leases") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    const ticket = await ctx.db.get("tickets", args.ticketId);
    const lease = await ctx.db
      .query("leases")
      .withIndex("by_ticket", (q) => q.eq("ticketId", args.ticketId))
      .unique();
    if (!ticket || !lease || lease._id !== args.leaseId || ticket.claimSeq !== args.claimSeq) return null;
    const queue = await queueOf(env, ticket.queue);
    if (queue.policy.leaseMs === null) return null;
    if (lease.expiresAt > env.now) {
      await ctx.scheduler.runAt(lease.expiresAt, internal.internal_mutations.expireLease, args);
      return null;
    }
    await stopLease(env, ticket._id);
    const leaseExpiryCount = ticket.leaseExpiryCount + 1;
    const escalates =
      leaseExpiryCount >= queue.policy.maxReturns && queue.policy.escalateTo !== undefined && ticket.escalatedAt === undefined;
    if (escalates) {
      await escalateTicket(env, ticket, SYSTEM_PARTY, `lease expired ${leaseExpiryCount} times`, { leaseExpiryCount });
      return null;
    }
    await transition(
      env,
      ticket,
      {
        state: landingState(queue, "unstarted"),
        category: "unstarted",
        assigneeRef: undefined,
        assigneeKind: undefined,
        claimSeq: ticket.claimSeq + 1,
        leaseExpiryCount,
      },
      { type: "lease_expired", actor: SYSTEM_PARTY },
    );
    return null;
  },
});

/**
 * Due timer. Emits `due_breached` once, and escalates when the queue policy says so and the ticket has not escalated yet.
 * Does nothing when the due time changed, the breach was already recorded, or the ticket is done or canceled.
 *
 * Args: `ticketId` and the `dueAt` the timer was set for.
 * Returns null. Throws no coded error.
 */
export const dueTimer = internalMutation({
  args: { ticketId: v.id("tickets"), dueAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    const ticket = await ctx.db.get("tickets", args.ticketId);
    if (!ticket || ticket.dueAt !== args.dueAt || ticket.dueBreachedAt !== undefined) return null;
    if (ticket.category === "done" || ticket.category === "canceled") return null;
    const breached = await transition(
      env,
      ticket,
      { dueBreachedAt: env.now },
      { type: "due_breached", actor: SYSTEM_PARTY },
    );
    const queue = await queueOf(env, breached.queue);
    if (queue.policy.escalateOnDue === true && breached.escalatedAt === undefined) {
      await escalateTicket(env, breached, SYSTEM_PARTY, "due time passed");
    }
    return null;
  },
});

/**
 * Seal timer. Seals a ticket at the end of its reopen window. Does nothing when
 * the ticket was reopened since: its end time no longer matches the one the
 * timer was set for. A move between done (or canceled) states keeps the timer.
 *
 * Args: `ticketId` and `endedAt`, the end time the timer was set for.
 * Returns null. Throws no coded error.
 */
export const sealTimer = internalMutation({
  args: { ticketId: v.id("tickets"), endedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    const ticket = await ctx.db.get("tickets", args.ticketId);
    if (!ticket || ticket.closedAt !== undefined) return null;
    if ((ticket.resolvedAt ?? ticket.canceledAt) !== args.endedAt) return null;
    await seal(env, ticket, SYSTEM_PARTY);
    return null;
  },
});

/**
 * Retention purge. Deletes sealed tickets older than `retentionMs` with their
 * messages, history and links, in batches (a sealed ticket has no lease row), rescheduling itself until
 * nothing is left. Idempotent. Does nothing when retention is off (the default).
 *
 * Args: optional `batch`, the most rows to delete per kind in one pass (default `PURGE_BATCH`).
 * Returns `{ deleted, more }`: the rows deleted in this pass, and whether the purge rescheduled itself. Throws no coded error.
 */
export const purge = internalMutation({
  args: { batch: v.optional(v.number()) },
  returns: v.object({ deleted: v.number(), more: v.boolean() }),
  handler: async (ctx, args) => {
    const config = await loadConfig(ctx);
    if (config.retentionMs === undefined) return { deleted: 0, more: false };
    const env = await makeEnv(ctx);
    const batch = Math.max(1, Math.floor(args.batch ?? PURGE_BATCH));
    const cutoff = env.now - config.retentionMs;
    const ticket = await ctx.db
      .query("tickets")
      .withIndex("by_closed", (q) => q.gt("closedAt", 0).lt("closedAt", cutoff))
      .first();
    if (!ticket) return { deleted: 0, more: false };
    const id = ticket._id;
    const [messages, transitions, outgoing, incoming] = await Promise.all([
      ctx.db.query("messages").withIndex("by_ticket_seq", (q) => q.eq("ticketId", id)).take(batch),
      ctx.db.query("transitions").withIndex("by_ticket_seq", (q) => q.eq("ticketId", id)).take(batch),
      ctx.db.query("links").withIndex("by_ticket", (q) => q.eq("ticketId", id)).take(batch),
      ctx.db.query("links").withIndex("by_target", (q) => q.eq("toTicketId", id)).take(batch),
    ]);
    for (const link of outgoing) {
      if (link.relation === "blocks") await removeBlocker(env, link);
      else await ctx.db.delete("links", link._id);
    }
    await Promise.all([
      ...messages.map((row) => ctx.db.delete("messages", row._id)),
      ...transitions.map((row) => ctx.db.delete("transitions", row._id)),
      ...incoming.map((row) => ctx.db.delete("links", row._id)),
    ]);
    const deleted = messages.length + transitions.length + incoming.length + outgoing.length;
    const full = [messages, transitions, outgoing, incoming].some((list) => list.length === batch);
    if (!full) await ctx.db.delete("tickets", id);
    await ctx.scheduler.runAfter(0, internal.internal_mutations.purge, { batch });
    return { deleted: full ? deleted : deleted + 1, more: true };
  },
});
