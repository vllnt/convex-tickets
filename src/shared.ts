import { ConvexError, v } from "convex/values";
import type { Infer } from "convex/values";


/** The six fixed status categories. Rules read the category, never the state name. */
export const CATEGORIES = ["backlog", "unstarted", "started", "waiting", "done", "canceled"] as const;
/** A status category: one of `CATEGORIES`. */
export type Category = (typeof CATEGORIES)[number];

/** Categories a ticket can still move in. `done` and `canceled` are the end. */
export const ACTIVE_CATEGORIES = ["backlog", "unstarted", "started", "waiting"] as const;

/** The kinds of party that can act on a ticket. */
export const PARTY_KINDS = ["human", "agent", "system"] as const;
/** A party kind: one of `PARTY_KINDS`. */
export type PartyKind = (typeof PARTY_KINDS)[number];

/** How a ticket can end when it is resolved. Only `completed` clears a blocker. */
export const RESOLUTIONS = ["completed", "failed", "rejected"] as const;
/** A resolution: one of `RESOLUTIONS`. */
export type Resolution = (typeof RESOLUTIONS)[number];

/** What a waiting ticket waits on: the requester, its blockers or something external. */
export const WAITING_ON = ["requester", "blockers", "external"] as const;
/** A waiting reason: one of `WAITING_ON`. */
export type WaitingOn = (typeof WAITING_ON)[number];

/** What a waiting state may declare it is for. `external` covers blockers and outside waits. */
export const WAIT_TARGETS = ["requester", "external"] as const;
/** A wait target a state may declare: one of `WAIT_TARGETS`. */
export type WaitTarget = (typeof WAIT_TARGETS)[number];

/** Who can read a message: everyone (`public`) or only the parties doing the work (`internal`). */
export const VISIBILITIES = ["public", "internal"] as const;
/** A message visibility: one of `VISIBILITIES`. */
export type Visibility = (typeof VISIBILITIES)[number];

/** The kinds of message in a ticket thread. */
export const MESSAGE_KINDS = ["message", "input_request", "system"] as const;
/** A message kind: one of `MESSAGE_KINDS`. */
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** The ways a ticket can be linked: to another ticket, or to an outside thing (`ref`). */
export const LINK_RELATIONS = ["blocks", "duplicates", "relates", "ref"] as const;
/** A link relation: one of `LINK_RELATIONS`. */
export type LinkRelation = (typeof LINK_RELATIONS)[number];

/** The types a declared field can have. */
export const FIELD_TYPES = ["string", "number", "boolean", "enum"] as const;
/** A field type: one of `FIELD_TYPES`. */
export type FieldType = (typeof FIELD_TYPES)[number];

/** The kinds of transition written to a ticket's history and sent in a `TicketEvent`. */
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
  "guardrail_tripped",
] as const;
/** A transition type: one of `TRANSITION_TYPES`. */
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
/** The name of one of the five `DEFAULT_STATES`. */
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
/** Mount-wide limits as numbers, with the same keys as `DEFAULT_LIMITS`. */
export type Limits = { [K in keyof typeof DEFAULT_LIMITS]: number };

/**
 * Highest value of each graph limit. Every read of blocker links takes up to
 * the ceiling, so lowering a limit later never hides links that already exist;
 * the limit itself only gates new links.
 */
export const LIMIT_CEILINGS = { maxBlockers: 20, maxBlocked: 100, maxGraphWalk: 200 } as const;

/** Lowest priority number, the most urgent. */
export const PRIORITY_MIN = 0;
/** Highest priority number, the least urgent. */
export const PRIORITY_MAX = 4;
/** The priority a ticket gets when `open` is given none. */
export const DEFAULT_PRIORITY = 2;


