import { RateLimiter } from "@convex-dev/rate-limiter";
import type { FunctionHandle } from "convex/server";
import { LIMIT_CEILINGS, PRIORITY_MIN, SYSTEM_PARTY, ticketsError } from "../shared.js";
import type { Category, Limits, Party, TicketEvent, TransitionType, WaitingOn } from "../shared.js";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { landingState, loadConfig, loadQueue } from "./queues.js";

/** A ticket row as stored. */
export type Ticket = Doc<"tickets">;
/** A queue row as stored. */
export type Queue = Doc<"queues">;

const MINUTE = 60_000;
const rateLimiter = new RateLimiter(components.rateLimiter);

/** Everything one mutation needs: its ctx, one clock reading, the mount config and a queue cache. */
export interface Env {
  /** The mutation context. */
  ctx: MutationCtx;
  /** The clock reading every timestamp in this mutation uses. */
  now: number;
  /** The mount's limits, with defaults when `sync` has not run. */
  limits: Limits;
  /** The host hook's function handle, when one was synced. */
  onEventHandle?: string;
  /** Queue rows loaded so far, by name. */
  queues: Map<string, Queue>;
}

/**
 * Build the per-mutation environment.
 *
 * @param ctx - The mutation context.
 * @returns A fresh `Env`.
 */
export async function makeEnv(ctx: MutationCtx): Promise<Env> {
  const config = await loadConfig(ctx);
  return { ctx, now: Date.now(), limits: config.limits, onEventHandle: config.onEventHandle, queues: new Map() };
}

/**
 * Load a queue through the per-mutation cache.
 *
 * @param env - The mutation environment.
 * @param name - The queue name.
 * @returns The queue row.
 * @throws `UNKNOWN_QUEUE` when `sync` never wrote the queue.
 */
export async function queueOf(env: Env, name: string): Promise<Queue> {
  const cached = env.queues.get(name);
  if (cached) return cached;
  const queue = await loadQueue(env.ctx, name);
  env.queues.set(name, queue);
  return queue;
}

/**
 * Load a ticket by id.
 *
 * @param env - The mutation environment.
 * @param ticketId - The ticket id.
 * @returns The ticket row.
 * @throws `NOT_FOUND` when the ticket does not exist.
 */
export async function loadTicket(env: Env, ticketId: Id<"tickets">): Promise<Ticket> {
  const ticket = await env.ctx.db.get("tickets", ticketId);
  if (!ticket) throw ticketsError("NOT_FOUND", `ticket ${ticketId} does not exist`);
  return ticket;
}

/**
 * Refuse a closed ticket.
 *
 * @param ticket - The ticket being written.
 * @throws `SEALED` when the ticket is closed.
 */
export function assertNotSealed(ticket: Ticket): void {
  if (ticket.closedAt !== undefined) throw ticketsError("SEALED", "the ticket is closed and takes no more writes");
}

/**
 * Refuse a ticket the caller typed for a different queue.
 *
 * @param ticket - The ticket being written.
 * @param queue - The queue the caller expects, if it named one.
 * @throws `WRONG_QUEUE` when `queue` is given and the ticket is in another queue.
 */
export function assertQueue(ticket: Ticket, queue: string | undefined): void {
  if (queue !== undefined && ticket.queue !== queue) {
    throw ticketsError("WRONG_QUEUE", `the ticket is in queue "${ticket.queue}", not "${queue}"`);
  }
}

/**
 * Refuse a ticket that is in the wrong category for a verb.
 *
 * @param ticket - The ticket being written.
 * @param allowed - The categories the verb accepts.
 * @param verb - The verb name, for messages.
 * @throws `INVALID_MOVE` unless the ticket is in one of `allowed`.
 */
export function assertCategory(ticket: Ticket, allowed: readonly Category[], verb: string): void {
  if (!allowed.includes(ticket.category)) {
    throw ticketsError("INVALID_MOVE", `${verb} needs a ${allowed.join(" or ")} ticket; this one is ${ticket.category}`);
  }
}

