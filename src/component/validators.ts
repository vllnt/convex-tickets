import { v } from "convex/values";
import type { Infer } from "convex/values";
import {
  categoryValidator,
  fieldTypeValidator,
  linkRelationValidator,
  messageKindValidator,
  partyKindValidator,
  resolutionValidator,
  scalarRecordValidator,
  transitionTypeValidator,
  visibilityValidator,
  waitingOnValidator,
  waitTargetValidator,
} from "../shared.js";

/** One named state of a queue. `on` only applies to waiting states. */
export const stateDefValidator = v.object({
  name: v.string(),
  category: categoryValidator,
  on: v.optional(waitTargetValidator),
});
/** A named state: its name, category and optional wait target. */
export type StateDef = Infer<typeof stateDefValidator>;

/** One declared ticket field or result field. `options` only applies to `enum`. */
export const fieldDefValidator = v.object({
  key: v.string(),
  type: fieldTypeValidator,
  required: v.boolean(),
  options: v.optional(v.array(v.string())),
});
/** A declared field: its key, type, required flag and enum options. */
export type FieldDef = Infer<typeof fieldDefValidator>;

/** A queue's policy, with every default already applied. */
export const policyValidator = v.object({
  leaseMs: v.union(v.number(), v.null()),
  dueInMs: v.optional(v.number()),
  reopenWindowMs: v.union(v.number(), v.null()),
  maxHops: v.number(),
  maxReturns: v.number(),
  maxMessages: v.number(),
  maxOpenPerRequester: v.number(),
  escalateTo: v.optional(v.string()),
  escalateOnDue: v.optional(v.boolean()),
});
/** A queue policy with every default applied. */
export type Policy = Infer<typeof policyValidator>;

/** A queue definition as the client sends it to `sync`. */
export const queueDefValidator = v.object({
  name: v.string(),
  states: v.array(stateDefValidator),
  fields: v.array(fieldDefValidator),
  resultFields: v.array(fieldDefValidator),
  policy: policyValidator,
});
/** A queue definition: name, states, fields, result fields and policy. */
export type QueueDef = Infer<typeof queueDefValidator>;

/** Mount-wide limits, every key optional on input. */
export const limitsInputValidator = v.object({
  maxBodyChars: v.optional(v.number()),
  maxStringChars: v.optional(v.number()),
  maxFields: v.optional(v.number()),
  maxBlockers: v.optional(v.number()),
  maxBlocked: v.optional(v.number()),
  maxGraphWalk: v.optional(v.number()),
  opensPerMinute: v.optional(v.number()),
  messagesPerMinute: v.optional(v.number()),
});

/** Mount-wide limits with every key set. This is the stored form. */
export const limitsValidator = v.object({
  maxBodyChars: v.number(),
  maxStringChars: v.number(),
  maxFields: v.number(),
  maxBlockers: v.number(),
  maxBlocked: v.number(),
  maxGraphWalk: v.number(),
  opensPerMinute: v.number(),
  messagesPerMinute: v.number(),
});

/** The public shape of a ticket. */
export const ticketView = v.object({
  ticketId: v.id("tickets"),
  queue: v.string(),
  state: v.string(),
  category: categoryValidator,
  waitingOn: v.optional(waitingOnValidator),
  openBlockers: v.number(),
  priority: v.number(),
  title: v.string(),
  requesterRef: v.string(),
  requesterKind: partyKindValidator,
  assigneeRef: v.optional(v.string()),
  assigneeKind: v.optional(partyKindValidator),
  claimSeq: v.number(),
  subjectRef: v.optional(v.string()),
  fields: scalarRecordValidator,
  schemaVersion: v.number(),
  resolution: v.optional(resolutionValidator),
  result: v.optional(scalarRecordValidator),
  parentId: v.optional(v.id("tickets")),
  dueAt: v.optional(v.number()),
  dueBreachedAt: v.optional(v.number()),
  hopCount: v.number(),
  messageCount: v.number(),
  leaseExpiryCount: v.number(),
  escalatedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
  resolvedAt: v.optional(v.number()),
  canceledAt: v.optional(v.number()),
  closedAt: v.optional(v.number()),
});

