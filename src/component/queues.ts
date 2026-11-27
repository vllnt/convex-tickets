import { DEFAULT_LIMITS, ticketsError } from "../shared.js";
import type { Category, Limits, ScalarRecord, WaitingOn } from "../shared.js";
import type { Doc } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";
import type { FieldDef, QueueDef, StateDef } from "./validators.js";

/** Categories every queue must cover. `backlog` and `waiting` are optional. */
const REQUIRED_CATEGORIES: readonly Category[] = ["unstarted", "started", "done", "canceled"];

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:.\- ]*$/;

/**
 * Load a queue row by name.
 *
 * @param ctx - Any query or mutation context.
 * @param name - The queue name.
 * @returns The queue row. Throws `UNKNOWN_QUEUE` when `sync` never wrote it.
 */
export async function loadQueue(ctx: QueryCtx, name: string): Promise<Doc<"queues">> {
  const queue = await ctx.db
    .query("queues")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  if (!queue) throw ticketsError("UNKNOWN_QUEUE", `queue "${name}" is not defined; run sync`);
  return queue;
}

/**
 * Load the mount config, with default limits when `sync` has not run.
 *
 * @param ctx - Any query or mutation context.
 * @returns The config row fields the engine reads.
 */
export async function loadConfig(
  ctx: QueryCtx,
): Promise<{ limits: Limits; onEventHandle?: string; retentionMs?: number }> {
  const row = await ctx.db.query("config").first();
  if (!row) return { limits: { ...DEFAULT_LIMITS } };
  return { limits: row.limits, onEventHandle: row.onEventHandle, retentionMs: row.retentionMs };
}

function waitMatches(state: StateDef, waitingOn: WaitingOn | undefined): boolean {
  if (state.on === undefined || waitingOn === undefined) return true;
  return waitingOn === "requester" ? state.on === "requester" : state.on === "external";
}

/**
 * Pick where a verb lands: `to` when given, else the first state of the category.
 * A waiting landing also has to fit what the ticket waits on.
 *
 * @param queue - The queue the ticket lands in.
 * @param category - The category the verb moves the ticket into.
 * @param to - An explicit target state name, if the caller chose one.
 * @param waitingOn - For waiting landings, what ends the wait.
 * @returns The state name to store.
 */
export function landingState(
  queue: Doc<"queues">,
  category: Category,
  to?: string,
  waitingOn?: WaitingOn,
): string {
  if (to !== undefined) {
    const state = queue.states.find((s) => s.name === to);
    if (!state) throw ticketsError("UNKNOWN_STATE", `queue "${queue.name}" has no state "${to}"`);
    if (state.category !== category || !waitMatches(state, waitingOn)) {
      throw ticketsError(
        "INVALID_TARGET",
        `state "${to}" is ${state.category}; this move needs a ${category} state`,
      );
    }
    return state.name;
  }
  const inCategory = queue.states.filter((s) => s.category === category);
  const landing =
    inCategory.find((s) => s.on !== undefined && waitMatches(s, waitingOn)) ??
    inCategory.find((s) => s.on === undefined);
  const chosen = category === "waiting" ? landing : inCategory[0];
  if (!chosen) {
    throw ticketsError("NO_LANDING_STATE", `queue "${queue.name}" has no ${category} state for this move`);
  }
  return chosen.name;
}

/**
 * The category of a state, or `UNKNOWN_STATE`.
 *
 * @param queue - The queue to look in.
 * @param name - The state name.
 * @returns The state definition.
 */
export function stateOf(queue: Doc<"queues">, name: string): StateDef {
  const state = queue.states.find((s) => s.name === name);
  if (!state) throw ticketsError("UNKNOWN_STATE", `queue "${queue.name}" has no state "${name}"`);
  return state;
}

/**
 * Throw `TOO_LONG` when a string is over its cap.
 *
 * @param label - What the string is, for the message.
 * @param value - The string.
 * @param max - The cap in characters.
 */
export function assertLength(label: string, value: string, max: number): void {
  if (value.length > max) throw ticketsError("TOO_LONG", `${label} is over ${max} characters`);
}

/**
 * Check field values against a queue's definitions.
 *
 * @param defs - The declared fields (or result fields).
 * @param values - The supplied values.
 * @param options - `requireAll` enforces required keys; `label` names the record in errors.
 */
export function checkFields(
  defs: readonly FieldDef[],
  values: ScalarRecord,
  limits: Limits,
  options: { requireAll: boolean; label: string },
): void {
  const keys = Object.keys(values);
  if (keys.length > limits.maxFields) {
    throw ticketsError("TOO_MANY_FIELDS", `${options.label} has more than ${limits.maxFields} keys`);
  }
  for (const key of keys) {
    const def = defs.find((d) => d.key === key);
    if (!def) throw ticketsError("UNKNOWN_FIELD", `${options.label}.${key} is not declared by the queue`);
    const value = values[key];
    if (value === null) {
      if (def.required) throw ticketsError("MISSING_FIELD", `${options.label}.${key} is required`);
      continue;
    }
    const ok =
      def.type === "enum"
        ? typeof value === "string" && (def.options ?? []).includes(value)
        : typeof value === def.type;
    if (!ok) {
      const expected = def.type === "enum" ? `one of ${(def.options ?? []).join(", ")}` : def.type;
      throw ticketsError("INVALID_FIELD", `${options.label}.${key} must be ${expected}`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw ticketsError("INVALID_FIELD", `${options.label}.${key} must be a finite number`);
    }
    if (typeof value === "string") assertLength(`${options.label}.${key}`, value, limits.maxStringChars);
  }
  if (options.requireAll) {
    for (const def of defs) {
      if (def.required && (values[def.key] === undefined || values[def.key] === null)) {
        throw ticketsError("MISSING_FIELD", `${options.label}.${def.key} is required`);
      }
    }
  }
}

/** Drop null values: null clears a field, it is never stored. */
export function withoutNulls(values: ScalarRecord): ScalarRecord {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null));
}