/**
 * Check whether a ticket ended in the one way that clears a blocker.
 *
 * @param ticket - The ticket to check.
 * @returns True when the ticket is done with resolution `completed`.
 */
export function isCompleted(ticket: Ticket): boolean {
  return ticket.category === "done" && ticket.resolution === "completed";
}

/**
 * Check whether a category has a holder.
 *
 * @param category - The category to check.
 * @returns True for `started` and `waiting`.
 */
export function isHeld(category: Category): boolean {
  return category === "started" || category === "waiting";
}

async function leaseOf(env: Env, ticketId: Id<"tickets">): Promise<Doc<"leases"> | null> {
  return await env.ctx.db
    .query("leases")
    .withIndex("by_ticket", (q) => q.eq("ticketId", ticketId))
    .unique();
}

/**
 * The fence. Checks, in order: the claim number is current (else `CLAIM_LOST`),
 * the ticket is in a category the verb allows (else `INVALID_MOVE`), the caller
 * is the holder (else `NOT_HOLDER`), and in a lease queue a started ticket's
 * lease is still live (else `CLAIM_LOST`).
 *
 * @param env - The mutation environment.
 * @param ticket - The ticket being written.
 * @param actor - The party claiming to hold it.
 * @param claimSeq - The claim number the caller got from `claim`.
 * @param allowed - The categories the verb accepts.
 * @param verb - The verb name, for messages.
 * @throws `CLAIM_LOST` when the claim number is stale or the lease has expired.
 * @throws `INVALID_MOVE` when the ticket is not in one of `allowed`.
 * @throws `NOT_HOLDER` when `actor` does not hold the ticket.
 */
export async function assertHolder(
  env: Env,
  ticket: Ticket,
  actor: Party,
  claimSeq: number,
  allowed: readonly Category[],
  verb: string,
): Promise<void> {
  if (claimSeq !== ticket.claimSeq) {
    throw ticketsError("CLAIM_LOST", "the claim number is stale: the ticket changed hands");
  }
  assertCategory(ticket, allowed, verb);
  if (!isHeld(ticket.category) || ticket.assigneeRef !== actor.ref) {
    throw ticketsError("NOT_HOLDER", `${actor.ref} does not hold this ticket`);
  }
  if (ticket.category !== "started") return;
  const queue = await queueOf(env, ticket.queue);
  if (queue.policy.leaseMs === null) return;
  const lease = await leaseOf(env, ticket._id);
  if (!lease || lease.claimSeq !== ticket.claimSeq || lease.expiresAt <= env.now) {
    throw ticketsError("CLAIM_LOST", "the lease has expired");
  }
}

/**
 * Accept the holder, or anyone when the host vouches with `trusted`. A trusted
 * call still has to fit the verb's categories.
 *
 * @param env - The mutation environment.
 * @param ticket - The ticket being written.
 * @param args - The caller, its claim number and the trusted flag.
 * @param allowed - The categories the verb accepts.
 * @param verb - The verb name, for messages.
 * @throws `INVALID_MOVE` when the ticket is not in one of `allowed`.
 * @throws `INVALID_ARGUMENT` when the call is not trusted and has no claim number.
 * @throws `CLAIM_LOST` and `NOT_HOLDER` as `assertHolder` does, for a call that is not trusted.
 */
export async function assertHolderOrTrusted(
  env: Env,
  ticket: Ticket,
  args: { actor: Party; claimSeq?: number; trusted?: boolean },
  allowed: readonly Category[],
  verb: string,
): Promise<void> {
  if (args.trusted === true) {
    assertCategory(ticket, allowed, verb);
    return;
  }
  if (args.claimSeq === undefined) {
    throw ticketsError("INVALID_ARGUMENT", "claimSeq is required unless the host call is trusted");
  }
  await assertHolder(env, ticket, args.actor, args.claimSeq, allowed, verb);
}

