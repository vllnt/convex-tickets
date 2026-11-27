import { ConvexError } from "convex/values";
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import {
  ACTIVE_CATEGORIES,
  CATEGORIES,
  DEFAULT_LIMITS,
  DEFAULT_POLICY,
  DEFAULT_PRIORITY,
  DEFAULT_STATES,
  ERROR_CODES,
  FIELD_TYPES,
  LINK_RELATIONS,
  MESSAGE_KINDS,
  PARTY_KINDS,
  PRIORITY_MAX,
  PRIORITY_MIN,
  RESOLUTIONS,
  SYSTEM_PARTY,
  TRANSITION_TYPES,
  VISIBILITIES,
  WAITING_ON,
  WAIT_TARGETS,
  categoryValidator,
  fieldTypeValidator,
  isTicketsError,
  linkRelationValidator,
  messageKindValidator,
  partyKindValidator,
  resolutionValidator,
  ticketsError,
  transitionTypeValidator,
  visibilityValidator,
  waitTargetValidator,
  waitingOnValidator,
} from "./shared.js";
import type { TicketsErrorCode } from "./shared.js";

afterEach(() => {
  vi.useRealTimers();
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe("the fixed vocabulary", () => {
  test("there are exactly six categories, in lifecycle order, and the first four are active", () => {
    expect(CATEGORIES).toEqual(["backlog", "unstarted", "started", "waiting", "done", "canceled"]);
    expect(ACTIVE_CATEGORIES).toEqual(["backlog", "unstarted", "started", "waiting"]);
    for (const category of ACTIVE_CATEGORIES) expect(CATEGORIES).toContain(category);
    expect(CATEGORIES.filter((category) => !ACTIVE_CATEGORIES.some((active) => active === category))).toEqual(["done", "canceled"]);
  });

  test("the default queue has five states and each category is one of the six", () => {
    expect(DEFAULT_STATES).toHaveLength(5);
    expect(DEFAULT_STATES.map((state) => [state.name, state.category])).toEqual([
      ["open", "unstarted"],
      ["working", "started"],
      ["waiting", "waiting"],
      ["resolved", "done"],
      ["canceled", "canceled"],
    ]);
    for (const state of DEFAULT_STATES) expect(CATEGORIES).toContain(state.category);
    expect(new Set(DEFAULT_STATES.map((state) => state.name)).size).toBe(DEFAULT_STATES.length);
  });

  test("the policy defaults are a five-minute lease, a seven-day reopen window and the guardrail counts", () => {
    expect(DEFAULT_POLICY).toEqual({
      leaseMs: 5 * MINUTE,
      reopenWindowMs: 7 * DAY,
      maxHops: 6,
      maxReturns: 3,
      maxMessages: 200,
      maxOpenPerRequester: 50,
    });
  });

  test("the mount limits default to the sizes and rates the design names", () => {
    expect(DEFAULT_LIMITS).toEqual({
      maxBodyChars: 20_000,
      maxStringChars: 1_000,
      maxFields: 50,
      maxBlockers: 20,
      maxBlocked: 100,
      maxGraphWalk: 200,
      opensPerMinute: 30,
      messagesPerMinute: 120,
    });
  });

  test("priority runs from 0 (urgent) to 4 and defaults to 2", () => {
    expect(PRIORITY_MIN).toBe(0);
    expect(PRIORITY_MAX).toBe(4);
    expect(DEFAULT_PRIORITY).toBe(2);
    expect(DEFAULT_PRIORITY).toBeGreaterThanOrEqual(PRIORITY_MIN);
    expect(DEFAULT_PRIORITY).toBeLessThanOrEqual(PRIORITY_MAX);
  });

  test("the system party is the one component actor, of kind system", () => {
    expect(SYSTEM_PARTY).toEqual({ ref: "system:tickets", kind: "system" });
    expect(PARTY_KINDS).toEqual(["human", "agent", "system"]);
  });

  test("there are nineteen distinct transition types", () => {
    expect(TRANSITION_TYPES).toHaveLength(19);
    expect(new Set(TRANSITION_TYPES).size).toBe(19);
    expect(TRANSITION_TYPES).toEqual([
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
    ]);
  });

  test("each small enum has the values the design names", () => {
    expect(RESOLUTIONS).toEqual(["completed", "failed", "rejected"]);
    expect(WAITING_ON).toEqual(["requester", "blockers", "external"]);
    expect(WAIT_TARGETS).toEqual(["requester", "external"]);
    expect(VISIBILITIES).toEqual(["public", "internal"]);
    expect(MESSAGE_KINDS).toEqual(["message", "input_request", "system"]);
    expect(LINK_RELATIONS).toEqual(["blocks", "duplicates", "relates", "ref"]);
    expect(FIELD_TYPES).toEqual(["string", "number", "boolean", "enum"]);
  });

  test("every validator accepts exactly the values of its constant, in the same order", () => {
    const pairs: [readonly string[], readonly string[]][] = [
      [categoryValidator.members.map((member) => member.value), CATEGORIES],
      [partyKindValidator.members.map((member) => member.value), PARTY_KINDS],
      [resolutionValidator.members.map((member) => member.value), RESOLUTIONS],
      [waitingOnValidator.members.map((member) => member.value), WAITING_ON],
      [waitTargetValidator.members.map((member) => member.value), WAIT_TARGETS],
      [visibilityValidator.members.map((member) => member.value), VISIBILITIES],
      [messageKindValidator.members.map((member) => member.value), MESSAGE_KINDS],
      [linkRelationValidator.members.map((member) => member.value), LINK_RELATIONS],
      [fieldTypeValidator.members.map((member) => member.value), FIELD_TYPES],
      [transitionTypeValidator.members.map((member) => member.value), TRANSITION_TYPES],
    ];
    for (const [fromValidator, constant] of pairs) expect(fromValidator).toEqual([...constant]);
  });
});

describe("the error codes", () => {
  test("no code is listed twice and every code is upper snake case", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) expect(code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
  });

  test("the codes the design names are all there", () => {
    const named: TicketsErrorCode[] = [
      "CLAIM_LOST",
      "GRAPH_TOO_DEEP",
      "RATE_LIMITED",
      "TOO_MANY_BLOCKERS",
      "TOO_MANY_OPEN",
      "UNKNOWN_STATE",
    ];
    for (const code of named) expect(ERROR_CODES).toContain(code);
  });
});

describe("ticketsError", () => {
  test("builds a ConvexError whose data is the code and the message", () => {
    const error = ticketsError("NOT_FOUND", "no such ticket");
    expect(error).toBeInstanceOf(ConvexError);
    expect(error.data).toEqual({ code: "NOT_FOUND", message: "no such ticket" });
  });

  test("carries retryAt when given, including zero", () => {
    const limited = ticketsError("RATE_LIMITED", "slow down", { retryAt: 1_700_000_000_000 });
    expect(limited.data).toEqual({ code: "RATE_LIMITED", message: "slow down", retryAt: 1_700_000_000_000 });
    const zero = ticketsError("RATE_LIMITED", "slow down", { retryAt: 0 });
    expect(zero.data.retryAt).toBe(0);
  });

  test("has no retryAt key at all when none is given", () => {
    expect(Object.keys(ticketsError("RATE_LIMITED", "slow down").data).sort()).toEqual(["code", "message"]);
    expect(Object.keys(ticketsError("RATE_LIMITED", "slow down", {}).data).sort()).toEqual(["code", "message"]);
  });

  test("every code round-trips through isTicketsError and matches only itself", () => {
    for (const code of ERROR_CODES) {
      const error = ticketsError(code, "m");
      expect(isTicketsError(error, code)).toBe(true);
      const other = ERROR_CODES.find((candidate) => candidate !== code);
      expect(isTicketsError(error, other)).toBe(false);
    }
  });
});

describe("isTicketsError", () => {
  test("accepts a coded error with no code to match", () => {
    expect(isTicketsError(ticketsError("CLAIM_LOST", "the lease ended"))).toBe(true);
  });

  test("accepts a coded error when the code matches", () => {
    expect(isTicketsError(ticketsError("CLAIM_LOST", "the lease ended"), "CLAIM_LOST")).toBe(true);
  });

  test("refuses a coded error when the code is a different one", () => {
    expect(isTicketsError(ticketsError("CLAIM_LOST", "the lease ended"), "NOT_HOLDER")).toBe(false);
  });

  test("narrows the error so the code and message are typed", () => {
    const error: unknown = ticketsError("RATE_LIMITED", "slow down", { retryAt: 5 });
    if (!isTicketsError(error)) throw new Error("expected a tickets error");
    expectTypeOf(error.data.code).toEqualTypeOf<TicketsErrorCode>();
    expectTypeOf(error.data.message).toEqualTypeOf<string>();
    expectTypeOf(error.data.retryAt).toEqualTypeOf<number | undefined>();
    expect(error.data.retryAt).toBe(5);
  });

  test("refuses an error that is not a ConvexError, even when it looks like one", () => {
    expect(isTicketsError(new Error("CLAIM_LOST"))).toBe(false);
    expect(isTicketsError(new TypeError("boom"))).toBe(false);
    expect(isTicketsError({ data: { code: "CLAIM_LOST", message: "m" } })).toBe(false);
    expect(isTicketsError({ code: "CLAIM_LOST" })).toBe(false);
  });

  test("refuses values that are not errors at all", () => {
    expect(isTicketsError(undefined)).toBe(false);
    expect(isTicketsError(null)).toBe(false);
    expect(isTicketsError("CLAIM_LOST")).toBe(false);
    expect(isTicketsError(404)).toBe(false);
    expect(isTicketsError(true)).toBe(false);
  });

  test("refuses a ConvexError whose data is not an object", () => {
    expect(isTicketsError(new ConvexError("CLAIM_LOST"))).toBe(false);
    expect(isTicketsError(new ConvexError(42))).toBe(false);
    expect(isTicketsError(new ConvexError(true))).toBe(false);
    expect(isTicketsError(new ConvexError(null))).toBe(false);
    expect(isTicketsError(new ConvexError("CLAIM_LOST"), "CLAIM_LOST")).toBe(false);
  });

  test("refuses a ConvexError whose data has no code", () => {
    expect(isTicketsError(new ConvexError({}))).toBe(false);
    expect(isTicketsError(new ConvexError({ message: "no code here" }))).toBe(false);
    expect(isTicketsError(new ConvexError({ message: "no code here" }), "CLAIM_LOST")).toBe(false);
  });

  test("refuses a ConvexError whose code is not a string", () => {
    expect(isTicketsError(new ConvexError({ code: 42 }))).toBe(false);
    expect(isTicketsError(new ConvexError({ code: null }))).toBe(false);
    expect(isTicketsError(new ConvexError({ code: true }))).toBe(false);
    expect(isTicketsError(new ConvexError({ code: ["CLAIM_LOST"] }), "CLAIM_LOST")).toBe(false);
    expect(isTicketsError(new ConvexError({ code: { name: "CLAIM_LOST" } }), "CLAIM_LOST")).toBe(false);
  });

  test("refuses a ConvexError whose data is an array", () => {
    expect(isTicketsError(new ConvexError(["CLAIM_LOST"]))).toBe(false);
  });
});
