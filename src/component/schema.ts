import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  categoryValidator,
  linkRelationValidator,
  messageKindValidator,
  partyKindValidator,
  resolutionValidator,
  scalarRecordValidator,
  transitionTypeValidator,
  visibilityValidator,
  waitingOnValidator,
} from "../shared.js";
import {
  fieldDefValidator,
  limitsValidator,
  policyValidator,
  stateDefValidator,
} from "./validators.js";

/**
 * The component's tables: `queues`, `tickets`, `leases`, `messages`, `links`,
 * `transitions` and `config`. The host never reads them directly: it goes
 * through the component's queries and mutations.
 */
export default defineSchema({
  /** One row per synced queue: states, declared fields, result fields, policy and schema version. */
  queues: defineTable({
    name: v.string(),
    states: v.array(stateDefValidator),
    fields: v.array(fieldDefValidator),
    resultFields: v.array(fieldDefValidator),
    schemaVersion: v.number(),
    policy: policyValidator,
    updatedAt: v.number(),
  }).index("by_name", ["name"]),

  /** One row per ticket. The indexes serve claiming, the list filters, idempotent opens, retention and title search. */
  tickets: defineTable({
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
    transitionCount: v.number(),
    escalatedAt: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    resolvedAt: v.optional(v.number()),
    canceledAt: v.optional(v.number()),
    closedAt: v.optional(v.number()),
  })
    .index("by_queue_category", ["queue", "category", "openBlockers", "assigneeRef", "priority"])
    .index("by_queue_state", ["queue", "state", "priority"])
    .index("by_assignee", ["assigneeRef", "category"])
    .index("by_requester", ["requesterRef", "category"])
    .index("by_requester_queue", ["requesterRef", "queue", "category"])
    .index("by_subject", ["subjectRef"])
    .index("by_parent", ["parentId"])
    .index("by_requester_key", ["requesterRef", "idempotencyKey"])
    .index("by_closed", ["closedAt"])
    .searchIndex("search_title", { searchField: "title", filterFields: ["queue", "category"] }),

  /** The live lease of a started ticket in a queue with leases. */
  leases: defineTable({
    ticketId: v.id("tickets"),
    partyRef: v.string(),
    claimSeq: v.number(),
    expiresAt: v.number(),
  }).index("by_ticket", ["ticketId"]),

  /** A ticket's thread, numbered per ticket by `seq`. */
  messages: defineTable({
    ticketId: v.id("tickets"),
    seq: v.number(),
    authorRef: v.string(),
    authorKind: partyKindValidator,
    visibility: visibilityValidator,
    kind: messageKindValidator,
    body: v.string(),
    data: v.optional(scalarRecordValidator),
    requestedFields: v.optional(v.array(v.string())),
    idempotencyKey: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_ticket_seq", ["ticketId", "seq"])
    .index("by_ticket_visibility", ["ticketId", "visibility", "seq"])
    .index("by_ticket_key", ["ticketId", "idempotencyKey"]),

  /** Links between tickets (`blocks`, `duplicates`, `relates`) and to outside things (`ref`). */
  links: defineTable({
    ticketId: v.id("tickets"),
    relation: linkRelationValidator,
    toTicketId: v.optional(v.id("tickets")),
    refKind: v.optional(v.string()),
    ref: v.optional(v.string()),
    label: v.optional(v.string()),
    createdByRef: v.string(),
    createdAt: v.number(),
  })
    .index("by_ticket", ["ticketId", "relation", "toTicketId"])
    .index("by_target", ["toTicketId", "relation"])
    .index("by_ref", ["refKind", "ref", "ticketId"]),

  /** A ticket's append-only history, numbered per ticket by `seq`. */
  transitions: defineTable({
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
  }).index("by_ticket_seq", ["ticketId", "seq"]),

  /** The mount config, one row: the host hook's function handle, the retention period and the limits. */
  config: defineTable({
    onEventHandle: v.optional(v.string()),
    retentionMs: v.optional(v.number()),
    limits: limitsValidator,
  }),
});