/**
 * Accept the requester, or anyone when the host vouches with `trusted`.
 *
 * @param ticket - The ticket being written.
 * @param actor - The caller.
 * @param trusted - True when the host vouches for the call.
 * @throws `NOT_REQUESTER` when `actor` is not the requester and the call is not trusted.
 */
export function assertRequesterOrTrusted(ticket: Ticket, actor: Party, trusted: boolean | undefined): void {
  if (trusted !== true && ticket.requesterRef !== actor.ref) {
    throw ticketsError("NOT_REQUESTER", `only the requester (or a trusted host call) may do this`);
  }
}

/**
 * Consume one token of a per-party rate limit.
 *
 * @param env - The mutation environment.
 * @param name - `open` or `message`.
 * @param partyRef - The party the limit is counted for.
 * @throws `RATE_LIMITED` when the party is out of tokens. The error data carries `retryAt`.
 */
export async function rateLimit(env: Env, name: "open" | "message", partyRef: string): Promise<void> {
  const rate = name === "open" ? env.limits.opensPerMinute : env.limits.messagesPerMinute;
  const status = await rateLimiter.limit(env.ctx, name, {
    key: partyRef,
    config: { kind: "token bucket", rate, period: MINUTE, capacity: rate },
  });
  if (!status.ok) {
    throw ticketsError("RATE_LIMITED", `${partyRef} is over ${rate} ${name}s per minute`, {
      retryAt: env.now + status.retryAfter,
    });
  }
}

/** The fields of a ticket that a transition may change. */
export type TicketPatch = Partial<
  Pick<
    Ticket,
    | "queue"
    | "state"
    | "category"
    | "waitingOn"
    | "openBlockers"
    | "priority"
    | "assigneeRef"
    | "assigneeKind"
    | "claimSeq"
    | "fields"
    | "resolution"
    | "result"
    | "dueBreachedAt"
    | "hopCount"
    | "messageCount"
    | "leaseExpiryCount"
    | "escalatedAt"
    | "resolvedAt"
    | "canceledAt"
    | "closedAt"
  >
>;

/**
 * Apply one move: patch the ticket, append a transition row and schedule the host hook.
 *
 * @param env - The mutation environment.
 * @param ticket - The ticket as it was before the move.
 * @param patch - The changes. An `undefined` value clears the field.
 * @param meta - The transition type, who made it and an optional reason.
 * @returns The ticket as it is after the move.
 */
export async function transition(
  env: Env,
  ticket: Ticket,
  patch: TicketPatch,
  meta: { type: TransitionType; actor: Party; reason?: string },
): Promise<Ticket> {
  const seq = ticket.transitionCount + 1;
  const next: Ticket = { ...ticket, ...patch, transitionCount: seq, updatedAt: env.now };
  await env.ctx.db.patch("tickets", ticket._id, { ...patch, transitionCount: seq, updatedAt: env.now });
  const queueChanged = next.queue !== ticket.queue;
  const assigneeChanged = next.assigneeRef !== ticket.assigneeRef;
  await env.ctx.db.insert("transitions", {
    ticketId: ticket._id,
    seq,
    type: meta.type,
    fromState: meta.type === "opened" ? undefined : ticket.state,
    toState: next.state,
    fromCategory: meta.type === "opened" ? undefined : ticket.category,
    toCategory: next.category,
    actorRef: meta.actor.ref,
    actorKind: meta.actor.kind,
    fromQueue: queueChanged ? ticket.queue : undefined,
    toQueue: queueChanged ? next.queue : undefined,
    fromAssigneeRef: assigneeChanged ? ticket.assigneeRef : undefined,
    toAssigneeRef: assigneeChanged ? next.assigneeRef : undefined,
    reason: meta.reason,
    at: env.now,
  });
  await emit(env, next, ticket, meta);
  return next;
}