/** The public shape of a message. */
export const messageView = v.object({
  messageId: v.id("messages"),
  ticketId: v.id("tickets"),
  seq: v.number(),
  authorRef: v.string(),
  authorKind: partyKindValidator,
  visibility: visibilityValidator,
  kind: messageKindValidator,
  body: v.string(),
  data: v.optional(scalarRecordValidator),
  requestedFields: v.optional(v.array(v.string())),
  createdAt: v.number(),
});

/** The public shape of a link. */
export const linkView = v.object({
  linkId: v.id("links"),
  ticketId: v.id("tickets"),
  relation: linkRelationValidator,
  toTicketId: v.optional(v.id("tickets")),
  refKind: v.optional(v.string()),
  ref: v.optional(v.string()),
  label: v.optional(v.string()),
  createdByRef: v.string(),
  createdAt: v.number(),
});

/** The public shape of a history entry. */
export const transitionView = v.object({
  ticketId: v.id("tickets"),
  seq: v.number(),
  type: transitionTypeValidator,
  fromState: v.optional(v.string()),
  toState: v.string(),
  fromCategory: v.optional(categoryValidator),
  toCategory: categoryValidator,
  actorRef: v.string(),
  actorKind: partyKindValidator,
  fromQueue: v.optional(v.string()),
  toQueue: v.optional(v.string()),
  fromAssigneeRef: v.optional(v.string()),
  toAssigneeRef: v.optional(v.string()),
  reason: v.optional(v.string()),
  at: v.number(),
});

/** A blocker of a ticket, as `get` returns it. */
export const blockerView = v.object({
  linkId: v.id("links"),
  ticketId: v.id("tickets"),
  state: v.string(),
  category: categoryValidator,
  resolution: v.optional(resolutionValidator),
  completed: v.boolean(),
});

/** What `get` returns: the ticket, its lease expiry, links, blockers and recent messages. */
export const ticketDetail = v.object({
  ticket: ticketView,
  leaseExpiresAt: v.optional(v.number()),
  links: v.array(linkView),
  blockers: v.array(blockerView),
  messages: v.array(messageView),
});

/** The public shape of a stored queue definition. */
export const queueView = v.object({
  name: v.string(),
  states: v.array(stateDefValidator),
  fields: v.array(fieldDefValidator),
  resultFields: v.array(fieldDefValidator),
  policy: policyValidator,
  schemaVersion: v.number(),
  updatedAt: v.number(),
});

/** Every claim outcome. Losing a race is a result, not an error. */
export const claimResult = v.union(
  v.object({
    ok: v.literal(true),
    ticketId: v.id("tickets"),
    claimSeq: v.number(),
    state: v.string(),
    leaseExpiresAt: v.optional(v.number()),
  }),
  v.object({
    ok: v.literal(false),
    reason: v.union(
      v.literal("TAKEN"),
      v.literal("BLOCKED"),
      v.literal("RESERVED"),
      v.literal("EMPTY"),
      v.literal("NOT_CLAIMABLE"),
    ),
    ticketId: v.optional(v.id("tickets")),
  }),
);

/** Every reply outcome. A full thread is a result (`MESSAGE_LIMIT`), not an error. */
export const replyResult = v.union(
  v.object({
    ok: v.literal(true),
    messageId: v.id("messages"),
    resumed: v.boolean(),
    duplicate: v.boolean(),
  }),
  v.object({ ok: v.literal(false), reason: v.literal("MESSAGE_LIMIT"), escalated: v.boolean() }),
);

/** Every handoff outcome. Hitting the hop limit or a ping-pong is a result, not an error. */
export const handoffResult = v.union(
  v.object({ ok: v.literal(true), queue: v.string(), state: v.string(), claimSeq: v.number() }),
  v.object({
    ok: v.literal(false),
    reason: v.union(v.literal("HOP_LIMIT"), v.literal("PING_PONG")),
    escalated: v.boolean(),
  }),
);

/** The state a move left the ticket in. */
export const moveResult = v.object({
  queue: v.string(),
  state: v.string(),
  category: categoryValidator,
  claimSeq: v.number(),
});
