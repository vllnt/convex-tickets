import { v } from "convex/values";
import {
  DEFAULT_PRIORITY,
  PRIORITY_MAX,
  PRIORITY_MIN,
  SYSTEM_PARTY,
  linkRelationValidator,
  partyValidator,
  resolutionValidator,
  scalarRecordValidator,
  ticketsError,
  visibilityValidator,
} from "../shared.js";
import type { Category, Party } from "../shared.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { mutation } from "./_generated/server.js";
import {
  addBlocker,
  addBlockers,
  afterEnd,
  assertCategory,
  assertHolder,
  assertHolderOrTrusted,
  assertNotSealed,
  assertQueue,
  assertRequesterOrTrusted,
  countOpenFor,
  escalateTicket,
  insertMessage,
  isCompleted,
  isEventHandle,
  isHeld,
  loadTicket,
  makeEnv,
  onBlockerEnded,
  onBlockerReopened,
  queueOf,
  rateLimit,
  recentTransitions,
  removeBlocker,
  renewLease,
  resumeTicket,
  seal,
  startLease,
  stopLease,
  transition,
  waitingLanding,
} from "./engine.js";
import type { Env, Ticket } from "./engine.js";
import {
  assertLength,
  checkAdditive,
  checkFields,
  landingState,
  resolveLimits,
  stateOf,
  validateQueueDef,
  withoutNulls,
} from "./queues.js";
import {
  claimResult,
  handoffResult,
  limitsInputValidator,
  moveResult,
  queueDefValidator,
  replyResult,
} from "./validators.js";

const ACTIVE: readonly Category[] = ["backlog", "unstarted", "started", "waiting"];
const ENDED: readonly Category[] = ["done", "canceled"];