async function emit(
  env: Env,
  next: Ticket,
  before: Ticket,
  meta: { type: TransitionType; actor: Party; reason?: string },
): Promise<void> {
  const handle = env.onEventHandle;
  if (handle === undefined || !isEventHandle(handle)) return;
  const opened = meta.type === "opened";
  const event: TicketEvent = {
    ticketId: next._id,
    seq: next.transitionCount,
    type: meta.type,
    queue: next.queue,
    state: next.state,
    category: next.category,
    fromQueue: !opened && before.queue !== next.queue ? before.queue : undefined,
    fromState: opened ? undefined : before.state,
    fromCategory: opened ? undefined : before.category,
    waitingOn: next.waitingOn,
    blocked: next.openBlockers > 0,
    openBlockers: next.openBlockers,
    priority: next.priority,
    requesterRef: next.requesterRef,
    assigneeRef: next.assigneeRef,
    claimSeq: next.claimSeq,
    actor: meta.actor,
    reason: meta.reason,
    at: env.now,
  };
  await env.ctx.scheduler.runAfter(0, handle, event);
}

/**
 * Narrow a stored string to a host function handle. `sync` only stores strings
 * that came from `createFunctionHandle`, so this always holds for real rows.
 *
 * @param value - The stored handle.
 * @returns True when the string has the function-handle shape.
 */
export function isEventHandle(value: string): value is FunctionHandle<"mutation" | "action", TicketEvent> {
  return value.startsWith("function://");
}

/**
 * Start (or restart) the lease of a started ticket in a lease queue. No-op without a lease.
 *
 * @param env - The mutation environment.
 * @param ticket - The ticket after the move, with its new holder and claim number.
 * @returns When the lease expires, or undefined in a queue without a lease.
 */
export async function startLease(env: Env, ticket: Ticket): Promise<number | undefined> {
  await stopLease(env, ticket._id);
  const queue = await queueOf(env, ticket.queue);
  if (queue.policy.leaseMs === null || ticket.assigneeRef === undefined) return undefined;
  const expiresAt = env.now + queue.policy.leaseMs;
  const leaseId = await env.ctx.db.insert("leases", {
    ticketId: ticket._id,
    partyRef: ticket.assigneeRef,
    claimSeq: ticket.claimSeq,
    expiresAt,
  });
  await env.ctx.scheduler.runAt(expiresAt, internal.internal_mutations.expireLease, {
    ticketId: ticket._id,
    claimSeq: ticket.claimSeq,
    leaseId,
  });
  return expiresAt;
}

/**
 * Remove a ticket's lease row, if any.
 *
 * @param env - The mutation environment.
 * @param ticketId - The ticket.
 */
export async function stopLease(env: Env, ticketId: Id<"tickets">): Promise<void> {
  const lease = await leaseOf(env, ticketId);
  if (lease) await env.ctx.db.delete("leases", lease._id);
}

/**
 * Extend a live lease. The caller already passed the fence.
 *
 * @param env - The mutation environment.
 * @param ticket - The started ticket.
 * @returns The new expiry, or null when the queue has no lease or the ticket is not started.
 */
export async function renewLease(env: Env, ticket: Ticket): Promise<number | null> {
  const queue = await queueOf(env, ticket.queue);
  const lease = await leaseOf(env, ticket._id);
  if (queue.policy.leaseMs === null || !lease) return null;
  const expiresAt = env.now + queue.policy.leaseMs;
  await env.ctx.db.patch("leases", lease._id, { expiresAt });
  return expiresAt;
}

/**
 * After a ticket reaches done or canceled: seal it now (window 0) or set the seal timer.
 *
 * @param env - The mutation environment.
 * @param ticket - The ticket after it ended.
 * @returns The ticket, sealed when the window is 0.
 */
