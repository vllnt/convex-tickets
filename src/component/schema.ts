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

export default defineSchema({
  queues: defineTable({
    name: v.string(),
    states: v.array(stateDefValidator),
    fields: v.array(fieldDefValidator),
    resultFields: v.array(fieldDefValidator),
    schemaVersion: v.number(),
    policy: policyValidator,
    updatedAt: v.number(),
  }).index("by_name", ["name"]),

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

  leases: defineTable({
    ticketId: v.id("tickets"),
    partyRef: v.string(),
    claimSeq: v.number(),
    expiresAt: v.number(),
  }).index("by_ticket", ["ticketId"]),

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

  config: defineTable({
    onEventHandle: v.optional(v.string()),
    retentionMs: v.optional(v.number()),
    limits: limitsValidator,
  }),
});
