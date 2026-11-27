import { ConvexError, v } from "convex/values";
import type { Infer } from "convex/values";


/** The six fixed status categories. Rules read the category, never the state name. */
export const CATEGORIES = ["backlog", "unstarted", "started", "waiting", "done", "canceled"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Categories a ticket can still move in. `done` and `canceled` are the end. */
export const ACTIVE_CATEGORIES = ["backlog", "unstarted", "started", "waiting"] as const;

export const PARTY_KINDS = ["human", "agent", "system"] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

export const RESOLUTIONS = ["completed", "failed", "rejected"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const WAITING_ON = ["requester", "blockers", "external"] as const;
export type WaitingOn = (typeof WAITING_ON)[number];

/** What a waiting state may declare it is for. `external` covers blockers and outside waits. */
export const WAIT_TARGETS = ["requester", "external"] as const;
export type WaitTarget = (typeof WAIT_TARGETS)[number];

export const VISIBILITIES = ["public", "internal"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const MESSAGE_KINDS = ["message", "input_request", "system"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const LINK_RELATIONS = ["blocks", "duplicates", "relates", "ref"] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

export const FIELD_TYPES = ["string", "number", "boolean", "enum"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const TRANSITION_TYPES = [
  "opened",
  "moved",
  "assigned",
  "claimed",
  "released",
  "lease_expired",
  "handed_off",
  "input_requested",
  "input_provided",
  "held",
  "resumed",
  "unblocked",
  "blocker_failed",
  "resolved",
  "reopened",
  "closed",
  "canceled",
  "escalated",
  "due_breached",
] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];

/** The party the component acts as for timers and automatic cascades. */
export const SYSTEM_PARTY = { ref: "system:tickets", kind: "system" } as const;


const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The five states a queue gets when it declares none. */
export const DEFAULT_STATES = [
  { name: "open", category: "unstarted" },
  { name: "working", category: "started" },
  { name: "waiting", category: "waiting" },
  { name: "resolved", category: "done" },
  { name: "canceled", category: "canceled" },
] as const;
export type DefaultStateName = (typeof DEFAULT_STATES)[number]["name"];

/** Queue policy defaults. All are starting guesses (see the design notes in the README). */
export const DEFAULT_POLICY = {
  leaseMs: 5 * MINUTE,
  reopenWindowMs: 7 * DAY,
  maxHops: 6,
  maxReturns: 3,
  maxMessages: 200,
  maxOpenPerRequester: 50,
} as const;

/** Mount-wide limits. Every one is configurable through `sync`. */
export const DEFAULT_LIMITS = {
  maxBodyChars: 20_000,
  maxStringChars: 1_000,
  maxFields: 50,
  maxBlockers: 20,
  maxBlocked: 100,
  maxGraphWalk: 200,
  opensPerMinute: 30,
  messagesPerMinute: 120,
} as const;
export type Limits = { [K in keyof typeof DEFAULT_LIMITS]: number };

/** Highest and lowest priority. 0 is urgent. */
export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 4;
export const DEFAULT_PRIORITY = 2;


export const categoryValidator = v.union(
  v.literal("backlog"),
  v.literal("unstarted"),
  v.literal("started"),
  v.literal("waiting"),
  v.literal("done"),
  v.literal("canceled"),
);
export const partyKindValidator = v.union(
  v.literal("human"),
  v.literal("agent"),
  v.literal("system"),
);
export const resolutionValidator = v.union(
  v.literal("completed"),
  v.literal("failed"),
  v.literal("rejected"),
);
export const waitingOnValidator = v.union(
  v.literal("requester"),
  v.literal("blockers"),
  v.literal("external"),
);
export const waitTargetValidator = v.union(
  v.literal("requester"),
  v.literal("external"),
);
export const visibilityValidator = v.union(
  v.literal("public"),
  v.literal("internal"),
);
export const messageKindValidator = v.union(
  v.literal("message"),
  v.literal("input_request"),
  v.literal("system"),
);
export const linkRelationValidator = v.union(
  v.literal("blocks"),
  v.literal("duplicates"),
  v.literal("relates"),
  v.literal("ref"),
);
export const fieldTypeValidator = v.union(
  v.literal("string"),
  v.literal("number"),
  v.literal("boolean"),
  v.literal("enum"),
);
export const transitionTypeValidator = v.union(
  v.literal("opened"),
  v.literal("moved"),
  v.literal("assigned"),
  v.literal("claimed"),
  v.literal("released"),
  v.literal("lease_expired"),
  v.literal("handed_off"),
  v.literal("input_requested"),
  v.literal("input_provided"),
  v.literal("held"),
  v.literal("resumed"),
  v.literal("unblocked"),
  v.literal("blocker_failed"),
  v.literal("resolved"),
  v.literal("reopened"),
  v.literal("closed"),
  v.literal("canceled"),
  v.literal("escalated"),
  v.literal("due_breached"),
);

/** A field value: string, number, boolean or null. No nested data. */
export const scalarValidator = v.union(v.string(), v.number(), v.boolean(), v.null());
/** Ticket fields and results: a flat record of scalars. Checked against the queue at runtime. */
export const scalarRecordValidator = v.record(v.string(), scalarValidator);
export type Scalar = Infer<typeof scalarValidator>;
export type ScalarRecord = Infer<typeof scalarRecordValidator>;

/** Anyone who acts on a ticket. `ref` is opaque; `kind` is a display hint the component never branches on. */
export const partyValidator = v.object({ ref: v.string(), kind: partyKindValidator });
export type Party = Infer<typeof partyValidator>;

/**
 * The event the component schedules on the host's `onEvent` function after every
 * transition. Carries no message bodies and no fields: call `get` for those.
 */
export const ticketEvent = {
  ticketId: v.string(),
  seq: v.number(),
  type: transitionTypeValidator,
  queue: v.string(),
  state: v.string(),
  category: categoryValidator,
  fromQueue: v.optional(v.string()),
  fromState: v.optional(v.string()),
  fromCategory: v.optional(categoryValidator),
  waitingOn: v.optional(waitingOnValidator),
  blocked: v.boolean(),
  openBlockers: v.number(),
  priority: v.number(),
  requesterRef: v.string(),
  assigneeRef: v.optional(v.string()),
  claimSeq: v.number(),
  actor: partyValidator,
  reason: v.optional(v.string()),
  at: v.number(),
};
export const ticketEventValidator = v.object(ticketEvent);
export type TicketEvent = Infer<typeof ticketEventValidator>;


export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "INVALID_QUEUE",
  "STATE_CATEGORY_CHANGED",
  "STATE_IN_USE",
  "FIELD_CHANGED",
  "UNKNOWN_QUEUE",
  "UNKNOWN_STATE",
  "INVALID_TARGET",
  "NO_LANDING_STATE",
  "UNKNOWN_FIELD",
  "INVALID_FIELD",
  "MISSING_FIELD",
  "TOO_MANY_FIELDS",
  "TOO_LONG",
  "FIELDS_NOT_ACCEPTED",
  "NOT_FOUND",
  "WRONG_QUEUE",
  "INVALID_MOVE",
  "SEALED",
  "CLAIM_LOST",
  "NOT_HOLDER",
  "NOT_REQUESTER",
  "HOLDER_REQUIRED",
  "NOT_BLOCKED",
  "NO_ESCALATION",
  "CYCLE",
  "GRAPH_TOO_DEEP",
  "TOO_MANY_BLOCKERS",
  "TOO_MANY_BLOCKED",
  "TOO_MANY_OPEN",
  "RATE_LIMITED",
  "MESSAGE_LIMIT",
] as const;
export type TicketsErrorCode = (typeof ERROR_CODES)[number];

/** The data of every coded error. `retryAt` is set on `RATE_LIMITED`: when a retry may succeed (epoch ms). */
export type TicketsErrorData = { code: TicketsErrorCode; message: string; retryAt?: number };

/** Build the coded error every component function throws. */
export function ticketsError(
  code: TicketsErrorCode,
  message: string,
  extra: { retryAt?: number } = {},
): ConvexError<TicketsErrorData> {
  return new ConvexError({ code, message, ...extra });
}

/** True when `error` is a coded tickets error, optionally with one specific code. */
export function isTicketsError(
  error: unknown,
  code?: TicketsErrorCode,
): error is ConvexError<TicketsErrorData> {
  if (!(error instanceof ConvexError)) return false;
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null || !("code" in data)) return false;
  return typeof data.code === "string" && (code === undefined || data.code === code);
}