export async function afterEnd(env: Env, ticket: Ticket): Promise<Ticket> {
  const queue = await queueOf(env, ticket.queue);
  const window = queue.policy.reopenWindowMs;
  if (window === null) return ticket;
  if (window === 0) return await seal(env, ticket, SYSTEM_PARTY);
  await env.ctx.scheduler.runAt(env.now + window, internal.internal_mutations.sealTimer, {
    ticketId: ticket._id,
    endedAt: env.now,
  });
  return ticket;
}

/**
 * Seal a done or canceled ticket. Final.
 *
 * @param env - The mutation environment.
 * @param ticket - The ticket to seal.
 * @param actor - Who seals it.
 * @returns The ticket after the move, with `closedAt` set.
 */
export async function seal(env: Env, ticket: Ticket, actor: Party): Promise<Ticket> {
  return await transition(env, ticket, { closedAt: env.now }, { type: "closed", actor });
}

/**
 * Return a waiting ticket to work: land on a started state, restart the lease.
 *
 * @param env - The mutation environment.
 * @param ticket - The waiting ticket.
 * @param meta - The transition type (`resumed` or `input_provided`), actor, optional target state, reason and extra patch.
 * @returns The ticket after the move.
 * @throws `UNKNOWN_STATE` or `INVALID_TARGET` when `meta.to` is not a started state of the queue.
 */
export async function resumeTicket(
  env: Env,
  ticket: Ticket,
  meta: { type: "resumed" | "input_provided"; actor: Party; to?: string; reason?: string; patch?: TicketPatch },
): Promise<Ticket> {
  const queue = await queueOf(env, ticket.queue);
  const state = landingState(queue, "started", meta.to);
  const next = await transition(
    env,
    ticket,
    { ...meta.patch, state, category: "started", waitingOn: undefined },
    { type: meta.type, actor: meta.actor, reason: meta.reason },
  );
  await startLease(env, next);
  return next;
}

/**
 * Move a ticket to the unstarted landing state of its queue's escalation target.
 * Exempt from the hop limit. Raises priority by one step.
 *
 * @param env - The mutation environment.
 * @param ticket - The ticket to escalate, in any category before done.
 * @param actor - Who escalates (the system party for automatic trips).
 * @param reason - Why, stored on the transition.
 * @param extra - More changes to apply in the same move.
 * @returns The ticket after the move, or null when its queue has no `escalateTo`.
 */
export async function escalateTicket(
  env: Env,
  ticket: Ticket,
  actor: Party,
  reason: string,
  extra: TicketPatch = {},
): Promise<Ticket | null> {
  const queue = await queueOf(env, ticket.queue);
  const targetName = queue.policy.escalateTo;
  if (targetName === undefined) return null;
  const target = await queueOf(env, targetName);
  await stopLease(env, ticket._id);
  return await transition(
    env,
    ticket,
    {
      ...extra,
      queue: target.name,
      state: landingState(target, "unstarted"),
      category: "unstarted",
      waitingOn: undefined,
      assigneeRef: undefined,
      assigneeKind: undefined,
      claimSeq: ticket.claimSeq + 1,
      priority: Math.max(PRIORITY_MIN, ticket.priority - 1),
      escalatedAt: env.now,
    },
    { type: "escalated", actor, reason },
  );
}

/**
 * Reads take the ceiling, not the current limit: lowering a limit after links
 * exist must not hide them, or a cascade would skip dependents and a cycle walk
 * would miss edges. Only the cap checks use `env.limits`.
 */
async function blockerLinks(env: Env, blockerId: Id<"tickets">): Promise<Doc<"links">[]> {
  return await env.ctx.db
    .query("links")
    .withIndex("by_ticket", (q) => q.eq("ticketId", blockerId).eq("relation", "blocks"))
    .take(LIMIT_CEILINGS.maxBlocked);
}

async function blockersOf(env: Env, ticketId: Id<"tickets">): Promise<Doc<"links">[]> {
  return await env.ctx.db
    .query("links")
    .withIndex("by_target", (q) => q.eq("toTicketId", ticketId).eq("relation", "blocks"))
    .take(LIMIT_CEILINGS.maxBlockers);
}

