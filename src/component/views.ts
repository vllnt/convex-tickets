import type { Infer } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import type { linkView, messageView, ticketView, transitionView } from "./validators.js";

/**
 * Map a ticket row to its public view. Drops the idempotency key and internal counters.
 *
 * @param t - The ticket row.
 * @returns The view returned by every query.
 */
export function toTicketView(t: Doc<"tickets">): Infer<typeof ticketView> {
  return {
    ticketId: t._id,
    queue: t.queue,
    state: t.state,
    category: t.category,
    waitingOn: t.waitingOn,
    openBlockers: t.openBlockers,
    priority: t.priority,
    title: t.title,
    requesterRef: t.requesterRef,
    requesterKind: t.requesterKind,
    assigneeRef: t.assigneeRef,
    assigneeKind: t.assigneeKind,
    claimSeq: t.claimSeq,
    subjectRef: t.subjectRef,
    fields: t.fields,
    schemaVersion: t.schemaVersion,
    resolution: t.resolution,
    result: t.result,
    parentId: t.parentId,
    dueAt: t.dueAt,
    dueBreachedAt: t.dueBreachedAt,
    hopCount: t.hopCount,
    messageCount: t.messageCount,
    leaseExpiryCount: t.leaseExpiryCount,
    escalatedAt: t.escalatedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    resolvedAt: t.resolvedAt,
    canceledAt: t.canceledAt,
    closedAt: t.closedAt,
  };
}

/**
 * Map a message row to its view. Drops the idempotency key.
 *
 * @param m - The message row.
 * @returns The view returned by the message queries.
 */
export function toMessageView(m: Doc<"messages">): Infer<typeof messageView> {
  return {
    messageId: m._id,
    ticketId: m.ticketId,
    seq: m.seq,
    authorRef: m.authorRef,
    authorKind: m.authorKind,
    visibility: m.visibility,
    kind: m.kind,
    body: m.body,
    data: m.data,
    requestedFields: m.requestedFields,
    createdAt: m.createdAt,
  };
}

/**
 * Map a link row to its view.
 *
 * @param l - The link row.
 * @returns The view returned by the link queries.
 */
export function toLinkView(l: Doc<"links">): Infer<typeof linkView> {
  return {
    linkId: l._id,
    ticketId: l.ticketId,
    relation: l.relation,
    toTicketId: l.toTicketId,
    refKind: l.refKind,
    ref: l.ref,
    label: l.label,
    createdByRef: l.createdByRef,
    createdAt: l.createdAt,
  };
}

/**
 * Map a transition row to its view.
 *
 * @param t - The transition row.
 * @returns The view returned by the history query.
 */
export function toTransitionView(t: Doc<"transitions">): Infer<typeof transitionView> {
  return {
    ticketId: t.ticketId,
    seq: t.seq,
    type: t.type,
    fromState: t.fromState,
    toState: t.toState,
    fromCategory: t.fromCategory,
    toCategory: t.toCategory,
    actorRef: t.actorRef,
    actorKind: t.actorKind,
    fromQueue: t.fromQueue,
    toQueue: t.toQueue,
    fromAssigneeRef: t.fromAssigneeRef,
    toAssigneeRef: t.toAssigneeRef,
    reason: t.reason,
    at: t.at,
  };
}