function checkFieldDefs(queue: string, label: string, defs: readonly FieldDef[]): void {
  const seen = new Set<string>();
  for (const def of defs) {
    if (!def.key || seen.has(def.key)) {
      throw ticketsError("INVALID_QUEUE", `queue "${queue}": ${label} key "${def.key}" is empty or repeated`);
    }
    seen.add(def.key);
    const hasOptions = def.options !== undefined && def.options.length > 0;
    if ((def.type === "enum") !== hasOptions) {
      throw ticketsError("INVALID_QUEUE", `queue "${queue}": ${label} "${def.key}" options only fit an enum, and an enum needs them`);
    }
  }
}

function isNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Validate a queue definition before `sync` writes it.
 *
 * @param def - The definition the client sent.
 * @param knownQueues - Every queue name that exists after this sync.
 */
export function validateQueueDef(def: QueueDef, knownQueues: ReadonlySet<string>): void {
  if (!NAME_PATTERN.test(def.name)) {
    throw ticketsError("INVALID_QUEUE", `queue name "${def.name}" is empty or has unsupported characters`);
  }
  const names = new Set<string>();
  for (const state of def.states) {
    if (!state.name || names.has(state.name)) {
      throw ticketsError("INVALID_QUEUE", `queue "${def.name}": state "${state.name}" is empty or repeated`);
    }
    names.add(state.name);
    if (state.on !== undefined && state.category !== "waiting") {
      throw ticketsError("INVALID_QUEUE", `queue "${def.name}": only waiting states take "on"`);
    }
  }
  for (const category of REQUIRED_CATEGORIES) {
    if (!def.states.some((s) => s.category === category)) {
      throw ticketsError("INVALID_QUEUE", `queue "${def.name}" needs at least one ${category} state`);
    }
  }
  checkFieldDefs(def.name, "field", def.fields);
  checkFieldDefs(def.name, "result", def.resultFields);
  const { policy } = def;
  const counts = [policy.maxHops, policy.maxReturns, policy.maxMessages, policy.maxOpenPerRequester];
  const durations = [policy.leaseMs, policy.reopenWindowMs, policy.dueInMs].filter(
    (value): value is number => typeof value === "number",
  );
  if (!counts.every((n) => Number.isInteger(n) && n >= 0) || !durations.every(isNonNegative)) {
    throw ticketsError("INVALID_QUEUE", `queue "${def.name}": policy numbers must be finite and not negative`);
  }
  if (policy.leaseMs === 0) {
    throw ticketsError("INVALID_QUEUE", `queue "${def.name}": leaseMs must be positive, or null for no lease`);
  }
  if (policy.escalateTo !== undefined && (policy.escalateTo === def.name || !knownQueues.has(policy.escalateTo))) {
    throw ticketsError("INVALID_QUEUE", `queue "${def.name}": escalateTo "${policy.escalateTo}" must be another defined queue`);
  }
}

/**
 * Refuse a definition change that is not additive.
 *
 * @param current - The stored queue row.
 * @param next - The definition being synced.
 * @returns The states removed by `next`, which the caller checks are empty.
 */
export function checkAdditive(current: Doc<"queues">, next: QueueDef): string[] {
  for (const state of next.states) {
    const before = current.states.find((s) => s.name === state.name);
    if (before && before.category !== state.category) {
      throw ticketsError(
        "STATE_CATEGORY_CHANGED",
        `queue "${next.name}": state "${state.name}" was ${before.category}, cannot become ${state.category}`,
      );
    }
  }
  const pairs: [string, readonly FieldDef[], readonly FieldDef[]][] = [
    ["field", current.fields, next.fields],
    ["result", current.resultFields, next.resultFields],
  ];
  for (const [label, before, after] of pairs) {
    for (const old of before) {
      const now = after.find((d) => d.key === old.key);
      const lostOption = (old.options ?? []).some((o) => !(now?.options ?? []).includes(o));
      if (!now || now.type !== old.type || lostOption) {
        throw ticketsError(
          "FIELD_CHANGED",
          `queue "${next.name}": ${label} "${old.key}" can only gain enum options; it cannot be removed or change type`,
        );
      }
    }
  }
  return current.states.filter((s) => !next.states.some((n) => n.name === s.name)).map((s) => s.name);
}

/**
 * Merge input limits over the defaults and check they are positive integers.
 *
 * @param input - Partial limits from the client.
 * @returns A full limits object.
 */
export function resolveLimits(input: Partial<Limits> | undefined): Limits {
  const limits: Limits = { ...DEFAULT_LIMITS, ...input };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw ticketsError("INVALID_ARGUMENT", `limits.${key} must be a positive integer`);
    }
  }
  return limits;
}