function moved(t: Ticket): { queue: string; state: string; category: Category; claimSeq: number } {
  return { queue: t.queue, state: t.state, category: t.category, claimSeq: t.claimSeq };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, inner]) => `${JSON.stringify(k)}:${stableJson(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function checkReason(env: Env, reason: string | undefined): void {
  if (reason !== undefined) assertLength("reason", reason, env.limits.maxStringChars);
}

/**
 * Write the queue definitions, state names, field types, limits and hook handle.
 * Run once per deploy from the host (the client's `sync`). Additive only.
 */
export const sync = mutation({
  args: {
    queues: v.array(queueDefValidator),
    onEventHandle: v.optional(v.string()),
    limits: v.optional(limitsInputValidator),
    retentionMs: v.optional(v.number()),
  },
  returns: v.object({
    created: v.array(v.string()),
    updated: v.array(v.string()),
    unchanged: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    if (args.onEventHandle !== undefined && !isEventHandle(args.onEventHandle)) {
      throw ticketsError("INVALID_ARGUMENT", "onEventHandle must come from createFunctionHandle");
    }
    if (args.retentionMs !== undefined && !(Number.isFinite(args.retentionMs) && args.retentionMs > 0)) {
      throw ticketsError("INVALID_ARGUMENT", "retentionMs must be a positive finite number");
    }
    const limits = resolveLimits(args.limits);
    const names = args.queues.map((q) => q.name);
    if (new Set(names).size !== names.length) {
      throw ticketsError("INVALID_QUEUE", "two queues share a name");
    }
    const existing = await Promise.all(
      args.queues.map((def) =>
        ctx.db
          .query("queues")
          .withIndex("by_name", (q) => q.eq("name", def.name))
          .unique(),
      ),
    );
    const outside = [
      ...new Set(
        args.queues
          .map((q) => q.policy.escalateTo)
          .filter((name): name is string => name !== undefined && !names.includes(name)),
      ),
    ];
    const outsideRows = await Promise.all(
      outside.map((name) =>
        ctx.db
          .query("queues")
          .withIndex("by_name", (q) => q.eq("name", name))
          .unique(),
      ),
    );
    const known = new Set([...names, ...outside.filter((_, i) => outsideRows[i] !== null)]);
    const created: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    const now = Date.now();
    for (const [index, def] of args.queues.entries()) {
      validateQueueDef(def, known);
      const current = existing[index];
      if (!current) {
        await ctx.db.insert("queues", { ...def, schemaVersion: 1, updatedAt: now });
        created.push(def.name);
        continue;
      }
      const removed = checkAdditive(current, def);
      const inUse = await Promise.all(
        removed.map((state) =>
          ctx.db
            .query("tickets")
            .withIndex("by_queue_state", (q) => q.eq("queue", def.name).eq("state", state))
            .first(),
        ),
      );
      const busy = removed.find((_, i) => inUse[i] !== null);
      if (busy !== undefined) {
        throw ticketsError("STATE_IN_USE", `queue "${def.name}": state "${busy}" still has tickets`);
      }
      const before = stableJson({
        states: current.states,
        fields: current.fields,
        resultFields: current.resultFields,
        policy: current.policy,
      });
      const after = stableJson({
        states: def.states,
        fields: def.fields,
        resultFields: def.resultFields,
        policy: def.policy,
      });
      if (before === after) {
        unchanged.push(def.name);
        continue;
      }
      await ctx.db.patch("queues", current._id, {
        states: def.states,
        fields: def.fields,
        resultFields: def.resultFields,
        policy: def.policy,
        schemaVersion: current.schemaVersion + 1,
        updatedAt: now,
      });
      updated.push(def.name);
    }
    const config = await ctx.db.query("config").first();
    const row = { limits, onEventHandle: args.onEventHandle, retentionMs: args.retentionMs };
    if (config) await ctx.db.replace("config", config._id, row);
    else await ctx.db.insert("config", row);
    return { created, updated, unchanged };
  },
});

/** Open a ticket in a queue. A repeat with the same idempotency key returns the first ticket. */
export const open = mutation({
  args: {
    queue: v.string(),
    actor: partyValidator,
    title: v.string(),
    fields: v.optional(scalarRecordValidator),
    to: v.optional(v.string()),
    priority: v.optional(v.number()),
    subjectRef: v.optional(v.string()),
    parentId: v.optional(v.id("tickets")),
    blockedBy: v.optional(v.array(v.id("tickets"))),
    idempotencyKey: v.optional(v.string()),
    body: v.optional(v.string()),
  },
  returns: v.id("tickets"),
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    if (args.idempotencyKey !== undefined) {
      const previous = await ctx.db
        .query("tickets")
        .withIndex("by_requester_key", (q) =>
          q.eq("requesterRef", args.actor.ref).eq("idempotencyKey", args.idempotencyKey),
        )
        .first();
      if (previous) return previous._id;
    }
    const queue = await queueOf(env, args.queue);
    if (!args.title.trim()) throw ticketsError("INVALID_ARGUMENT", "title must not be empty");
    assertLength("title", args.title, env.limits.maxStringChars);
    if (args.body !== undefined) assertLength("body", args.body, env.limits.maxBodyChars);
    const priority = args.priority ?? DEFAULT_PRIORITY;
    if (!Number.isInteger(priority) || priority < PRIORITY_MIN || priority > PRIORITY_MAX) {
      throw ticketsError("INVALID_ARGUMENT", `priority must be an integer from ${PRIORITY_MIN} to ${PRIORITY_MAX}`);
    }
    const fields = args.fields ?? {};
    checkFields(queue.fields, fields, env.limits, { requireAll: true, label: "fields" });
    const target = args.to === undefined ? undefined : stateOf(queue, args.to);
    if (target && target.category !== "unstarted" && target.category !== "backlog") {
      throw ticketsError("INVALID_TARGET", `a ticket opens in an unstarted or backlog state, not "${target.name}"`);
    }
    if (args.parentId !== undefined) await loadTicket(env, args.parentId);
    await rateLimit(env, "open", args.actor.ref);
    const cap = queue.policy.maxOpenPerRequester;
    if ((await countOpenFor(env, args.actor.ref, queue.name, cap)) >= cap) {
      throw ticketsError("TOO_MANY_OPEN", `${args.actor.ref} already has ${cap} open tickets in "${queue.name}"`);
    }
    const dueAt = queue.policy.dueInMs === undefined ? undefined : env.now + queue.policy.dueInMs;
    const ticketId = await ctx.db.insert("tickets", {
      queue: queue.name,
      state: target?.name ?? landingState(queue, "unstarted"),
      category: target?.category ?? "unstarted",
      openBlockers: 0,
      priority,
      title: args.title,
      requesterRef: args.actor.ref,
      requesterKind: args.actor.kind,
      claimSeq: 0,
      subjectRef: args.subjectRef,
      fields: withoutNulls(fields),
      schemaVersion: queue.schemaVersion,
      parentId: args.parentId,
      dueAt,
      hopCount: 0,
      messageCount: 0,
      leaseExpiryCount: 0,
      transitionCount: 0,
      idempotencyKey: args.idempotencyKey,
      createdAt: env.now,
      updatedAt: env.now,
    });
    let ticket = await loadTicket(env, ticketId);
    const openBlockers = await addBlockers(env, ticket, args.blockedBy ?? [], args.actor, { isNew: true });
    if (args.body !== undefined) {
      ticket = (await insertMessage(env, ticket, { author: args.actor, visibility: "public", kind: "message", body: args.body })).ticket;
    }
    await transition(env, ticket, { openBlockers }, { type: "opened", actor: args.actor });
    if (dueAt !== undefined) {
      await ctx.scheduler.runAt(dueAt, internal.internal_mutations.dueTimer, { ticketId, dueAt });
    }
    return ticketId;
  },
});

async function claimTicket(env: Env, ticket: Ticket, actor: Party, to: string | undefined) {
  const queue = await queueOf(env, ticket.queue);
  const next = await transition(
    env,
    ticket,
    {
      state: landingState(queue, "started", to),
      category: "started",
      assigneeRef: actor.ref,
      assigneeKind: actor.kind,
      claimSeq: ticket.claimSeq + 1,
    },
    { type: "claimed", actor },
  );
  const leaseExpiresAt = await startLease(env, next);
  return { ok: true as const, ticketId: next._id, claimSeq: next.claimSeq, state: next.state, leaseExpiresAt };
}

async function nextClaimable(env: Env, queue: string, actor: Party): Promise<Ticket | null> {
  const range = (assigneeRef: string | undefined) =>
    env.ctx.db
      .query("tickets")
      .withIndex("by_queue_category", (q) =>
        q.eq("queue", queue).eq("category", "unstarted").eq("openBlockers", 0).eq("assigneeRef", assigneeRef),
      )
      .first();
  const [reserved, open] = await Promise.all([range(actor.ref), range(undefined)]);
  return reserved ?? open;
}

/**
 * Take a ticket, or the next claimable one in a queue. One transaction: of two
 * racing callers exactly one wins. Losing returns a reason instead of throwing.
 */
export const claim = mutation({
  args: {
    actor: partyValidator,
    ticketId: v.optional(v.id("tickets")),
    queue: v.optional(v.string()),
    to: v.optional(v.string()),
  },
  returns: claimResult,
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    if (args.ticketId === undefined) {
      if (args.queue === undefined) throw ticketsError("INVALID_ARGUMENT", "claim needs a ticketId or a queue");
      await queueOf(env, args.queue);
      const next = await nextClaimable(env, args.queue, args.actor);
      if (!next) return { ok: false as const, reason: "EMPTY" as const };
      return await claimTicket(env, next, args.actor, args.to);
    }
    const ticket = await loadTicket(env, args.ticketId);
    assertQueue(ticket, args.queue);
    const ticketId = ticket._id;
    if (isHeld(ticket.category)) {
      if (ticket.assigneeRef !== args.actor.ref) return { ok: false as const, reason: "TAKEN" as const, ticketId };
      const lease = await ctx.db
        .query("leases")
        .withIndex("by_ticket", (q) => q.eq("ticketId", ticketId))
        .unique();
      return { ok: true as const, ticketId, claimSeq: ticket.claimSeq, state: ticket.state, leaseExpiresAt: lease?.expiresAt };
    }
    if (ticket.category !== "unstarted") return { ok: false as const, reason: "NOT_CLAIMABLE" as const, ticketId };
    if (ticket.openBlockers > 0) return { ok: false as const, reason: "BLOCKED" as const, ticketId };
    if (ticket.assigneeRef !== undefined && ticket.assigneeRef !== args.actor.ref) {
      return { ok: false as const, reason: "RESERVED" as const, ticketId };
    }
    return await claimTicket(env, ticket, args.actor, args.to);
  },
});

/** Extend the holder's lease on a started ticket. A stale claim number gets `CLAIM_LOST`. No-op without a lease. */
export const renew = mutation({
  args: { ticketId: v.id("tickets"), actor: partyValidator, claimSeq: v.number() },
  returns: v.object({ expiresAt: v.union(v.number(), v.null()) }),
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    const ticket = await loadTicket(env, args.ticketId);
    assertNotSealed(ticket);
    await assertHolder(env, ticket, args.actor, args.claimSeq, ["started"], "renew");
    return { expiresAt: await renewLease(env, ticket) };
  },
});

/** Give a started ticket back to its queue. Holder, or a trusted host call. */
export const release = mutation({
  args: {
    ticketId: v.id("tickets"),
    actor: partyValidator,
    claimSeq: v.optional(v.number()),
    trusted: v.optional(v.boolean()),
    to: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  returns: moveResult,
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    const ticket = await loadTicket(env, args.ticketId);
    assertNotSealed(ticket);
    await assertHolderOrTrusted(env, ticket, args, ["started"], "release");
    checkReason(env, args.reason);
    const queue = await queueOf(env, ticket.queue);
    await stopLease(env, ticket._id);
    const next = await transition(
      env,
      ticket,
      {
        state: landingState(queue, "unstarted", args.to),
        category: "unstarted",
        assigneeRef: undefined,
        assigneeKind: undefined,
        claimSeq: ticket.claimSeq + 1,
      },
      { type: "released", actor: args.actor, reason: args.reason },
    );
    return moved(next);
  },
});

/**
 * Set or clear the assignee. A host move: call it only from trusted code.
 * Before start it reserves the ticket; on a held ticket it replaces the holder.
 */
export const assign = mutation({
  args: {
    ticketId: v.id("tickets"),
    actor: partyValidator,
    assignee: v.union(partyValidator, v.null()),
    reason: v.optional(v.string()),
  },
  returns: moveResult,
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    const ticket = await loadTicket(env, args.ticketId);
    assertNotSealed(ticket);
    assertCategory(ticket, ACTIVE, "assign");
    checkReason(env, args.reason);
    if (args.assignee === null && isHeld(ticket.category)) {
      throw ticketsError("HOLDER_REQUIRED", "a started or waiting ticket must keep a holder; release it instead");
    }
    const assigneeRef = args.assignee?.ref;
    if (assigneeRef === ticket.assigneeRef) return moved(ticket);
    const next = await transition(
      env,
      ticket,
      { assigneeRef, assigneeKind: args.assignee?.kind, claimSeq: ticket.claimSeq + 1 },
      { type: "assigned", actor: args.actor, reason: args.reason },
    );
    if (next.category === "started") await startLease(env, next);
    return moved(next);
  },
});

/**
 * Change the state inside one category, or between backlog and unstarted.
 * A held ticket needs its holder (or a trusted host call).
 */
export const move = mutation({
  args: {
    ticketId: v.id("tickets"),
    actor: partyValidator,
    to: v.string(),
    queue: v.optional(v.string()),
    claimSeq: v.optional(v.number()),
    trusted: v.optional(v.boolean()),
  },
  returns: moveResult,
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    const ticket = await loadTicket(env, args.ticketId);
    assertQueue(ticket, args.queue);
    assertNotSealed(ticket);
    const queue = await queueOf(env, ticket.queue);
    const target = stateOf(queue, args.to);
    const from = ticket.category;
    const acrossIntake =
      (from === "backlog" && target.category === "unstarted") || (from === "unstarted" && target.category === "backlog");
    if (target.category !== from && !acrossIntake) {
      throw ticketsError("INVALID_MOVE", `move stays inside one category; "${args.to}" is ${target.category}, the ticket is ${from}`);
    }
    if (from === "waiting") landingState(queue, "waiting", args.to, ticket.waitingOn);
    if (isHeld(from)) await assertHolderOrTrusted(env, ticket, args, [from], "move");
    if (target.name === ticket.state) return moved(ticket);
    const next = await transition(
      env,
      ticket,
      { state: target.name, category: target.category },
      { type: "moved", actor: args.actor },
    );
    return moved(next);
  },
});

/** The holder asks the requester for input. The ticket waits on the requester and the lease stops. */
export const requestInput = mutation({
  args: {
    ticketId: v.id("tickets"),
    actor: partyValidator,
    claimSeq: v.number(),
    body: v.string(),
    fields: v.optional(v.array(v.string())),
    to: v.optional(v.string()),
    queue: v.optional(v.string()),
  },
  returns: v.object({
    queue: v.string(),
    state: v.string(),
    category: v.literal("waiting"),
    claimSeq: v.number(),
    messageId: v.id("messages"),
  }),
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    const ticket = await loadTicket(env, args.ticketId);
    assertQueue(ticket, args.queue);
    assertNotSealed(ticket);
    await assertHolder(env, ticket, args.actor, args.claimSeq, ["started"], "requestInput");
    assertLength("body", args.body, env.limits.maxBodyChars);
    const queue = await queueOf(env, ticket.queue);
    for (const key of args.fields ?? []) {
      if (!queue.fields.some((f) => f.key === key)) {
        throw ticketsError("UNKNOWN_FIELD", `fields.${key} is not declared by the queue`);
      }
    }
    if (ticket.messageCount >= queue.policy.maxMessages) {
      throw ticketsError("MESSAGE_LIMIT", `the ticket already has ${queue.policy.maxMessages} messages`);
    }
    const state = await waitingLanding(env, ticket, "requester", args.to);
    const written = await insertMessage(env, ticket, {
      author: args.actor,
      visibility: "public",
      kind: "input_request",
      body: args.body,
      requestedFields: args.fields,
    });
    await stopLease(env, ticket._id);
    const next = await transition(
      env,
      written.ticket,
      { state, category: "waiting", waitingOn: "requester" },
      { type: "input_requested", actor: args.actor },
    );
    return { queue: next.queue, state: next.state, category: "waiting" as const, claimSeq: next.claimSeq, messageId: written.messageId };
  },
});

/**
 * Add a message to the thread. A requester reply to an input request supplies
 * fields and returns the ticket to work. Any other reply only adds a message.
 */
export const reply = mutation({
  args: {
    ticketId: v.id("tickets"),
    actor: partyValidator,
    body: v.string(),
    visibility: v.optional(visibilityValidator),
    fields: v.optional(scalarRecordValidator),
    idempotencyKey: v.optional(v.string()),
    queue: v.optional(v.string()),
  },
  returns: replyResult,
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    const ticket = await loadTicket(env, args.ticketId);
    assertQueue(ticket, args.queue);
    assertNotSealed(ticket);
    assertLength("body", args.body, env.limits.maxBodyChars);
    if (args.idempotencyKey !== undefined) {
      const previous = await ctx.db
        .query("messages")
        .withIndex("by_ticket_key", (q) => q.eq("ticketId", ticket._id).eq("idempotencyKey", args.idempotencyKey))
        .first();
      if (previous) return { ok: true as const, messageId: previous._id, resumed: false, duplicate: true };
    }
    const answers =
      ticket.category === "waiting" && ticket.waitingOn === "requester" && ticket.requesterRef === args.actor.ref;
    const queue = await queueOf(env, ticket.queue);
    const fields = args.fields ?? {};
    if (Object.keys(fields).length > 0) {
      if (!answers) {
        throw ticketsError("FIELDS_NOT_ACCEPTED", "only the requester answering an input request may supply fields");
      }
      checkFields(queue.fields, fields, env.limits, { requireAll: false, label: "fields" });
    }
    if (ticket.messageCount >= queue.policy.maxMessages) {
      const canEscalate = ACTIVE.includes(ticket.category) && ticket.escalatedAt === undefined;
      const escalated = canEscalate
        ? (await escalateTicket(env, ticket, SYSTEM_PARTY, `message limit of ${queue.policy.maxMessages} reached`)) !== null
        : false;
      return { ok: false as const, reason: "MESSAGE_LIMIT" as const, escalated };
    }
    await rateLimit(env, "message", args.actor.ref);
    const written = await insertMessage(env, ticket, {
      author: args.actor,
      visibility: args.visibility ?? "public",
      kind: "message",
      body: args.body,
      data: Object.keys(fields).length > 0 ? fields : undefined,
      idempotencyKey: args.idempotencyKey,
    });
    if (answers) {
      await resumeTicket(env, written.ticket, {
        type: "input_provided",
        actor: args.actor,
        patch: { fields: withoutNulls({ ...ticket.fields, ...fields }) },
      });
    }
    return { ok: true as const, messageId: written.messageId, resumed: answers, duplicate: false };
  },
});

/**
 * The holder pauses work. With blockers it links them and waits on them; without
 * them it waits on something outside until `resume`.
 */
export const hold = mutation({
  args: {
    ticketId: v.id("tickets"),
    actor: partyValidator,
    claimSeq: v.number(),
    blockers: v.optional(v.array(v.id("tickets"))),
    waitingOn: v.optional(v.union(v.literal("blockers"), v.literal("external"))),
    to: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  returns: moveResult,
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    const ticket = await loadTicket(env, args.ticketId);
    assertNotSealed(ticket);
    await assertHolder(env, ticket, args.actor, args.claimSeq, ["started"], "hold");
    checkReason(env, args.reason);
    const blockers = args.blockers ?? [];
    const onBlockers = blockers.length > 0 || args.waitingOn === "blockers";
    const added = await addBlockers(env, ticket, blockers, args.actor, { isNew: false });
    const openBlockers = ticket.openBlockers + added;
    if (onBlockers && openBlockers === 0) {
      throw ticketsError("NOT_BLOCKED", "every blocker is already completed; there is nothing to wait on");
    }
    const waitingOn = onBlockers ? "blockers" : "external";
    const state = await waitingLanding(env, ticket, waitingOn, args.to);
    await stopLease(env, ticket._id);
    const next = await transition(
      env,
      ticket,
      { state, category: "waiting", waitingOn, openBlockers },
      { type: "held", actor: args.actor, reason: args.reason },
    );
    return moved(next);
  },
});

/** Return a waiting ticket to work. Holder, or a trusted host call. */
export const resume = mutation({
  args: {
    ticketId: v.id("tickets"),
    actor: partyValidator,
    claimSeq: v.optional(v.number()),
    trusted: v.optional(v.boolean()),
    to: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  returns: moveResult,
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    const ticket = await loadTicket(env, args.ticketId);
    assertNotSealed(ticket);
    await assertHolderOrTrusted(env, ticket, args, ["waiting"], "resume");
    checkReason(env, args.reason);
    const next = await resumeTicket(env, ticket, { type: "resumed", actor: args.actor, to: args.to, reason: args.reason });
    return moved(next);
  },
});

async function pingPong(env: Env, ticket: Ticket, target: { queue: string; party?: Party }): Promise<boolean> {
  const history = await recentTransitions(env, ticket._id);
  const gaveAway = history.filter(
    (t) =>
      t.type === "handed_off" &&
      (target.party === undefined ? t.fromQueue === target.queue : t.fromAssigneeRef === target.party.ref),
  );
  return gaveAway.length >= 2;
}

async function refuseHandoff(env: Env, ticket: Ticket, reason: "HOP_LIMIT" | "PING_PONG") {
  const escalated =
    ticket.escalatedAt === undefined && (await escalateTicket(env, ticket, SYSTEM_PARTY, `handoff refused: ${reason}`)) !== null;
  return { ok: false as const, reason, escalated };
}

/**
 * Pass a started ticket to another queue (it lands unstarted) or to a named
 * party (it stays started for them). Counts one hop; the hop limit and the
 * ping-pong check refuse and escalate.
 */
export const handoff = mutation({
  args: {
    ticketId: v.id("tickets"),
    actor: partyValidator,
    claimSeq: v.number(),
    toQueue: v.optional(v.string()),
    toParty: v.optional(partyValidator),
    fields: v.optional(scalarRecordValidator),
    reason: v.optional(v.string()),
  },
  returns: handoffResult,
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    if (args.toQueue === undefined && args.toParty === undefined) {
      throw ticketsError("INVALID_ARGUMENT", "handoff needs toQueue, toParty or both");
    }
    const ticket = await loadTicket(env, args.ticketId);
    assertNotSealed(ticket);
    await assertHolder(env, ticket, args.actor, args.claimSeq, ["started"], "handoff");
    checkReason(env, args.reason);
    const queue = await queueOf(env, ticket.queue);
    const target = await queueOf(env, args.toQueue ?? ticket.queue);
    const fields = args.fields ?? {};
    checkFields(target.fields, fields, env.limits, { requireAll: false, label: "fields" });
    if (ticket.hopCount >= queue.policy.maxHops) return await refuseHandoff(env, ticket, "HOP_LIMIT");
    if (await pingPong(env, ticket, { queue: target.name, party: args.toParty })) {
      return await refuseHandoff(env, ticket, "PING_PONG");
    }
    const sameQueue = target.name === ticket.queue;
    const toParty = args.toParty;
    const patch = toParty
      ? {
          state: sameQueue ? ticket.state : landingState(target, "started"),
          category: "started" as const,
          assigneeRef: toParty.ref,
          assigneeKind: toParty.kind,
        }
      : {
          state: landingState(target, "unstarted"),
          category: "unstarted" as const,
          assigneeRef: undefined,
          assigneeKind: undefined,
        };
    await stopLease(env, ticket._id);
    const next = await transition(
      env,
      ticket,
      {
        ...patch,
        queue: target.name,
        claimSeq: ticket.claimSeq + 1,
        hopCount: ticket.hopCount + 1,
        fields: withoutNulls({ ...ticket.fields, ...fields }),
      },
      { type: "handed_off", actor: args.actor, reason: args.reason },
    );
    if (toParty) await startLease(env, next);
    return { ok: true as const, queue: next.queue, state: next.state, claimSeq: next.claimSeq };
  },
});

/**
 * Finish a started ticket with a resolution and a typed result. `completed`
 * clears the blocks this ticket holds on others; other endings clear nothing.
 */
export const resolve = mutation({
  args: {
    ticketId: v.id("tickets"),
    actor: partyValidator,
    claimSeq: v.number(),
    resolution: resolutionValidator,
    result: v.optional(scalarRecordValidator),
    body: v.optional(v.string()),
    to: v.optional(v.string()),
    queue: v.optional(v.string()),
  },
  returns: moveResult,
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    const ticket = await loadTicket(env, args.ticketId);
    assertQueue(ticket, args.queue);
    assertNotSealed(ticket);
    await assertHolder(env, ticket, args.actor, args.claimSeq, ["started"], "resolve");
    const queue = await queueOf(env, ticket.queue);
    const result = args.result ?? {};
    checkFields(queue.resultFields, result, env.limits, {
      requireAll: args.resolution === "completed",
      label: "result",
    });
    if (args.body !== undefined) assertLength("body", args.body, env.limits.maxBodyChars);
    const state = landingState(queue, "done", args.to);
    let current = ticket;
    if (args.body !== undefined) {
      current = (await insertMessage(env, current, { author: args.actor, visibility: "public", kind: "message", body: args.body })).ticket;
    }
    await stopLease(env, ticket._id);
    const done = await transition(
      env,
      current,
      { state, category: "done", resolution: args.resolution, result: withoutNulls(result), resolvedAt: env.now },
      { type: "resolved", actor: args.actor },
    );
    await onBlockerEnded(env, done);
    return moved(await afterEnd(env, done));
  },
});

/** Reopen a done or canceled ticket before it is sealed. Requester, or a trusted host call. */
export const reopen = mutation({
  args: {
    ticketId: v.id("tickets"),
    actor: partyValidator,
    trusted: v.optional(v.boolean()),
    to: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  returns: moveResult,
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    const ticket = await loadTicket(env, args.ticketId);
    assertNotSealed(ticket);
    assertCategory(ticket, ENDED, "reopen");
    assertRequesterOrTrusted(ticket, args.actor, args.trusted);
    checkReason(env, args.reason);
    const queue = await queueOf(env, ticket.queue);
    const wasCompleted = isCompleted(ticket);
    const next = await transition(
      env,
      ticket,
      {
        state: landingState(queue, "unstarted", args.to),
        category: "unstarted",
        waitingOn: undefined,
        assigneeRef: undefined,
        assigneeKind: undefined,
        claimSeq: ticket.claimSeq + 1,
        resolution: undefined,
        result: undefined,
        resolvedAt: undefined,
        canceledAt: undefined,
      },
      { type: "reopened", actor: args.actor, reason: args.reason },
    );
    if (wasCompleted) await onBlockerReopened(env, ticket._id);
    return moved(next);
  },
});

/** Seal a done or canceled ticket now. A host move. Final. */
export const close = mutation({
  args: { ticketId: v.id("tickets"), actor: partyValidator },
  returns: moveResult,
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    const ticket = await loadTicket(env, args.ticketId);
    assertNotSealed(ticket);
    assertCategory(ticket, ENDED, "close");
    return moved(await seal(env, ticket, args.actor));
  },
});

/** Call a ticket off. No result. Requester, or a trusted host call. */
export const cancel = mutation({
  args: {
    ticketId: v.id("tickets"),
    actor: partyValidator,
    trusted: v.optional(v.boolean()),
    to: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  returns: moveResult,
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    const ticket = await loadTicket(env, args.ticketId);
    assertNotSealed(ticket);
    assertCategory(ticket, ACTIVE, "cancel");
    assertRequesterOrTrusted(ticket, args.actor, args.trusted);
    checkReason(env, args.reason);
    const queue = await queueOf(env, ticket.queue);
    const state = landingState(queue, "canceled", args.to);
    await stopLease(env, ticket._id);
    const next = await transition(
      env,
      ticket,
      { state, category: "canceled", waitingOn: undefined, canceledAt: env.now },
      { type: "canceled", actor: args.actor, reason: args.reason },
    );
    await onBlockerEnded(env, next);
    return moved(await afterEnd(env, next));
  },
});

/** Send a ticket to its queue's escalation queue. Holder, or a trusted host call. */
export const escalate = mutation({
  args: {
    ticketId: v.id("tickets"),
    actor: partyValidator,
    claimSeq: v.optional(v.number()),
    trusted: v.optional(v.boolean()),
    reason: v.string(),
  },
  returns: moveResult,
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    const ticket = await loadTicket(env, args.ticketId);
    assertNotSealed(ticket);
    await assertHolderOrTrusted(env, ticket, args, ACTIVE, "escalate");
    checkReason(env, args.reason);
    const next = await escalateTicket(env, ticket, args.actor, args.reason);
    if (!next) throw ticketsError("NO_ESCALATION", `queue "${ticket.queue}" has no escalateTo`);
    return moved(next);
  },
});

async function findLink(
  env: Env,
  args: { ticketId: Id<"tickets">; relation: "blocks" | "duplicates" | "relates" | "ref"; toTicketId?: Id<"tickets">; refKind?: string; ref?: string },
) {
  if (args.relation === "ref") {
    return await env.ctx.db
      .query("links")
      .withIndex("by_ref", (q) => q.eq("refKind", args.refKind).eq("ref", args.ref).eq("ticketId", args.ticketId))
      .first();
  }
  return await env.ctx.db
    .query("links")
    .withIndex("by_ticket", (q) =>
      q.eq("ticketId", args.ticketId).eq("relation", args.relation).eq("toTicketId", args.toTicketId),
    )
    .first();
}

/**
 * Link a ticket to another ticket (`blocks`, `duplicates`, `relates`) or to an
 * outside thing (`ref`, with your own `refKind`, for example `label` or `agentThread`).
 * For `blocks`, `ticketId` is the blocker and `toTicketId` the ticket that waits.
 */
export const link = mutation({
  args: {
    ticketId: v.id("tickets"),
    actor: partyValidator,
    relation: linkRelationValidator,
    toTicketId: v.optional(v.id("tickets")),
    refKind: v.optional(v.string()),
    ref: v.optional(v.string()),
    label: v.optional(v.string()),
  },
  returns: v.id("links"),
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    const ticket = await loadTicket(env, args.ticketId);
    for (const [name, value] of [["refKind", args.refKind], ["ref", args.ref], ["label", args.label]] as const) {
      if (value !== undefined) assertLength(name, value, env.limits.maxStringChars);
    }
    const existing = await findLink(env, args);
    if (args.relation === "ref") {
      if (!args.refKind || !args.ref || args.toTicketId !== undefined) {
        throw ticketsError("INVALID_ARGUMENT", "a ref link needs refKind and ref, and no toTicketId");
      }
    } else if (args.toTicketId === undefined) {
      throw ticketsError("INVALID_ARGUMENT", `a ${args.relation} link needs toTicketId`);
    }
    if (existing) return existing._id;
    const toTicketId = args.toTicketId;
    if (args.relation === "blocks" && toTicketId) {
      const blocked = await loadTicket(env, toTicketId);
      assertNotSealed(blocked);
      const added = await addBlocker(env, blocked, ticket._id, args.actor, { isNew: false });
      if (added.open) await ctx.db.patch("tickets", blocked._id, { openBlockers: blocked.openBlockers + 1 });
      return added.linkId;
    }
    assertNotSealed(ticket);
    if (args.toTicketId !== undefined) {
      if (args.toTicketId === ticket._id) throw ticketsError("INVALID_ARGUMENT", "a ticket cannot link to itself");
      await loadTicket(env, args.toTicketId);
    }
    return await ctx.db.insert("links", {
      ticketId: ticket._id,
      relation: args.relation,
      toTicketId: args.toTicketId,
      refKind: args.refKind,
      ref: args.ref,
      label: args.label,
      createdByRef: args.actor.ref,
      createdAt: env.now,
    });
  },
});

/** Remove a link. Removing a blocks link keeps the waiting ticket's counter exact. */
export const unlink = mutation({
  args: { linkId: v.id("links") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const env = await makeEnv(ctx);
    const row = await ctx.db.get("links", args.linkId);
    if (!row) throw ticketsError("NOT_FOUND", `link ${args.linkId} does not exist`);
    if (row.relation === "blocks") await removeBlocker(env, row);
    else await ctx.db.delete("links", row._id);
    return null;
  },
});