/** Convex validator for a `Category`. */
export const categoryValidator = v.union(
  v.literal("backlog"),
  v.literal("unstarted"),
  v.literal("started"),
  v.literal("waiting"),
  v.literal("done"),
  v.literal("canceled"),
);
/** Convex validator for a `PartyKind`. */
export const partyKindValidator = v.union(
  v.literal("human"),
  v.literal("agent"),
  v.literal("system"),
);
/** Convex validator for a `Resolution`. */
export const resolutionValidator = v.union(
  v.literal("completed"),
  v.literal("failed"),
  v.literal("rejected"),
);
/** Convex validator for a `WaitingOn`. */
export const waitingOnValidator = v.union(
  v.literal("requester"),
  v.literal("blockers"),
  v.literal("external"),
);
/** Convex validator for a `WaitTarget`. */
export const waitTargetValidator = v.union(
  v.literal("requester"),
  v.literal("external"),
);
/** Convex validator for a `Visibility`. */
export const visibilityValidator = v.union(
  v.literal("public"),
  v.literal("internal"),
);
/** Convex validator for a `MessageKind`. */
export const messageKindValidator = v.union(
  v.literal("message"),
  v.literal("input_request"),
  v.literal("system"),
);
/** Convex validator for a `LinkRelation`. */
export const linkRelationValidator = v.union(
  v.literal("blocks"),
  v.literal("duplicates"),
  v.literal("relates"),
  v.literal("ref"),
);
/** Convex validator for a `FieldType`. */
export const fieldTypeValidator = v.union(
  v.literal("string"),
  v.literal("number"),
  v.literal("boolean"),
  v.literal("enum"),
);
/** Convex validator for a `TransitionType`. */
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
  v.literal("guardrail_tripped"),
);

/** A field value: string, number, boolean or null. No nested data. */
export const scalarValidator = v.union(v.string(), v.number(), v.boolean(), v.null());
/** Ticket fields and results: a flat record of scalars. Checked against the queue at runtime. */
export const scalarRecordValidator = v.record(v.string(), scalarValidator);
/** A field value: a string, a number, a boolean or null. */
export type Scalar = Infer<typeof scalarValidator>;
/** A flat record of scalars, as stored for ticket fields and results. */
export type ScalarRecord = Infer<typeof scalarRecordValidator>;

/** Anyone who acts on a ticket. `ref` is opaque; `kind` is a display hint the component never branches on. */
export const partyValidator = v.object({ ref: v.string(), kind: partyKindValidator });
/** A party: its opaque `ref` and its `kind`. */
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
/** Convex validator for the whole `ticketEvent` object, for the host's `onEvent` args. */
export const ticketEventValidator = v.object(ticketEvent);
/** The event the component schedules on the host's `onEvent` function after every transition. */
export type TicketEvent = Infer<typeof ticketEventValidator>;


/** Every code a coded tickets error can carry. */
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
/** An error code: one of `ERROR_CODES`. */
export type TicketsErrorCode = (typeof ERROR_CODES)[number];

/** The data of every coded error. `retryAt` is set on `RATE_LIMITED`: when a retry may succeed (epoch ms). */
export type TicketsErrorData = { code: TicketsErrorCode; message: string; retryAt?: number };

/**
 * Build the coded error every component function throws.
 *
 * @param code - The error code.
 * @param message - A readable message for people and logs.
 * @param extra - Extra data. `retryAt` is set on `RATE_LIMITED`.
 * @returns A `ConvexError` whose data is `{ code, message }` plus `extra`.
 * @example
 * throw ticketsError("NOT_FOUND", "ticket does not exist");
 */
export function ticketsError(
  code: TicketsErrorCode,
  message: string,
  extra: { retryAt?: number } = {},
): ConvexError<TicketsErrorData> {
  return new ConvexError({ code, message, ...extra });
}

/**
 * Check whether a caught value is a coded tickets error, optionally with one specific code.
 *
 * @param error - The caught value.
 * @param code - When given, the error must carry this code.
 * @returns True when `error` is a `ConvexError` whose data has a string `code` (equal to `code` when given).
 * @example
 * try {
 *   await tickets.reply(ctx, { ticketId, actor, body: "Thanks" });
 * } catch (error) {
 *   if (isTicketsError(error, "SEALED")) return;
 *   throw error;
 * }
 */
export function isTicketsError(
  error: unknown,
  code?: TicketsErrorCode,
): error is ConvexError<TicketsErrorData> {
  if (!(error instanceof ConvexError)) return false;
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null || !("code" in data)) return false;
  return typeof data.code === "string" && (code === undefined || data.code === code);
}