async function dependentsOf(env: Env, blockerId: Id<"tickets">): Promise<Ticket[]> {
  const links = await blockerLinks(env, blockerId);
  const tickets = await Promise.all(
    links.map((link) => (link.toTicketId ? env.ctx.db.get("tickets", link.toTicketId) : null)),
  );
  return tickets.filter((t): t is Ticket => t !== null && t.closedAt === undefined);
}

/**
 * Refuse a blocks link that would close a cycle: walk upstream from the blocker
 * and fail if the blocked ticket is already among its prerequisites.
 */
async function assertNoCycle(env: Env, blockerId: Id<"tickets">, blockedId: Id<"tickets">): Promise<void> {
  if (blockerId === blockedId) throw ticketsError("CYCLE", "a ticket cannot block itself");
  const seen = new Set<Id<"tickets">>([blockerId]);
  let frontier: Id<"tickets">[] = [blockerId];
  while (frontier.length > 0) {
    const levels = await Promise.all(frontier.map((id) => blockersOf(env, id)));
    const nextFrontier: Id<"tickets">[] = [];
    for (const link of levels.flat()) {
      if (link.ticketId === blockedId) throw ticketsError("CYCLE", "this link would close a cycle of blockers");
      if (seen.has(link.ticketId)) continue;
      seen.add(link.ticketId);
      if (seen.size > env.limits.maxGraphWalk) {
        throw ticketsError("GRAPH_TOO_DEEP", `the blocker chain is longer than ${env.limits.maxGraphWalk} tickets`);
      }
      nextFrontier.push(link.ticketId);
    }
    frontier = nextFrontier;
  }
}

/**
 * Add one blocks link from `blockerId` to `blocked`, checking both caps and the cycle walk.
 * Does not patch `blocked`: the caller adds to `openBlockers` when `open` is true.
 *
 * @param env - The mutation environment.
 * @param blocked - The ticket that must wait.
 * @param blockerId - The prerequisite.
 * @param actor - Who links them.
 * @param options - `isNew` skips the cycle walk for a ticket that blocks nothing yet.
 * @returns The new link id, and whether the blocker still counts as open.
 * @throws `NOT_FOUND` when the blocker does not exist.
 * @throws `TOO_MANY_BLOCKERS` or `TOO_MANY_BLOCKED` when a blocker cap would be passed.
 * @throws `INVALID_ARGUMENT` when the blocker ended without completing, so it can never clear.
 * @throws `CYCLE` or `GRAPH_TOO_DEEP` when the walk finds a cycle, or the blocker chain is too long to check.
 */
export async function addBlocker(
  env: Env,
  blocked: Ticket,
  blockerId: Id<"tickets">,
  actor: Party,
  options: { isNew: boolean },
): Promise<{ linkId: Id<"links">; open: boolean }> {
  const [existing, blocker, dependents] = await Promise.all([
    blockersOf(env, blocked._id),
    loadTicket(env, blockerId),
    blockerLinks(env, blockerId),
  ]);
  if (existing.length >= env.limits.maxBlockers) {
    throw ticketsError("TOO_MANY_BLOCKERS", `a ticket can have at most ${env.limits.maxBlockers} blockers`);
  }
  if (dependents.length >= env.limits.maxBlocked) {
    throw ticketsError("TOO_MANY_BLOCKED", `a ticket can block at most ${env.limits.maxBlocked} others`);
  }
  const ended = blocker.category === "done" || blocker.category === "canceled";
  if (ended && !isCompleted(blocker)) {
    throw ticketsError("INVALID_ARGUMENT", `blocker ${blockerId} ended without completing, so it can never clear`);
  }
  if (!options.isNew) await assertNoCycle(env, blockerId, blocked._id);
  const linkId = await env.ctx.db.insert("links", {
    ticketId: blockerId,
    relation: "blocks",
    toTicketId: blocked._id,
    createdByRef: actor.ref,
    createdAt: env.now,
  });
  return { linkId, open: !isCompleted(blocker) };
}

/**
 * Add blocks links from each blocker to `blocked`, skipping links that already exist.
 *
 * @param env - The mutation environment.
 * @param blocked - The ticket that must wait.
 * @param blockerIds - The prerequisites.
 * @param actor - Who links them.
 * @param options - `isNew` skips the cycle walk for a ticket that blocks nothing yet.
 * @returns How many of the new links point at a blocker that is not completed.
 */
export async function addBlockers(
  env: Env,
  blocked: Ticket,
  blockerIds: readonly Id<"tickets">[],
  actor: Party,
  options: { isNew: boolean },
): Promise<number> {
  const existing = await blockersOf(env, blocked._id);
  const fresh = [...new Set(blockerIds)].filter((id) => !existing.some((l) => l.ticketId === id));
  let open = 0;
  for (const id of fresh) {
    const added = await addBlocker(env, blocked, id, actor, options);
    if (added.open) open += 1;
  }
  return open;
}

/**
 * Lower a dependent's counter by one and act when it reaches zero: an item
 * nobody holds gets `unblocked`, a holder waiting on blockers resumes.
 */
async function releaseOne(env: Env, dependent: Ticket): Promise<void> {
  const openBlockers = Math.max(0, dependent.openBlockers - 1);
  if (openBlockers > 0 || dependent.category === "done" || dependent.category === "canceled") {
    await env.ctx.db.patch("tickets", dependent._id, { openBlockers });
    return;
  }
  if (dependent.category === "waiting" && dependent.waitingOn === "blockers") {
    await resumeTicket(env, dependent, { type: "resumed", actor: SYSTEM_PARTY, patch: { openBlockers } });
  } else if (dependent.category === "backlog" || dependent.category === "unstarted") {
    await transition(env, dependent, { openBlockers }, { type: "unblocked", actor: SYSTEM_PARTY });
  } else {
    await env.ctx.db.patch("tickets", dependent._id, { openBlockers });
  }
}

/**
 * Tell every dependent that a blocker ended. `completed` clears one blocker each;
 * any other ending clears nothing, emits `blocker_failed` and resumes held waiters.
 * Dependents that are done or canceled are left alone.
 *
 * @param env - The mutation environment.
 * @param blocker - The ticket that just reached done or canceled.
 */
export async function onBlockerEnded(env: Env, blocker: Ticket): Promise<void> {
  const dependents = await dependentsOf(env, blocker._id);
  const completed = isCompleted(blocker);
  for (const dependent of dependents) {
    if (completed) {
      await releaseOne(env, dependent);
      continue;
    }
    if (dependent.category === "done" || dependent.category === "canceled") continue;
    const reason = `blocker ${blocker._id} ended as ${blocker.resolution ?? "canceled"}`;
    const failed = await transition(env, dependent, {}, { type: "blocker_failed", actor: SYSTEM_PARTY, reason });
    if (failed.category === "waiting" && failed.waitingOn === "blockers") {
      await resumeTicket(env, failed, { type: "resumed", actor: SYSTEM_PARTY, reason });
    }
  }
}

/**
 * A completed blocker was reopened: each dependent counts it as open again.
 *
 * @param env - The mutation environment.
 * @param blockerId - The reopened ticket.
 */
export async function onBlockerReopened(env: Env, blockerId: Id<"tickets">): Promise<void> {
  const dependents = await dependentsOf(env, blockerId);
  for (const dependent of dependents) {
    await env.ctx.db.patch("tickets", dependent._id, { openBlockers: dependent.openBlockers + 1 });
  }
}

/**
 * Delete a blocks link and keep the dependent's counter exact.
 *
 * @param env - The mutation environment.
 * @param link - The blocks link.
 */
export async function removeBlocker(env: Env, link: Doc<"links">): Promise<void> {
  await env.ctx.db.delete("links", link._id);
  if (link.toTicketId === undefined) return;
  const [blocker, dependent] = await Promise.all([
    env.ctx.db.get("tickets", link.ticketId),
    env.ctx.db.get("tickets", link.toTicketId),
  ]);
  if (!dependent || dependent.closedAt !== undefined) return;
  if (blocker && isCompleted(blocker)) return;
  await releaseOne(env, dependent);
}

/**
 * Count a requester's active tickets in one queue, reading at most `cap` rows per category.
 *
 * @param env - The mutation environment.
 * @param requesterRef - The requester.
 * @param queue - The queue name.
 * @param cap - The most rows to read per category, and the most this returns.
 * @returns The count, capped at `cap`.
 */
export async function countOpenFor(env: Env, requesterRef: string, queue: string, cap: number): Promise<number> {
  const counts = await Promise.all(
    (["backlog", "unstarted", "started", "waiting"] as const).map(async (category) => {
      const rows = await env.ctx.db
        .query("tickets")
        .withIndex("by_requester_queue", (q) =>
          q.eq("requesterRef", requesterRef).eq("queue", queue).eq("category", category),
        )
        .take(cap);
      return rows.length;
    }),
  );
  return Math.min(
    cap,
    counts.reduce((sum, n) => sum + n, 0),
  );
}

/**
 * Pick the waiting state a ticket lands in for a given wait.
 *
 * @param env - The mutation environment.
 * @param ticket - The ticket that will wait.
 * @param waitingOn - What it waits on.
 * @param to - An explicit waiting state, if the caller chose one.
 * @returns The waiting state to land on.
 * @throws `UNKNOWN_STATE` or `INVALID_TARGET` when `to` is not a waiting state that fits `waitingOn`.
 * @throws `NO_LANDING_STATE` when the queue has no waiting state that fits.
 */
export async function waitingLanding(env: Env, ticket: Ticket, waitingOn: WaitingOn, to?: string): Promise<string> {
  const queue = await queueOf(env, ticket.queue);
  return landingState(queue, "waiting", to, waitingOn);
}

/**
 * Append one message and bump the ticket's message count.
 *
 * @param env - The mutation environment.
 * @param ticket - The ticket the message belongs to.
 * @param message - Author, visibility, kind, body and optional data.
 * @returns The new message id and the ticket with its new count.
 */
export async function insertMessage(
  env: Env,
  ticket: Ticket,
  message: {
    author: Party;
    visibility: "public" | "internal";
    kind: "message" | "input_request" | "system";
    body: string;
    data?: Record<string, string | number | boolean | null>;
    requestedFields?: string[];
    idempotencyKey?: string;
  },
): Promise<{ messageId: Id<"messages">; ticket: Ticket }> {
  const seq = ticket.messageCount + 1;
  const messageId = await env.ctx.db.insert("messages", {
    ticketId: ticket._id,
    seq,
    authorRef: message.author.ref,
    authorKind: message.author.kind,
    visibility: message.visibility,
    kind: message.kind,
    body: message.body,
    data: message.data,
    requestedFields: message.requestedFields,
    idempotencyKey: message.idempotencyKey,
    createdAt: env.now,
  });
  await env.ctx.db.patch("tickets", ticket._id, { messageCount: seq });
  return { messageId, ticket: { ...ticket, messageCount: seq } };
}

/**
 * Read the most recent transitions of a ticket, newest first. A bounded read.
 *
 * @param env - The mutation environment.
 * @param ticketId - The ticket.
 * @returns Up to 50 recent transitions.
 */
export async function recentTransitions(env: Env, ticketId: Id<"tickets">): Promise<Doc<"transitions">[]> {
  return await env.ctx.db
    .query("transitions")
    .withIndex("by_ticket_seq", (q) => q.eq("ticketId", ticketId))
    .order("desc")
    .take(50);
}
