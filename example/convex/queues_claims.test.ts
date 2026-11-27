/// <reference types="vite/client" />
import type { FunctionArgs } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  Tickets,
  defineQueue,
  isTicketsError,
  toQueueDef,
} from "../../src/client/index.js";
import type {
  FieldsSpec,
  Limits,
  ListFilter,
  Party,
  QueueMap,
  StatesSpec,
  TicketsErrorCode,
  TicketsErrorData,
} from "../../src/client/index.js";
import { deskQueue } from "../../src/client/presets.js";
import { components, internal } from "./_generated/api.js";
import {
  A,
  B,
  C,
  DAY,
  LEAD,
  MINUTE,
  REQ,
  drain,
  events,
  expectCode,
  lab,
  setup,
  syncLab,
} from "./harness.helper.js";
import type { T } from "./harness.helper.js";

afterEach(() => {
  vi.useRealTimers();
});

const mutations = components.tickets.mutations;
const queries = components.tickets.queries;
type SyncQueue = FunctionArgs<typeof mutations.sync>["queues"][number];
type OpenArgs = FunctionArgs<typeof mutations.open>;
type ProjState =
  "backlog" | "todo" | "in_progress" | "in_review" | "done" | "canceled";

const SYSTEM_REF = "system:tickets";

function mount<Q extends QueueMap>(queues: Q, limits?: Partial<Limits>) {
  return new Tickets(components.tickets, {
    queues,
    onEvent: internal.hooks.recordOnly,
    limits,
  });
}

async function ready(): Promise<T> {
  const t = setup();
  await syncLab(t);
  return t;
}

async function readyWith<Q extends QueueMap>(client: Tickets<Q>): Promise<T> {
  const t = setup();
  await t.run((ctx) => client.sync(ctx));
  return t;
}

async function ticketOf(t: T, ticketId: string) {
  const detail = await t.run((ctx) => lab.get(ctx, { ticketId }));
  if (!detail) throw new Error(`ticket ${ticketId} is missing`);
  return detail.ticket;
}

async function claimOk(t: T, ticketId: string, actor: Party) {
  const result = await t.run((ctx) => lab.claim(ctx, { ticketId, actor }));
  if (!result.ok)
    throw new Error(`claim of ${ticketId} lost with ${result.reason}`);
  return result;
}

async function transitionsOf(t: T, ticketId: string) {
  const result = await t.run((ctx) =>
    lab.listTransitions(ctx, {
      ticketId,
      paginationOpts: { cursor: null, numItems: 100 },
    }),
  );
  return result.page;
}

async function ticketsErrorOf(
  promise: Promise<unknown>,
): Promise<TicketsErrorData> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isTicketsError(error))
    throw new Error(`expected a tickets error, got ${String(error)}`);
  return error.data;
}

/** Move the fake clock forward without firing any timer, as if a timer were late. */
function jump(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

/** convex-test pins a function's clock up to a few ms past the fake clock, so compare with a small window. */
function expectNear(actual: number | undefined, expected: number): void {
  expect(actual).toBeGreaterThanOrEqual(expected);
  expect(actual).toBeLessThan(expected + 100);
}

/** An id with the format convex-test gives ticket ids (digits, then the table name) and no document behind it. */
function missingTicketId(real: string): string {
  return real.replace(/^[0-9]+/, (digits) => "9".repeat(digits.length));
}

const openPeople = (
  t: T,
  title = "job",
  actor: Party = REQ,
  priority?: number,
): Promise<string> =>
  t.run((ctx) => lab.open(ctx, { queue: "people", actor, title, priority }));

const openAgent = (t: T, amount = 1, actor: Party = REQ): Promise<string> =>
  t.run((ctx) =>
    lab.open(ctx, { queue: "agent", actor, title: "job", fields: { amount } }),
  );

type ProjOptions = {
  to?: ProjState;
  actor?: Party;
  subjectRef?: string;
  parentId?: string;
  priority?: number;
};
const openProj = (
  t: T,
  title: string,
  options: ProjOptions = {},
): Promise<string> =>
  t.run((ctx) =>
    lab.open(ctx, {
      queue: "proj",
      actor: options.actor ?? REQ,
      title,
      to: options.to,
      subjectRef: options.subjectRef,
      parentId: options.parentId,
      priority: options.priority,
    }),
  );

const openRaw = (t: T, args: Partial<OpenArgs> = {}): Promise<string> =>
  t.run((ctx) =>
    ctx.runMutation(mutations.open, {
      queue: "agent",
      actor: REQ,
      title: "job",
      fields: { amount: 1 },
      ...args,
    }),
  );

const rawSync = (
  t: T,
  queues: SyncQueue[],
  extra: Partial<Omit<FunctionArgs<typeof mutations.sync>, "queues">> = {},
) => t.run((ctx) => ctx.runMutation(mutations.sync, { queues, ...extra }));

const storedQueue = (t: T, name: string) =>
  t.run((ctx) => ctx.runQuery(queries.getQueue, { name }));

type HolderArgs = { ticketId: string; actor: Party; claimSeq: number };
type HolderWrite = {
  verb: string;
  write: (t: T, args: HolderArgs) => Promise<unknown>;
};

const FENCED_WRITES: HolderWrite[] = [
  { verb: "renew", write: (t, a) => t.run((ctx) => lab.renew(ctx, a)) },
  { verb: "release", write: (t, a) => t.run((ctx) => lab.release(ctx, a)) },
  {
    verb: "requestInput",
    write: (t, a) =>
      t.run((ctx) => lab.requestInput(ctx, { ...a, body: "need more" })),
  },
  { verb: "hold", write: (t, a) => t.run((ctx) => lab.hold(ctx, a)) },
  {
    verb: "handoff",
    write: (t, a) =>
      t.run((ctx) => lab.handoff(ctx, { ...a, toQueue: "people" })),
  },
  {
    verb: "resolve",
    write: (t, a) =>
      t.run((ctx) => lab.resolve(ctx, { ...a, resolution: "failed" })),
  },
  {
    verb: "escalate",
    write: (t, a) =>
      t.run((ctx) => lab.escalate(ctx, { ...a, reason: "stuck" })),
  },
];
const HOLDER_WRITES: HolderWrite[] = [
  ...FENCED_WRITES,
  {
    verb: "move",
    write: (t, a) => t.run((ctx) => lab.move(ctx, { ...a, to: "working" })),
  },
];

describe("sync", () => {
  test("getQueue is null for every queue before sync", async () => {
    const t = setup();
    expect(
      await t.run((ctx) => lab.getQueue(ctx, { name: "agent" })),
    ).toBeNull();
    expect(
      await t.run((ctx) => lab.getQueue(ctx, { name: "proj" })),
    ).toBeNull();
  });

  test("getQueue is null for a name that was never synced", async () => {
    const t = await ready();
    expect(await storedQueue(t, "never-synced")).toBeNull();
  });

  test("a queue with no states gets the default five", async () => {
    const t = await ready();
    const queue = await t.run((ctx) => lab.getQueue(ctx, { name: "people" }));
    expect(queue?.states).toEqual([
      { name: "open", category: "unstarted" },
      { name: "working", category: "started" },
      { name: "waiting", category: "waiting" },
      { name: "resolved", category: "done" },
      { name: "canceled", category: "canceled" },
    ]);
  });

  test("a queue with its own states keeps their order, categories and wait targets", async () => {
    const t = await ready();
    const desk = await t.run((ctx) => lab.getQueue(ctx, { name: "humans" }));
    expect(desk?.states).toEqual([
      { name: "new", category: "unstarted" },
      { name: "open", category: "started" },
      { name: "pending", category: "waiting", on: "requester" },
      { name: "on_hold", category: "waiting", on: "external" },
      { name: "solved", category: "done" },
      { name: "canceled", category: "canceled" },
    ]);
    const proj = await t.run((ctx) => lab.getQueue(ctx, { name: "proj" }));
    expect(proj?.states.map((s) => `${s.name}:${s.category}`)).toEqual([
      "backlog:backlog",
      "todo:unstarted",
      "in_progress:started",
      "in_review:started",
      "done:done",
      "canceled:canceled",
    ]);
  });

  test("a queue with no policy gets a 5 minute lease, a 7 day reopen window and the default caps", async () => {
    const t = setup();
    const client = mount({ plain: defineQueue({}) });
    await t.run((ctx) => client.sync(ctx));
    const queue = await storedQueue(t, "plain");
    expect(queue?.policy).toEqual({
      leaseMs: 5 * MINUTE,
      reopenWindowMs: 7 * DAY,
      maxHops: 6,
      maxReturns: 3,
      maxMessages: 200,
      maxOpenPerRequester: 50,
    });
    expect(queue?.schemaVersion).toBe(1);
  });

  test("sync reports created, then unchanged, and bumps schemaVersion only on a real change", async () => {
    const t = setup();
    const v1 = mount({
      jobs: defineQueue({ fields: { n: { type: "number" } } }),
    });
    expect(await t.run((ctx) => v1.sync(ctx))).toEqual({
      created: ["jobs"],
      updated: [],
      unchanged: [],
    });
    const created = await storedQueue(t, "jobs");
    expect(created?.schemaVersion).toBe(1);

    vi.advanceTimersByTime(1000);
    expect(await t.run((ctx) => v1.sync(ctx))).toEqual({
      created: [],
      updated: [],
      unchanged: ["jobs"],
    });
    const same = await storedQueue(t, "jobs");
    expect(same?.schemaVersion).toBe(1);
    expect(same?.updatedAt).toBe(created?.updatedAt);

    const v2 = mount({
      jobs: defineQueue({
        fields: { n: { type: "number" } },
        policy: { maxHops: 9 },
      }),
    });
    expect(await t.run((ctx) => v2.sync(ctx))).toEqual({
      created: [],
      updated: ["jobs"],
      unchanged: [],
    });
    const changed = await storedQueue(t, "jobs");
    expect(changed?.schemaVersion).toBe(2);
    expect(changed?.policy.maxHops).toBe(9);
    expect(changed?.updatedAt).toBeGreaterThan(created?.updatedAt ?? 0);

    expect(await t.run((ctx) => v2.sync(ctx))).toEqual({
      created: [],
      updated: [],
      unchanged: ["jobs"],
    });
    expect((await storedQueue(t, "jobs"))?.schemaVersion).toBe(2);
  });

  test("sync sorts a mixed batch into created, updated and unchanged", async () => {
    const t = setup();
    const first = mount({ one: defineQueue({}), two: defineQueue({}) });
    await t.run((ctx) => first.sync(ctx));
    const second = mount({
      one: defineQueue({}),
      two: defineQueue({ policy: { maxMessages: 10 } }),
      three: defineQueue({}),
    });
    expect(await t.run((ctx) => second.sync(ctx))).toEqual({
      created: ["three"],
      updated: ["two"],
      unchanged: ["one"],
    });
  });

  const BASE_STATES: StatesSpec = {
    new: { category: "unstarted" },
    later: { category: "unstarted" },
    triage: { category: "backlog" },
    doing: { category: "started" },
    review: { category: "started" },
    done: { category: "done" },
    shipped: { category: "done" },
    gone: { category: "canceled" },
  };
  const queueWith = (states: StatesSpec) =>
    mount({ q: defineQueue({ states }) });
  const without = (name: string): StatesSpec =>
    Object.fromEntries(
      Object.entries(BASE_STATES).filter(([state]) => state !== name),
    );

  const categoryChanges: { name: string; states: StatesSpec }[] = [
    {
      name: "started to waiting",
      states: { ...BASE_STATES, review: { category: "waiting" } },
    },
    {
      name: "backlog to unstarted",
      states: { ...BASE_STATES, triage: { category: "unstarted" } },
    },
    {
      name: "done to canceled",
      states: { ...BASE_STATES, shipped: { category: "canceled" } },
    },
  ];

  test.each(categoryChanges)(
    "sync refuses to change the category of a state ($name) with STATE_CATEGORY_CHANGED",
    async ({ states }) => {
      const base = queueWith(BASE_STATES);
      const t = await readyWith(base);
      await expectCode(
        t.run((ctx) => queueWith(states).sync(ctx)),
        "STATE_CATEGORY_CHANGED",
      );
      const stored = await storedQueue(t, "q");
      expect(stored?.states).toEqual(
        Object.entries(BASE_STATES).map(([name, spec]) => ({
          name,
          category: spec.category,
        })),
      );
      expect(stored?.schemaVersion).toBe(1);
    },
  );

  test("sync refuses to drop a state that a ticket is in with STATE_IN_USE", async () => {
    const base = queueWith(BASE_STATES);
    const t = await readyWith(base);
    await t.run((ctx) =>
      base.open(ctx, { queue: "q", actor: REQ, title: "stuck in new" }),
    );
    await expectCode(
      t.run((ctx) => queueWith(without("new")).sync(ctx)),
      "STATE_IN_USE",
    );
    const stored = await storedQueue(t, "q");
    expect(stored?.states.map((s) => s.name)).toContain("new");
    expect(stored?.schemaVersion).toBe(1);
  });

  test("sync allows dropping a state that no ticket is in", async () => {
    const base = queueWith(BASE_STATES);
    const t = await readyWith(base);
    await t.run((ctx) =>
      base.open(ctx, { queue: "q", actor: REQ, title: "in new" }),
    );
    const result = await t.run((ctx) => queueWith(without("later")).sync(ctx));
    expect(result.updated).toEqual(["q"]);
    const stored = await storedQueue(t, "q");
    expect(stored?.states.map((s) => s.name)).not.toContain("later");
    expect(stored?.schemaVersion).toBe(2);
  });

  test("sync allows dropping a state once its last ticket moved out", async () => {
    const base = queueWith(BASE_STATES);
    const t = await readyWith(base);
    const ticketId = await t.run((ctx) =>
      base.open(ctx, { queue: "q", actor: REQ, title: "moves on" }),
    );
    await expectCode(
      t.run((ctx) => queueWith(without("new")).sync(ctx)),
      "STATE_IN_USE",
    );
    await t.run((ctx) => base.move(ctx, { ticketId, actor: REQ, to: "later" }));
    const result = await t.run((ctx) => queueWith(without("new")).sync(ctx));
    expect(result.updated).toEqual(["q"]);
  });

  const fieldsV1: FieldsSpec = {
    label: { type: "string" },
    size: { type: "number" },
    kind: { type: "enum", options: ["x", "y"] },
  };
  const resultV1: FieldsSpec = {
    outcome: { type: "enum", options: ["ok", "bad"] },
    note: { type: "string" },
  };
  const fieldQueue = (fields: FieldsSpec, result: FieldsSpec) =>
    mount({ q: defineQueue({ fields, result }) });

  const fieldChanges: {
    name: string;
    fields: FieldsSpec;
    result: FieldsSpec;
  }[] = [
    {
      name: "a removed field",
      fields: { size: fieldsV1.size, kind: fieldsV1.kind },
      result: resultV1,
    },
    {
      name: "a field that changes type",
      fields: { ...fieldsV1, size: { type: "string" } },
      result: resultV1,
    },
    {
      name: "a dropped enum option",
      fields: { ...fieldsV1, kind: { type: "enum", options: ["x"] } },
      result: resultV1,
    },
    {
      name: "an enum field turned into a string",
      fields: { ...fieldsV1, kind: { type: "string" } },
      result: resultV1,
    },
    {
      name: "a removed result field",
      fields: fieldsV1,
      result: { outcome: resultV1.outcome },
    },
    {
      name: "a result field that changes type",
      fields: fieldsV1,
      result: { ...resultV1, note: { type: "number" } },
    },
    {
      name: "a dropped result enum option",
      fields: fieldsV1,
      result: { ...resultV1, outcome: { type: "enum", options: ["ok"] } },
    },
  ];

  test.each(fieldChanges)(
    "sync refuses $name with FIELD_CHANGED and keeps the stored queue",
    async ({ fields, result }) => {
      const t = await readyWith(fieldQueue(fieldsV1, resultV1));
      await expectCode(
        t.run((ctx) => fieldQueue(fields, result).sync(ctx)),
        "FIELD_CHANGED",
      );
      const stored = await storedQueue(t, "q");
      expect(stored?.schemaVersion).toBe(1);
      expect(stored?.fields.map((f) => f.key)).toEqual([
        "label",
        "size",
        "kind",
      ]);
      expect(stored?.resultFields.map((f) => f.key)).toEqual([
        "outcome",
        "note",
      ]);
    },
  );

  test("sync allows a new field, a new result field and a new enum option, and new tickets carry the new schemaVersion", async () => {
    const v1 = fieldQueue(fieldsV1, resultV1);
    const t = await readyWith(v1);
    const before = await t.run((ctx) =>
      v1.open(ctx, { queue: "q", actor: REQ, title: "old shape" }),
    );
    const v2 = fieldQueue(
      {
        ...fieldsV1,
        kind: { type: "enum", options: ["x", "y", "z"] },
        extra: { type: "boolean" },
      },
      {
        ...resultV1,
        outcome: { type: "enum", options: ["ok", "bad", "meh"] },
        more: { type: "string" },
      },
    );
    const result = await t.run((ctx) => v2.sync(ctx));
    expect(result.updated).toEqual(["q"]);
    const stored = await storedQueue(t, "q");
    expect(stored?.schemaVersion).toBe(2);
    expect(stored?.fields.find((f) => f.key === "kind")?.options).toEqual([
      "x",
      "y",
      "z",
    ]);
    expect(stored?.fields.map((f) => f.key)).toContain("extra");
    expect(stored?.resultFields.map((f) => f.key)).toContain("more");

    const after = await t.run((ctx) =>
      v2.open(ctx, {
        queue: "q",
        actor: REQ,
        title: "new shape",
        fields: { kind: "z" },
      }),
    );
    expect((await ticketOf(t, before)).schemaVersion).toBe(1);
    expect((await ticketOf(t, after)).schemaVersion).toBe(2);
  });

  const FOUR_STATES: SyncQueue["states"] = [
    { name: "new", category: "unstarted" },
    { name: "doing", category: "started" },
    { name: "done", category: "done" },
    { name: "gone", category: "canceled" },
  ];
  const baseQueue: SyncQueue = {
    ...toQueueDef("q", defineQueue({})),
    states: FOUR_STATES,
  };

  const invalidQueues: { name: string; queues: SyncQueue[] }[] = [
    {
      name: "no unstarted state",
      queues: [
        {
          ...baseQueue,
          states: FOUR_STATES.filter((s) => s.category !== "unstarted"),
        },
      ],
    },
    {
      name: "no started state",
      queues: [
        {
          ...baseQueue,
          states: FOUR_STATES.filter((s) => s.category !== "started"),
        },
      ],
    },
    {
      name: "no done state",
      queues: [
        {
          ...baseQueue,
          states: FOUR_STATES.filter((s) => s.category !== "done"),
        },
      ],
    },
    {
      name: "no canceled state",
      queues: [
        {
          ...baseQueue,
          states: FOUR_STATES.filter((s) => s.category !== "canceled"),
        },
      ],
    },
    { name: "no states at all", queues: [{ ...baseQueue, states: [] }] },
    {
      name: "an on target on a started state",
      queues: [
        {
          ...baseQueue,
          states: FOUR_STATES.map((s) =>
            s.category === "started" ? { ...s, on: "requester" as const } : s,
          ),
        },
      ],
    },
    {
      name: "two states with the same name",
      queues: [
        {
          ...baseQueue,
          states: [...FOUR_STATES, { name: "new", category: "backlog" }],
        },
      ],
    },
    {
      name: "a state with an empty name",
      queues: [
        {
          ...baseQueue,
          states: [...FOUR_STATES, { name: "", category: "backlog" }],
        },
      ],
    },
    {
      name: "an enum field without options",
      queues: [
        { ...baseQueue, fields: [{ key: "k", type: "enum", required: false }] },
      ],
    },
    {
      name: "an enum field with an empty option list",
      queues: [
        {
          ...baseQueue,
          fields: [{ key: "k", type: "enum", required: false, options: [] }],
        },
      ],
    },
    {
      name: "options on a field that is not an enum",
      queues: [
        {
          ...baseQueue,
          fields: [
            { key: "k", type: "string", required: false, options: ["a"] },
          ],
        },
      ],
    },
    {
      name: "an enum result field without options",
      queues: [
        {
          ...baseQueue,
          resultFields: [{ key: "k", type: "enum", required: false }],
        },
      ],
    },
    {
      name: "two fields with the same key",
      queues: [
        {
          ...baseQueue,
          fields: [
            { key: "k", type: "string", required: false },
            { key: "k", type: "number", required: false },
          ],
        },
      ],
    },
    {
      name: "a field with an empty key",
      queues: [
        {
          ...baseQueue,
          fields: [{ key: "", type: "string", required: false }],
        },
      ],
    },
    {
      name: "an escalateTo that is not a defined queue",
      queues: [
        { ...baseQueue, policy: { ...baseQueue.policy, escalateTo: "ghost" } },
      ],
    },
    {
      name: "an escalateTo that is the queue itself",
      queues: [
        { ...baseQueue, policy: { ...baseQueue.policy, escalateTo: "q" } },
      ],
    },
    { name: "two queues with the same name", queues: [baseQueue, baseQueue] },
    { name: "an empty queue name", queues: [{ ...baseQueue, name: "" }] },
    {
      name: "a queue name that starts with a dash",
      queues: [{ ...baseQueue, name: "-lead" }],
    },
    {
      name: "a queue name with a slash",
      queues: [{ ...baseQueue, name: "a/b" }],
    },
  ];

  test.each(invalidQueues)(
    "sync refuses a queue with $name with INVALID_QUEUE and writes nothing",
    async ({ queues }) => {
      const t = setup();
      await expectCode(rawSync(t, queues), "INVALID_QUEUE");
      for (const queue of queues)
        expect(await storedQueue(t, queue.name)).toBeNull();
    },
  );

  test("a refused sync writes none of its queues", async () => {
    const t = setup();
    const valid: SyncQueue = { ...baseQueue, name: "fine" };
    const invalid: SyncQueue = { ...baseQueue, name: "broken", states: [] };
    await expectCode(rawSync(t, [valid, invalid]), "INVALID_QUEUE");
    expect(await storedQueue(t, "fine")).toBeNull();
    expect(await storedQueue(t, "broken")).toBeNull();
  });

  const badPolicies: { name: string; policy: Partial<SyncQueue["policy"]> }[] =
    [
      { name: "a negative maxHops", policy: { maxHops: -1 } },
      { name: "a fractional maxHops", policy: { maxHops: 1.5 } },
      { name: "a NaN maxHops", policy: { maxHops: Number.NaN } },
      { name: "a negative maxReturns", policy: { maxReturns: -1 } },
      { name: "a negative maxMessages", policy: { maxMessages: -1 } },
      {
        name: "a negative maxOpenPerRequester",
        policy: { maxOpenPerRequester: -1 },
      },
      { name: "a negative leaseMs", policy: { leaseMs: -5 } },
      {
        name: "an infinite leaseMs",
        policy: { leaseMs: Number.POSITIVE_INFINITY },
      },
      { name: "a leaseMs of 0", policy: { leaseMs: 0 } },
      { name: "a negative reopenWindowMs", policy: { reopenWindowMs: -1 } },
      { name: "a negative dueInMs", policy: { dueInMs: -1 } },
    ];

  test.each(badPolicies)(
    "sync refuses $name with INVALID_QUEUE",
    async ({ policy }) => {
      const t = setup();
      await expectCode(
        rawSync(t, [
          { ...baseQueue, policy: { ...baseQueue.policy, ...policy } },
        ]),
        "INVALID_QUEUE",
      );
      expect(await storedQueue(t, "q")).toBeNull();
    },
  );

  test("sync accepts zero for the hop, return and message caps and for the reopen and due windows", async () => {
    const t = setup();
    const client = mount({
      zero: defineQueue({
        policy: {
          maxHops: 0,
          maxReturns: 0,
          maxMessages: 0,
          reopenWindowMs: 0,
          dueInMs: 0,
        },
      }),
    });
    expect(await t.run((ctx) => client.sync(ctx))).toEqual({
      created: ["zero"],
      updated: [],
      unchanged: [],
    });
  });

  test("sync accepts an escalateTo that an earlier sync wrote", async () => {
    const t = setup();
    const desk = mount({ desk: defineQueue(deskQueue()) });
    const bot = mount({ bot: defineQueue({ policy: { escalateTo: "desk" } }) });
    await t.run((ctx) => desk.sync(ctx));
    expect(await t.run((ctx) => bot.sync(ctx))).toEqual({
      created: ["bot"],
      updated: [],
      unchanged: [],
    });
  });

  test("sync accepts namespaced queue names", async () => {
    const t = setup();
    const client = mount({
      "org_42:billing v2": defineQueue({}),
      "billing-humans.eu": defineQueue({}),
    });
    const result = await t.run((ctx) => client.sync(ctx));
    expect(result.created).toEqual(["org_42:billing v2", "billing-humans.eu"]);
  });

  test("sync refuses an onEventHandle that did not come from createFunctionHandle with INVALID_ARGUMENT", async () => {
    const t = setup();
    await expectCode(
      rawSync(t, [baseQueue], { onEventHandle: "not-a-handle" }),
      "INVALID_ARGUMENT",
    );
    expect(await storedQueue(t, "q")).toBeNull();
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "sync refuses a retentionMs of %s with INVALID_ARGUMENT",
    async (retentionMs) => {
      const t = setup();
      const client = new Tickets(components.tickets, {
        queues: { q: defineQueue({}) },
        retentionMs,
      });
      await expectCode(
        t.run((ctx) => client.sync(ctx)),
        "INVALID_ARGUMENT",
      );
    },
  );

  test("sync accepts a retentionMs of 1", async () => {
    const t = setup();
    const client = new Tickets(components.tickets, {
      queues: { q: defineQueue({}) },
      retentionMs: 1,
    });
    expect(await t.run((ctx) => client.sync(ctx))).toEqual({
      created: ["q"],
      updated: [],
      unchanged: [],
    });
  });

  const LIMIT_KEYS: (keyof Limits)[] = [
    "maxBodyChars",
    "maxStringChars",
    "maxFields",
    "maxBlockers",
    "maxBlocked",
    "maxGraphWalk",
    "opensPerMinute",
    "messagesPerMinute",
  ];
  const limitsWith = (key: keyof Limits, value: number): Partial<Limits> => {
    const limits: Partial<Limits> = {};
    limits[key] = value;
    return limits;
  };

  test.each(LIMIT_KEYS)(
    "sync refuses a %s of 0 with INVALID_ARGUMENT",
    async (key) => {
      const t = setup();
      const client = mount({ q: defineQueue({}) }, limitsWith(key, 0));
      await expectCode(
        t.run((ctx) => client.sync(ctx)),
        "INVALID_ARGUMENT",
      );
    },
  );

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "sync refuses a limit of %s with INVALID_ARGUMENT",
    async (value) => {
      const t = setup();
      const client = mount(
        { q: defineQueue({}) },
        limitsWith("maxFields", value),
      );
      await expectCode(
        t.run((ctx) => client.sync(ctx)),
        "INVALID_ARGUMENT",
      );
    },
  );

  test.each(LIMIT_KEYS)("sync accepts a %s of 1", async (key) => {
    const t = setup();
    const client = mount({ q: defineQueue({}) }, limitsWith(key, 1));
    expect(await t.run((ctx) => client.sync(ctx))).toEqual({
      created: ["q"],
      updated: [],
      unchanged: [],
    });
  });

  test("the limits of the latest sync apply", async () => {
    const tight = mount({ q: defineQueue({}) }, { maxStringChars: 5 });
    const t = await readyWith(tight);
    await expectCode(
      t.run((ctx) =>
        tight.open(ctx, { queue: "q", actor: REQ, title: "123456" }),
      ),
      "TOO_LONG",
    );
    const loose = mount({ q: defineQueue({}) });
    await t.run((ctx) => loose.sync(ctx));
    await t.run((ctx) =>
      loose.open(ctx, { queue: "q", actor: REQ, title: "123456" }),
    );
  });
});

describe("open", () => {
  test("a new ticket lands unstarted in the first unstarted state of its queue", async () => {
    const t = await ready();
    const agent = await ticketOf(t, await openAgent(t));
    const desk = await ticketOf(
      t,
      await t.run((ctx) =>
        lab.open(ctx, { queue: "humans", actor: REQ, title: "x" }),
      ),
    );
    const proj = await ticketOf(t, await openProj(t, "x"));
    expect(agent).toMatchObject({
      queue: "agent",
      state: "open",
      category: "unstarted",
      claimSeq: 0,
      priority: 2,
      requesterRef: REQ.ref,
      requesterKind: "agent",
      openBlockers: 0,
      hopCount: 0,
      messageCount: 0,
      leaseExpiryCount: 0,
      schemaVersion: 1,
    });
    expect(agent.assigneeRef).toBeUndefined();
    expect(desk).toMatchObject({
      queue: "humans",
      state: "new",
      category: "unstarted",
    });
    expect(proj).toMatchObject({
      queue: "proj",
      state: "todo",
      category: "unstarted",
    });
  });

  test("open stores the fields, drops null fields and records an opened transition and one hook event", async () => {
    const t = await ready();
    const ticketId = await openRaw(t, {
      fields: { amount: 5, currency: "EUR", note: null },
    });
    const ticket = await ticketOf(t, ticketId);
    expect(ticket.fields).toEqual({ amount: 5, currency: "EUR" });
    const history = await transitionsOf(t, ticketId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      seq: 1,
      type: "opened",
      actorRef: REQ.ref,
      toState: "open",
      toCategory: "unstarted",
    });
    await drain(t);
    const sent = (await events(t)).filter((e) => e.ticketId === ticketId);
    expect(sent.map((e) => e.type)).toEqual(["opened"]);
  });

  const badOpens: {
    name: string;
    code: TicketsErrorCode;
    args: Partial<OpenArgs>;
  }[] = [
    {
      name: "an unknown field key",
      code: "UNKNOWN_FIELD",
      args: { fields: { amount: 1, bogus: true } },
    },
    {
      name: "a number field given a string",
      code: "INVALID_FIELD",
      args: { fields: { amount: "5" } },
    },
    {
      name: "an enum value that is not an option",
      code: "INVALID_FIELD",
      args: { fields: { amount: 1, currency: "GBP" } },
    },
    {
      name: "an enum field given a number",
      code: "INVALID_FIELD",
      args: { fields: { amount: 1, currency: 5 } },
    },
    {
      name: "a boolean field given a string",
      code: "INVALID_FIELD",
      args: { fields: { amount: 1, urgent: "yes" } },
    },
    {
      name: "a string field given a number",
      code: "INVALID_FIELD",
      args: { fields: { amount: 1, note: 5 } },
    },
    {
      name: "a number field given Infinity",
      code: "INVALID_FIELD",
      args: { fields: { amount: Number.POSITIVE_INFINITY } },
    },
    {
      name: "a number field given -Infinity",
      code: "INVALID_FIELD",
      args: { fields: { amount: Number.NEGATIVE_INFINITY } },
    },
    {
      name: "a number field given NaN",
      code: "INVALID_FIELD",
      args: { fields: { amount: Number.NaN } },
    },
    {
      name: "no fields object at all",
      code: "MISSING_FIELD",
      args: { fields: undefined },
    },
    {
      name: "an empty fields object",
      code: "MISSING_FIELD",
      args: { fields: {} },
    },
    {
      name: "fields that leave out a required key",
      code: "MISSING_FIELD",
      args: { fields: { note: "x" } },
    },
    {
      name: "null on a required field",
      code: "MISSING_FIELD",
      args: { fields: { amount: null } },
    },
    {
      name: "an unknown queue",
      code: "UNKNOWN_QUEUE",
      args: { queue: "ghost" },
    },
    {
      name: "a to state the queue does not have",
      code: "UNKNOWN_STATE",
      args: { to: "ghost" },
    },
    {
      name: "a started to state",
      code: "INVALID_TARGET",
      args: { to: "working" },
    },
    {
      name: "a waiting to state",
      code: "INVALID_TARGET",
      args: { to: "waiting" },
    },
    {
      name: "a done to state",
      code: "INVALID_TARGET",
      args: { to: "resolved" },
    },
    {
      name: "a canceled to state",
      code: "INVALID_TARGET",
      args: { to: "canceled" },
    },
    { name: "an empty title", code: "INVALID_ARGUMENT", args: { title: "" } },
    { name: "a blank title", code: "INVALID_ARGUMENT", args: { title: "   " } },
    {
      name: "a priority below 0",
      code: "INVALID_ARGUMENT",
      args: { priority: -1 },
    },
    {
      name: "a priority above 4",
      code: "INVALID_ARGUMENT",
      args: { priority: 5 },
    },
    {
      name: "a fractional priority",
      code: "INVALID_ARGUMENT",
      args: { priority: 1.5 },
    },
    {
      name: "a NaN priority",
      code: "INVALID_ARGUMENT",
      args: { priority: Number.NaN },
    },
  ];

  test.each(badOpens)(
    "open refuses $name with $code and creates no ticket",
    async ({ args, code }) => {
      const t = await ready();
      await expectCode(openRaw(t, args), code);
      const all = await t.run((ctx) =>
        lab.list(ctx, {
          filter: { by: "requester", requesterRef: REQ.ref },
          paginationOpts: { cursor: null, numItems: 10 },
        }),
      );
      expect(all.page).toEqual([]);
    },
  );

  test.each([0, 4])(
    "open accepts priority %s and stores it",
    async (priority) => {
      const t = await ready();
      const ticket = await ticketOf(t, await openRaw(t, { priority }));
      expect(ticket.priority).toBe(priority);
    },
  );

  test("open accepts a null on an optional field and a to state in the backlog or unstarted category", async () => {
    const t = await ready();
    expect(
      await ticketOf(t, await openProj(t, "planned", { to: "backlog" })),
    ).toMatchObject({
      state: "backlog",
      category: "backlog",
    });
    expect(
      await ticketOf(t, await openProj(t, "ready", { to: "todo" })),
    ).toMatchObject({
      state: "todo",
      category: "unstarted",
    });
    expect(
      await ticketOf(
        t,
        await openRaw(t, { to: "open", fields: { amount: 1, note: null } }),
      ),
    ).toMatchObject({
      state: "open",
    });
  });

  test("a title at the default length limit is accepted and one character more gets TOO_LONG", async () => {
    const t = await ready();
    await openRaw(t, { title: "t".repeat(1000) });
    await expectCode(openRaw(t, { title: "t".repeat(1001) }), "TOO_LONG");
  });

  describe("with small limits", () => {
    const small = mount(
      {
        q: defineQueue({
          fields: {
            s: { type: "string" },
            a: { type: "number" },
            b: { type: "number" },
            c: { type: "number" },
          },
        }),
      },
      { maxStringChars: 10, maxBodyChars: 20, maxFields: 2 },
    );
    const open = (
      t: T,
      args: {
        title?: string;
        body?: string;
        fields?: { s?: string; a?: number; b?: number; c?: number };
      },
    ) =>
      t.run((ctx) =>
        small.open(ctx, {
          queue: "q",
          actor: REQ,
          title: args.title ?? "ok",
          body: args.body,
          fields: args.fields,
        }),
      );

    test("a title, a string field and a body exactly at their limits are accepted", async () => {
      const t = await readyWith(small);
      await open(t, {
        title: "t".repeat(10),
        body: "b".repeat(20),
        fields: { s: "s".repeat(10) },
      });
    });

    test("a title one character over the limit gets TOO_LONG", async () => {
      const t = await readyWith(small);
      await expectCode(open(t, { title: "t".repeat(11) }), "TOO_LONG");
    });

    test("a string field one character over the limit gets TOO_LONG", async () => {
      const t = await readyWith(small);
      await expectCode(open(t, { fields: { s: "s".repeat(11) } }), "TOO_LONG");
    });

    test("a body one character over the limit gets TOO_LONG", async () => {
      const t = await readyWith(small);
      await expectCode(open(t, { body: "b".repeat(21) }), "TOO_LONG");
    });

    test("fields with exactly maxFields keys are accepted", async () => {
      const t = await readyWith(small);
      await open(t, { fields: { a: 1, b: 2 } });
    });

    test("fields with one key more than maxFields get TOO_MANY_FIELDS", async () => {
      const t = await readyWith(small);
      await expectCode(
        open(t, { fields: { a: 1, b: 2, c: 3 } }),
        "TOO_MANY_FIELDS",
      );
    });
  });

  test("a repeated idempotency key returns the first ticket and writes nothing more", async () => {
    const t = await ready();
    const first = await openRaw(t, { idempotencyKey: "refund:conv_7f3" });
    const retry = await openRaw(t, { idempotencyKey: "refund:conv_7f3" });
    expect(retry).toBe(first);
    const all = await t.run((ctx) =>
      lab.list(ctx, {
        filter: { by: "queue", queue: "agent" },
        paginationOpts: { cursor: null, numItems: 10 },
      }),
    );
    expect(all.page).toHaveLength(1);
    expect(await transitionsOf(t, first)).toHaveLength(1);
    await drain(t);
    expect((await events(t)).filter((e) => e.type === "opened")).toHaveLength(
      1,
    );
  });

  test("the same idempotency key from another requester, or a different key, opens another ticket", async () => {
    const t = await ready();
    const first = await openRaw(t, { idempotencyKey: "k" });
    const otherRequester = await openRaw(t, { idempotencyKey: "k", actor: A });
    const otherKey = await openRaw(t, { idempotencyKey: "k2" });
    expect(new Set([first, otherRequester, otherKey]).size).toBe(3);
  });

  test("a parent that exists is stored and a missing parent gets NOT_FOUND", async () => {
    const t = await ready();
    const parent = await openProj(t, "epic");
    const child = await openProj(t, "story", { parentId: parent });
    expect((await ticketOf(t, child)).parentId).toBe(parent);
    await expectCode(
      openRaw(t, { parentId: missingTicketId(parent) }),
      "NOT_FOUND",
    );
  });

  describe("per requester caps", () => {
    const capped = mount({
      jobs: defineQueue({ policy: { maxOpenPerRequester: 2 } }),
      side: defineQueue({ policy: { maxOpenPerRequester: 2 } }),
    });
    const openIn = (t: T, queue: "jobs" | "side", actor: Party, key?: string) =>
      t.run((ctx) =>
        capped.open(ctx, { queue, actor, title: "x", idempotencyKey: key }),
      );

    test("a requester can have exactly maxOpenPerRequester open tickets in a queue", async () => {
      const t = await readyWith(capped);
      await openIn(t, "jobs", REQ);
      await openIn(t, "jobs", REQ);
      const all = await t.run((ctx) =>
        lab.list(ctx, {
          filter: { by: "requester", requesterRef: REQ.ref },
          paginationOpts: { cursor: null, numItems: 10 },
        }),
      );
      expect(all.page).toHaveLength(2);
    });

    test("the open past the cap, and every open after it, gets TOO_MANY_OPEN", async () => {
      const t = await readyWith(capped);
      await openIn(t, "jobs", REQ);
      await openIn(t, "jobs", REQ);
      await expectCode(openIn(t, "jobs", REQ), "TOO_MANY_OPEN");
      await expectCode(openIn(t, "jobs", REQ), "TOO_MANY_OPEN");
    });

    test("the cap is counted per requester and per queue", async () => {
      const t = await readyWith(capped);
      await openIn(t, "jobs", REQ);
      await openIn(t, "jobs", REQ);
      await openIn(t, "jobs", A);
      await openIn(t, "side", REQ);
    });

    test("a canceled or resolved ticket stops counting toward the cap", async () => {
      const t = await readyWith(capped);
      const first = await openIn(t, "jobs", REQ);
      const second = await openIn(t, "jobs", REQ);
      await expectCode(openIn(t, "jobs", REQ), "TOO_MANY_OPEN");
      await t.run((ctx) => capped.cancel(ctx, { ticketId: first, actor: REQ }));
      await openIn(t, "jobs", REQ);
      await expectCode(openIn(t, "jobs", REQ), "TOO_MANY_OPEN");
      const { claimSeq } = await claimOk(t, second, A);
      await t.run((ctx) =>
        capped.resolve(ctx, {
          ticketId: second,
          actor: A,
          claimSeq,
          resolution: "completed",
        }),
      );
      await openIn(t, "jobs", REQ);
    });

    test("a repeated idempotency key at the cap returns the first ticket instead of TOO_MANY_OPEN", async () => {
      const t = await readyWith(capped);
      const first = await openIn(t, "jobs", REQ, "k1");
      await openIn(t, "jobs", REQ);
      await expectCode(openIn(t, "jobs", REQ, "k2"), "TOO_MANY_OPEN");
      expect(await openIn(t, "jobs", REQ, "k1")).toBe(first);
    });
  });

  test("backlog, unstarted, started and waiting tickets all count toward the cap", async () => {
    const full = mount({
      full: defineQueue({
        states: {
          backlog: { category: "backlog" },
          todo: { category: "unstarted" },
          doing: { category: "started" },
          hold: { category: "waiting", on: "requester" },
          done: { category: "done" },
          gone: { category: "canceled" },
        },
        policy: { leaseMs: null, maxOpenPerRequester: 4 },
      }),
    });
    const t = await readyWith(full);
    const open = (to?: "backlog") =>
      t.run((ctx) =>
        full.open(ctx, { queue: "full", actor: REQ, title: "x", to }),
      );
    await open("backlog");
    await open();
    const started = await open();
    await claimOk(t, started, A);
    const waiting = await open();
    const { claimSeq } = await claimOk(t, waiting, A);
    await t.run((ctx) =>
      lab.requestInput(ctx, {
        ticketId: waiting,
        actor: A,
        claimSeq,
        body: "which one?",
      }),
    );
    expect(await ticketOf(t, waiting)).toMatchObject({ category: "waiting" });
    await expectCode(open(), "TOO_MANY_OPEN");
  });

  describe("rate limit", () => {
    const limited = mount({ jobs: defineQueue({}) }, { opensPerMinute: 2 });
    const openAs = (t: T, actor: Party, key?: string) =>
      t.run((ctx) =>
        limited.open(ctx, {
          queue: "jobs",
          actor,
          title: "x",
          idempotencyKey: key,
        }),
      );

    test("a party can open opensPerMinute tickets in a minute", async () => {
      const t = await readyWith(limited);
      await openAs(t, A);
      await openAs(t, A);
    });

    test("the open past opensPerMinute gets RATE_LIMITED with a retry time and writes nothing", async () => {
      const t = await readyWith(limited);
      await openAs(t, A);
      await openAs(t, A);
      const before = Date.now();
      const data = await ticketsErrorOf(openAs(t, A));
      expect(data.code).toBe("RATE_LIMITED");
      expect(data.retryAt).toBeGreaterThan(before);
      expect(data.retryAt).toBeLessThanOrEqual(before + MINUTE + 100);
      const mine = await t.run((ctx) =>
        lab.list(ctx, {
          filter: { by: "requester", requesterRef: A.ref },
          paginationOpts: { cursor: null, numItems: 10 },
        }),
      );
      expect(mine.page).toHaveLength(2);
    });

    test("the limit is per party", async () => {
      const t = await readyWith(limited);
      await openAs(t, A);
      await openAs(t, A);
      await expectCode(openAs(t, A), "RATE_LIMITED");
      await openAs(t, B);
    });

    test("a party can open again after a minute of fake time", async () => {
      const t = await readyWith(limited);
      await openAs(t, A);
      await openAs(t, A);
      await expectCode(openAs(t, A), "RATE_LIMITED");
      vi.advanceTimersByTime(MINUTE);
      await openAs(t, A);
      await openAs(t, A);
      await expectCode(openAs(t, A), "RATE_LIMITED");
    });

    test("an open is refused until retryAt and allowed at retryAt", async () => {
      const t = await readyWith(limited);
      await openAs(t, A);
      await openAs(t, A);
      const data = await ticketsErrorOf(openAs(t, A));
      const wait = (data.retryAt ?? 0) - Date.now();
      vi.advanceTimersByTime(wait - 1000);
      await expectCode(openAs(t, A), "RATE_LIMITED");
      vi.advanceTimersByTime(1000);
      await openAs(t, A);
    });

    test("a repeated idempotency key at the limit returns the first ticket instead of RATE_LIMITED", async () => {
      const t = await readyWith(limited);
      const first = await openAs(t, A, "k1");
      await openAs(t, A);
      await expectCode(openAs(t, A, "k2"), "RATE_LIMITED");
      expect(await openAs(t, A, "k1")).toBe(first);
    });
  });
});

describe("get, list, search and history", () => {
  test("get returns the ticket with no lease, links, blockers or messages on a fresh ticket", async () => {
    const t = await ready();
    const ticketId = await openAgent(t, 7);
    const detail = await t.run((ctx) => lab.get(ctx, { ticketId }));
    expect(detail).toMatchObject({
      ticket: { ticketId, title: "job", fields: { amount: 7 } },
      links: [],
      blockers: [],
      messages: [],
    });
    expect(detail?.leaseExpiresAt).toBeUndefined();
  });

  test("get reports the lease expiry of a claimed ticket in a lease queue", async () => {
    const t = await ready();
    const ticketId = await openAgent(t);
    const claim = await claimOk(t, ticketId, A);
    const detail = await t.run((ctx) => lab.get(ctx, { ticketId }));
    expect(detail?.leaseExpiresAt).toBe(claim.leaseExpiresAt);
  });

  test("get with the right queue succeeds and with another queue gets WRONG_QUEUE", async () => {
    const t = await ready();
    const ticketId = await openAgent(t);
    expect(
      (await t.run((ctx) => lab.get(ctx, { ticketId, queue: "agent" })))?.ticket
        .ticketId,
    ).toBe(ticketId);
    await expectCode(
      t.run((ctx) => lab.get(ctx, { ticketId, queue: "people" })),
      "WRONG_QUEUE",
    );
  });

  test("get returns null for a ticket that does not exist", async () => {
    const t = await ready();
    const real = await openAgent(t);
    expect(
      await t.run((ctx) => lab.get(ctx, { ticketId: missingTicketId(real) })),
    ).toBeNull();
  });

  type Board = { plan: string; build: string; ship: string; other: string };
  async function seedBoard(t: T): Promise<Board> {
    const plan = await openProj(t, "Plan", {
      to: "backlog",
      subjectRef: "customer:1",
    });
    const build = await openProj(t, "Build", {
      actor: LEAD,
      subjectRef: "customer:1",
      parentId: plan,
    });
    const ship = await openProj(t, "Ship", { subjectRef: "customer:2" });
    await claimOk(t, ship, A);
    const other = await openPeople(t, "Other");
    return { plan, build, ship, other };
  }
  async function titlesOf(t: T, filter: ListFilter): Promise<string[]> {
    const result = await t.run((ctx) =>
      lab.list(ctx, { filter, paginationOpts: { cursor: null, numItems: 50 } }),
    );
    return result.page.map((ticket) => ticket.title).sort();
  }

  test("list by queue returns every ticket of that queue and none of another", async () => {
    const t = await ready();
    await seedBoard(t);
    expect(await titlesOf(t, { by: "queue", queue: "proj" })).toEqual([
      "Build",
      "Plan",
      "Ship",
    ]);
    expect(await titlesOf(t, { by: "queue", queue: "people" })).toEqual([
      "Other",
    ]);
    expect(await titlesOf(t, { by: "queue", queue: "ghost" })).toEqual([]);
  });

  test("list by queue and state returns only the tickets in that state", async () => {
    const t = await ready();
    await seedBoard(t);
    expect(
      await titlesOf(t, { by: "queue", queue: "proj", state: "backlog" }),
    ).toEqual(["Plan"]);
    expect(
      await titlesOf(t, { by: "queue", queue: "proj", state: "todo" }),
    ).toEqual(["Build"]);
    expect(
      await titlesOf(t, { by: "queue", queue: "proj", state: "in_progress" }),
    ).toEqual(["Ship"]);
    expect(
      await titlesOf(t, { by: "queue", queue: "proj", state: "in_review" }),
    ).toEqual([]);
  });

  test("list by queue and category returns only the tickets in that category", async () => {
    const t = await ready();
    await seedBoard(t);
    expect(
      await titlesOf(t, { by: "queue", queue: "proj", category: "backlog" }),
    ).toEqual(["Plan"]);
    expect(
      await titlesOf(t, { by: "queue", queue: "proj", category: "unstarted" }),
    ).toEqual(["Build"]);
    expect(
      await titlesOf(t, { by: "queue", queue: "proj", category: "started" }),
    ).toEqual(["Ship"]);
    expect(
      await titlesOf(t, { by: "queue", queue: "proj", category: "done" }),
    ).toEqual([]);
  });

  test("list refuses a state and a category together with INVALID_ARGUMENT", async () => {
    const t = await ready();
    await seedBoard(t);
    await expectCode(
      t.run((ctx) =>
        lab.list(ctx, {
          filter: {
            by: "queue",
            queue: "proj",
            state: "todo",
            category: "unstarted",
          },
          paginationOpts: { cursor: null, numItems: 10 },
        }),
      ),
      "INVALID_ARGUMENT",
    );
  });

  test("list by assignee returns what the party holds, optionally narrowed by category", async () => {
    const t = await ready();
    await seedBoard(t);
    expect(await titlesOf(t, { by: "assignee", assigneeRef: A.ref })).toEqual([
      "Ship",
    ]);
    expect(
      await titlesOf(t, {
        by: "assignee",
        assigneeRef: A.ref,
        category: "started",
      }),
    ).toEqual(["Ship"]);
    expect(
      await titlesOf(t, {
        by: "assignee",
        assigneeRef: A.ref,
        category: "unstarted",
      }),
    ).toEqual([]);
    expect(await titlesOf(t, { by: "assignee", assigneeRef: B.ref })).toEqual(
      [],
    );
  });

  test("list by requester returns what the party opened, optionally narrowed by category", async () => {
    const t = await ready();
    await seedBoard(t);
    expect(
      await titlesOf(t, { by: "requester", requesterRef: REQ.ref }),
    ).toEqual(["Other", "Plan", "Ship"]);
    expect(
      await titlesOf(t, {
        by: "requester",
        requesterRef: REQ.ref,
        category: "backlog",
      }),
    ).toEqual(["Plan"]);
    expect(
      await titlesOf(t, { by: "requester", requesterRef: LEAD.ref }),
    ).toEqual(["Build"]);
    expect(
      await titlesOf(t, {
        by: "requester",
        requesterRef: LEAD.ref,
        category: "started",
      }),
    ).toEqual([]);
  });

  test("list by subject returns the tickets about that subject", async () => {
    const t = await ready();
    await seedBoard(t);
    expect(
      await titlesOf(t, { by: "subject", subjectRef: "customer:1" }),
    ).toEqual(["Build", "Plan"]);
    expect(
      await titlesOf(t, { by: "subject", subjectRef: "customer:2" }),
    ).toEqual(["Ship"]);
    expect(
      await titlesOf(t, { by: "subject", subjectRef: "customer:3" }),
    ).toEqual([]);
  });

  test("list by parent returns the children of a ticket", async () => {
    const t = await ready();
    const board = await seedBoard(t);
    expect(await titlesOf(t, { by: "parent", parentId: board.plan })).toEqual([
      "Build",
    ]);
    expect(await titlesOf(t, { by: "parent", parentId: board.build })).toEqual(
      [],
    );
  });

  test("list pages through a queue by priority then age and every cursor continues where the last page stopped", async () => {
    const t = await ready();
    for (const [index, priority] of [3, 0, 2, 0, 1].entries()) {
      await openPeople(t, `p${priority}-${index}`, REQ, priority);
      vi.advanceTimersByTime(1000);
    }
    const filter: ListFilter = { by: "queue", queue: "people", state: "open" };
    const page = (cursor: string | null) =>
      t.run((ctx) =>
        lab.list(ctx, { filter, paginationOpts: { cursor, numItems: 2 } }),
      );
    const first = await page(null);
    expect(first.page.map((p) => p.title)).toEqual(["p0-1", "p0-3"]);
    expect(first.isDone).toBe(false);
    const second = await page(first.continueCursor);
    expect(second.page.map((p) => p.title)).toEqual(["p1-4", "p2-2"]);
    expect(second.isDone).toBe(false);
    const third = await page(second.continueCursor);
    expect(third.page.map((p) => p.title)).toEqual(["p3-0"]);
    expect(third.isDone).toBe(true);
  });

  test("a page size larger than the result returns everything and isDone", async () => {
    const t = await ready();
    await openPeople(t, "only");
    const result = await t.run((ctx) =>
      lab.list(ctx, {
        filter: { by: "queue", queue: "people" },
        paginationOpts: { cursor: null, numItems: 50 },
      }),
    );
    expect(result.page.map((p) => p.title)).toEqual(["only"]);
    expect(result.isDone).toBe(true);
  });

  async function seedSearch(t: T) {
    await openAgent(t);
    await t.run((ctx) =>
      lab.open(ctx, {
        queue: "agent",
        actor: REQ,
        title: "Refund double charge",
        fields: { amount: 49 },
      }),
    );
    const late = await openPeople(t, "Refund late shipment");
    await openPeople(t, "Reset password");
    await claimOk(t, late, A);
  }
  const searchTitles = async (
    t: T,
    args: {
      text: string;
      queue?: "agent" | "people";
      category?: "started" | "unstarted";
      limit?: number;
    },
  ) => {
    const rows = await t.run((ctx) => lab.search(ctx, args));
    return rows.map((row) => row.title).sort();
  };

  test("search finds tickets by words in the title", async () => {
    const t = await ready();
    await seedSearch(t);
    expect(await searchTitles(t, { text: "refund" })).toEqual([
      "Refund double charge",
      "Refund late shipment",
    ]);
    expect(await searchTitles(t, { text: "password" })).toEqual([
      "Reset password",
    ]);
    expect(await searchTitles(t, { text: "nothing" })).toEqual([]);
  });

  test("search can be narrowed to one queue and one category", async () => {
    const t = await ready();
    await seedSearch(t);
    expect(await searchTitles(t, { text: "refund", queue: "people" })).toEqual([
      "Refund late shipment",
    ]);
    expect(await searchTitles(t, { text: "refund", queue: "agent" })).toEqual([
      "Refund double charge",
    ]);
    expect(
      await searchTitles(t, { text: "refund", category: "started" }),
    ).toEqual(["Refund late shipment"]);
    expect(
      await searchTitles(t, { text: "refund", category: "unstarted" }),
    ).toEqual(["Refund double charge"]);
    expect(
      await searchTitles(t, {
        text: "refund",
        queue: "agent",
        category: "started",
      }),
    ).toEqual([]);
  });

  test("search honours its limit at the smallest and largest allowed value", async () => {
    const t = await ready();
    await seedSearch(t);
    expect(await searchTitles(t, { text: "refund", limit: 1 })).toHaveLength(1);
    expect(await searchTitles(t, { text: "refund", limit: 100 })).toHaveLength(
      2,
    );
  });

  test.each([0, 101, 1.5, -1, Number.NaN])(
    "search refuses a limit of %s with INVALID_ARGUMENT",
    async (limit) => {
      const t = await ready();
      await expectCode(
        t.run((ctx) => lab.search(ctx, { text: "refund", limit })),
        "INVALID_ARGUMENT",
      );
    },
  );

  test("listTransitions returns the history oldest first with who, what and where", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    const { claimSeq } = await claimOk(t, ticketId, A);
    await t.run((ctx) => lab.release(ctx, { ticketId, actor: A, claimSeq }));
    const history = await transitionsOf(t, ticketId);
    expect(history.map((h) => [h.seq, h.type])).toEqual([
      [1, "opened"],
      [2, "claimed"],
      [3, "released"],
    ]);
    expect(history[0]).toMatchObject({
      actorRef: REQ.ref,
      toState: "open",
      toCategory: "unstarted",
    });
    expect(history[1]).toMatchObject({
      actorRef: A.ref,
      fromState: "open",
      toState: "working",
      fromCategory: "unstarted",
      toCategory: "started",
      toAssigneeRef: A.ref,
    });
    expect(history[2]).toMatchObject({
      actorRef: A.ref,
      fromState: "working",
      toState: "open",
      fromAssigneeRef: A.ref,
      toCategory: "unstarted",
    });
    expect(history[0]?.fromState).toBeUndefined();
  });

  test("listTransitions pages with a cursor", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    const { claimSeq } = await claimOk(t, ticketId, A);
    await t.run((ctx) => lab.release(ctx, { ticketId, actor: A, claimSeq }));
    const page = (cursor: string | null) =>
      t.run((ctx) =>
        lab.listTransitions(ctx, {
          ticketId,
          paginationOpts: { cursor, numItems: 2 },
        }),
      );
    const first = await page(null);
    expect(first.page.map((h) => h.type)).toEqual(["opened", "claimed"]);
    expect(first.isDone).toBe(false);
    const second = await page(first.continueCursor);
    expect(second.page.map((h) => h.type)).toEqual(["released"]);
    expect(second.isDone).toBe(true);
  });
});

describe("move", () => {
  test("a holder moves a ticket inside the started category and keeps the claim", async () => {
    const t = await ready();
    const ticketId = await openProj(t, "work");
    const { claimSeq } = await claimOk(t, ticketId, A);
    const result = await t.run((ctx) =>
      lab.move(ctx, { ticketId, actor: A, claimSeq, to: "in_review" }),
    );
    expect(result).toEqual({
      queue: "proj",
      state: "in_review",
      category: "started",
      claimSeq,
    });
    expect(await ticketOf(t, ticketId)).toMatchObject({
      state: "in_review",
      assigneeRef: A.ref,
      claimSeq,
    });
    const history = await transitionsOf(t, ticketId);
    expect(history.at(-1)).toMatchObject({
      type: "moved",
      actorRef: A.ref,
      fromState: "in_progress",
      toState: "in_review",
    });
  });

  test("a ticket moves from the backlog to unstarted and back without a holder", async () => {
    const t = await ready();
    const ticketId = await openProj(t, "idea", { to: "backlog" });
    const accepted = await t.run((ctx) =>
      lab.move(ctx, { ticketId, actor: LEAD, to: "todo" }),
    );
    expect(accepted).toMatchObject({ state: "todo", category: "unstarted" });
    const parked = await t.run((ctx) =>
      lab.move(ctx, { ticketId, actor: LEAD, to: "backlog" }),
    );
    expect(parked).toMatchObject({ state: "backlog", category: "backlog" });
    const history = await transitionsOf(t, ticketId);
    expect(history.map((h) => h.type)).toEqual(["opened", "moved", "moved"]);
  });

  const crossings: {
    name: string;
    from: "backlog" | "todo" | "in_progress";
    to: ProjState;
  }[] = [
    { name: "unstarted to started", from: "todo", to: "in_progress" },
    { name: "unstarted to done", from: "todo", to: "done" },
    { name: "unstarted to canceled", from: "todo", to: "canceled" },
    { name: "backlog to started", from: "backlog", to: "in_progress" },
    { name: "backlog to done", from: "backlog", to: "done" },
    { name: "started to unstarted", from: "in_progress", to: "todo" },
    { name: "started to backlog", from: "in_progress", to: "backlog" },
    { name: "started to done", from: "in_progress", to: "done" },
    { name: "started to canceled", from: "in_progress", to: "canceled" },
  ];

  test.each(crossings)(
    "move refuses $name with INVALID_MOVE and changes nothing",
    async ({ from, to }) => {
      const t = await ready();
      const ticketId = await openProj(t, "work", {
        to: from === "backlog" ? "backlog" : undefined,
      });
      if (from === "in_progress") await claimOk(t, ticketId, A);
      const before = await ticketOf(t, ticketId);
      await expectCode(
        t.run((ctx) =>
          lab.move(ctx, { ticketId, actor: LEAD, trusted: true, to }),
        ),
        "INVALID_MOVE",
      );
      expect(await ticketOf(t, ticketId)).toEqual(before);
    },
  );

  test("move to a state the queue does not have gets UNKNOWN_STATE", async () => {
    const t = await ready();
    const ticketId = await openProj(t, "work");
    await expectCode(
      t.run((ctx) =>
        ctx.runMutation(mutations.move, { ticketId, actor: LEAD, to: "ghost" }),
      ),
      "UNKNOWN_STATE",
    );
  });

  test("moving a held ticket needs its holder: another party gets NOT_HOLDER", async () => {
    const t = await ready();
    const ticketId = await openProj(t, "work");
    const { claimSeq } = await claimOk(t, ticketId, A);
    await expectCode(
      t.run((ctx) =>
        lab.move(ctx, { ticketId, actor: B, claimSeq, to: "in_review" }),
      ),
      "NOT_HOLDER",
    );
  });

  test("moving a held ticket with an old claimSeq gets CLAIM_LOST", async () => {
    const t = await ready();
    const ticketId = await openProj(t, "work");
    const { claimSeq } = await claimOk(t, ticketId, A);
    await expectCode(
      t.run((ctx) =>
        lab.move(ctx, {
          ticketId,
          actor: A,
          claimSeq: claimSeq - 1,
          to: "in_review",
        }),
      ),
      "CLAIM_LOST",
    );
  });

  test("moving a held ticket without a claimSeq and without trusted gets INVALID_ARGUMENT", async () => {
    const t = await ready();
    const ticketId = await openProj(t, "work");
    await claimOk(t, ticketId, A);
    await expectCode(
      t.run((ctx) => lab.move(ctx, { ticketId, actor: A, to: "in_review" })),
      "INVALID_ARGUMENT",
    );
  });

  test("a trusted host call moves a held ticket without the claim", async () => {
    const t = await ready();
    const ticketId = await openProj(t, "work");
    const { claimSeq } = await claimOk(t, ticketId, A);
    const result = await t.run((ctx) =>
      lab.move(ctx, { ticketId, actor: LEAD, trusted: true, to: "in_review" }),
    );
    expect(result).toMatchObject({ state: "in_review", claimSeq });
    expect((await ticketOf(t, ticketId)).assigneeRef).toBe(A.ref);
  });

  test("moving to the state a ticket is already in is a no-op that writes no transition", async () => {
    const t = await ready();
    const parked = await openProj(t, "idea", { to: "backlog" });
    const held = await openProj(t, "work");
    const { claimSeq } = await claimOk(t, held, A);
    const parkedBefore = await ticketOf(t, parked);
    expect(
      await t.run((ctx) =>
        lab.move(ctx, { ticketId: parked, actor: LEAD, to: "backlog" }),
      ),
    ).toMatchObject({
      state: "backlog",
      category: "backlog",
    });
    expect(
      await t.run((ctx) =>
        lab.move(ctx, {
          ticketId: held,
          actor: A,
          claimSeq,
          to: "in_progress",
        }),
      ),
    ).toMatchObject({
      state: "in_progress",
      claimSeq,
    });
    expect(await ticketOf(t, parked)).toEqual(parkedBefore);
    expect(await transitionsOf(t, parked)).toHaveLength(1);
    expect(await transitionsOf(t, held)).toHaveLength(2);
  });

  test("a same-state move by a party that is not the holder still gets NOT_HOLDER", async () => {
    const t = await ready();
    const ticketId = await openProj(t, "work");
    const { claimSeq } = await claimOk(t, ticketId, A);
    await expectCode(
      t.run((ctx) =>
        lab.move(ctx, { ticketId, actor: B, claimSeq, to: "in_progress" }),
      ),
      "NOT_HOLDER",
    );
  });

  test("a move on a ticket that the instant queue sealed on resolve gets SEALED", async () => {
    const t = await ready();
    const ticketId = await t.run((ctx) =>
      lab.open(ctx, { queue: "instant", actor: REQ, title: "done at once" }),
    );
    const { claimSeq } = await claimOk(t, ticketId, A);
    await t.run((ctx) =>
      lab.resolve(ctx, {
        ticketId,
        actor: A,
        claimSeq,
        resolution: "completed",
      }),
    );
    expect((await ticketOf(t, ticketId)).closedAt).toBeDefined();
    await expectCode(
      t.run((ctx) =>
        lab.move(ctx, { ticketId, actor: LEAD, trusted: true, to: "resolved" }),
      ),
      "SEALED",
    );
  });

  test("a move on a ticket that the host closed gets SEALED", async () => {
    const t = await ready();
    const ticketId = await openProj(t, "work");
    const { claimSeq } = await claimOk(t, ticketId, A);
    await t.run((ctx) =>
      lab.resolve(ctx, {
        ticketId,
        actor: A,
        claimSeq,
        resolution: "completed",
      }),
    );
    await t.run((ctx) => lab.close(ctx, { ticketId, actor: LEAD }));
    await expectCode(
      t.run((ctx) =>
        lab.move(ctx, { ticketId, actor: LEAD, trusted: true, to: "done" }),
      ),
      "SEALED",
    );
  });

  test("a move with a queue that is not the ticket's queue gets WRONG_QUEUE", async () => {
    const t = await ready();
    const ticketId = await openProj(t, "work");
    await expectCode(
      t.run((ctx) =>
        lab.move(ctx, { ticketId, actor: LEAD, queue: "people", to: "open" }),
      ),
      "WRONG_QUEUE",
    );
  });

  test("a move with the ticket's own queue succeeds", async () => {
    const t = await ready();
    const ticketId = await openProj(t, "idea", { to: "backlog" });
    const result = await t.run((ctx) =>
      lab.move(ctx, { ticketId, actor: LEAD, queue: "proj", to: "todo" }),
    );
    expect(result.state).toBe("todo");
  });

  describe("inside the waiting category", () => {
    async function pendingOnRequester(t: T) {
      const ticketId = await t.run((ctx) =>
        lab.open(ctx, { queue: "humans", actor: REQ, title: "help" }),
      );
      const { claimSeq } = await claimOk(t, ticketId, HUMAN_PARTY);
      await t.run((ctx) =>
        lab.requestInput(ctx, {
          ticketId,
          actor: HUMAN_PARTY,
          claimSeq,
          body: "which order?",
        }),
      );
      return { ticketId, claimSeq };
    }
    const HUMAN_PARTY: Party = { ref: "user:h", kind: "human" };

    test("a desk ticket waiting on the requester cannot move to the on hold state, which waits on something external", async () => {
      const t = await ready();
      const { ticketId, claimSeq } = await pendingOnRequester(t);
      expect(await ticketOf(t, ticketId)).toMatchObject({
        state: "pending",
        waitingOn: "requester",
      });
      await expectCode(
        t.run((ctx) =>
          lab.move(ctx, {
            ticketId,
            actor: HUMAN_PARTY,
            claimSeq,
            to: "on_hold",
          }),
        ),
        "INVALID_TARGET",
      );
      expect((await ticketOf(t, ticketId)).state).toBe("pending");
    });

    test("a desk ticket waiting on something external cannot move to the pending state, which waits on the requester", async () => {
      const t = await ready();
      const ticketId = await t.run((ctx) =>
        lab.open(ctx, { queue: "humans", actor: REQ, title: "help" }),
      );
      const { claimSeq } = await claimOk(t, ticketId, HUMAN_PARTY);
      await t.run((ctx) =>
        lab.hold(ctx, { ticketId, actor: HUMAN_PARTY, claimSeq }),
      );
      expect(await ticketOf(t, ticketId)).toMatchObject({
        state: "on_hold",
        waitingOn: "external",
      });
      await expectCode(
        t.run((ctx) =>
          lab.move(ctx, {
            ticketId,
            actor: HUMAN_PARTY,
            claimSeq,
            to: "pending",
          }),
        ),
        "INVALID_TARGET",
      );
    });

    test("a waiting ticket moves to a waiting state that fits what it waits on and the holder is still required", async () => {
      const waiting = mount({
        w: defineQueue({
          states: {
            new: { category: "unstarted" },
            doing: { category: "started" },
            ask_a: { category: "waiting", on: "requester" },
            ask_b: { category: "waiting", on: "requester" },
            wait_x: { category: "waiting", on: "external" },
            wait_free: { category: "waiting" },
            done: { category: "done" },
            gone: { category: "canceled" },
          },
          policy: { leaseMs: null },
        }),
      });
      const t = await readyWith(waiting);
      const ticketId = await t.run((ctx) =>
        waiting.open(ctx, { queue: "w", actor: REQ, title: "q" }),
      );
      const { claimSeq } = await claimOk(t, ticketId, A);
      await t.run((ctx) =>
        lab.requestInput(ctx, { ticketId, actor: A, claimSeq, body: "which?" }),
      );
      expect((await ticketOf(t, ticketId)).state).toBe("ask_a");
      const moveTo = (actor: Party, to: string, seq = claimSeq) =>
        t.run((ctx) =>
          ctx.runMutation(mutations.move, {
            ticketId,
            actor,
            claimSeq: seq,
            to,
          }),
        );
      await expectCode(moveTo(A, "wait_x"), "INVALID_TARGET");
      await expectCode(moveTo(B, "ask_b"), "NOT_HOLDER");
      await expectCode(moveTo(A, "ask_b", claimSeq - 1), "CLAIM_LOST");
      expect(await moveTo(A, "ask_b")).toMatchObject({
        state: "ask_b",
        category: "waiting",
      });
      expect(await moveTo(A, "wait_free")).toMatchObject({
        state: "wait_free",
        category: "waiting",
      });
      expect((await ticketOf(t, ticketId)).waitingOn).toBe("requester");
    });
  });
});

describe("claim", () => {
  test("of two claims on one ticket the first wins and the second gets TAKEN", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    const first = await t.run((ctx) => lab.claim(ctx, { ticketId, actor: A }));
    const second = await t.run((ctx) => lab.claim(ctx, { ticketId, actor: B }));
    expect(first).toMatchObject({
      ok: true,
      ticketId,
      claimSeq: 1,
      state: "working",
    });
    expect(second).toEqual({ ok: false, reason: "TAKEN", ticketId });
    expect(await ticketOf(t, ticketId)).toMatchObject({
      assigneeRef: A.ref,
      claimSeq: 1,
      category: "started",
    });
  });

  test("a ticket waiting on its requester is still held, so another claim gets TAKEN", async () => {
    const t = await ready();
    const ticketId = await t.run((ctx) =>
      lab.open(ctx, { queue: "humans", actor: REQ, title: "help" }),
    );
    const { claimSeq } = await claimOk(t, ticketId, A);
    await t.run((ctx) =>
      lab.requestInput(ctx, {
        ticketId,
        actor: A,
        claimSeq,
        body: "which order?",
      }),
    );
    expect(
      await t.run((ctx) => lab.claim(ctx, { ticketId, actor: B })),
    ).toEqual({ ok: false, reason: "TAKEN", ticketId });
  });

  test("claiming a ticket with an open blocker gets BLOCKED, and it is claimable once the blocker completes", async () => {
    const t = await ready();
    const blocker = await openPeople(t, "first");
    const blocked = await t.run((ctx) =>
      lab.open(ctx, {
        queue: "people",
        actor: REQ,
        title: "second",
        blockedBy: [blocker],
      }),
    );
    expect(
      await t.run((ctx) => lab.claim(ctx, { ticketId: blocked, actor: B })),
    ).toEqual({
      ok: false,
      reason: "BLOCKED",
      ticketId: blocked,
    });
    const { claimSeq } = await claimOk(t, blocker, A);
    await t.run((ctx) =>
      lab.resolve(ctx, {
        ticketId: blocker,
        actor: A,
        claimSeq,
        resolution: "completed",
      }),
    );
    expect(
      await t.run((ctx) => lab.claim(ctx, { ticketId: blocked, actor: B })),
    ).toMatchObject({ ok: true, ticketId: blocked });
  });

  test("claim next skips a blocked ticket and returns the unblocked one", async () => {
    const t = await ready();
    const blocker = await openPeople(t, "blocker", REQ, 4);
    vi.advanceTimersByTime(1000);
    await t.run((ctx) =>
      lab.open(ctx, {
        queue: "people",
        actor: REQ,
        title: "blocked",
        priority: 0,
        blockedBy: [blocker],
      }),
    );
    const next = await t.run((ctx) =>
      lab.claim(ctx, { queue: "people", actor: B }),
    );
    expect(next).toMatchObject({ ok: true, ticketId: blocker });
  });

  test("claiming a ticket reserved for another party gets RESERVED, and the reserved party can claim it", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    await t.run((ctx) =>
      lab.assign(ctx, { ticketId, actor: LEAD, assignee: B }),
    );
    expect(
      await t.run((ctx) => lab.claim(ctx, { ticketId, actor: A })),
    ).toEqual({ ok: false, reason: "RESERVED", ticketId });
    expect(
      await t.run((ctx) => lab.claim(ctx, { ticketId, actor: B })),
    ).toMatchObject({ ok: true, ticketId });
  });

  test("claim next in an empty queue gets EMPTY", async () => {
    const t = await ready();
    expect(
      await t.run((ctx) => lab.claim(ctx, { queue: "people", actor: A })),
    ).toEqual({ ok: false, reason: "EMPTY" });
  });

  test("claim next gets EMPTY when the queue only holds backlog, blocked and other parties' reserved tickets", async () => {
    const t = await ready();
    await openProj(t, "parked", { to: "backlog" });
    const blocker = await openProj(t, "blocker", { to: "backlog" });
    await t.run((ctx) =>
      lab.open(ctx, {
        queue: "proj",
        actor: REQ,
        title: "blocked",
        blockedBy: [blocker],
      }),
    );
    const reserved = await openProj(t, "reserved");
    await t.run((ctx) =>
      lab.assign(ctx, { ticketId: reserved, actor: LEAD, assignee: B }),
    );
    expect(
      await t.run((ctx) => lab.claim(ctx, { queue: "proj", actor: A })),
    ).toEqual({ ok: false, reason: "EMPTY" });
  });

  test("claim next never returns a backlog ticket until someone accepts it", async () => {
    const t = await ready();
    const ticketId = await openProj(t, "idea", { to: "backlog" });
    expect(
      await t.run((ctx) => lab.claim(ctx, { queue: "proj", actor: A })),
    ).toEqual({ ok: false, reason: "EMPTY" });
    await t.run((ctx) => lab.move(ctx, { ticketId, actor: LEAD, to: "todo" }));
    expect(
      await t.run((ctx) => lab.claim(ctx, { queue: "proj", actor: A })),
    ).toMatchObject({
      ok: true,
      ticketId,
      state: "in_progress",
    });
  });

  test("claiming a backlog ticket by id gets NOT_CLAIMABLE", async () => {
    const t = await ready();
    const ticketId = await openProj(t, "idea", { to: "backlog" });
    expect(
      await t.run((ctx) => lab.claim(ctx, { ticketId, actor: A })),
    ).toEqual({ ok: false, reason: "NOT_CLAIMABLE", ticketId });
  });

  test("claiming a done or a canceled ticket gets NOT_CLAIMABLE", async () => {
    const t = await ready();
    const finished = await openPeople(t, "finished");
    const { claimSeq } = await claimOk(t, finished, A);
    await t.run((ctx) =>
      lab.resolve(ctx, {
        ticketId: finished,
        actor: A,
        claimSeq,
        resolution: "completed",
      }),
    );
    const called = await openPeople(t, "called off");
    await t.run((ctx) => lab.cancel(ctx, { ticketId: called, actor: REQ }));
    expect(
      await t.run((ctx) => lab.claim(ctx, { ticketId: finished, actor: B })),
    ).toEqual({
      ok: false,
      reason: "NOT_CLAIMABLE",
      ticketId: finished,
    });
    expect(
      await t.run((ctx) => lab.claim(ctx, { ticketId: called, actor: B })),
    ).toEqual({
      ok: false,
      reason: "NOT_CLAIMABLE",
      ticketId: called,
    });
  });

  test("a claim by the holder again returns its current claimSeq and lease and writes no transition", async () => {
    const t = await ready();
    const ticketId = await openAgent(t);
    const first = await claimOk(t, ticketId, A);
    vi.advanceTimersByTime(MINUTE);
    const again = await claimOk(t, ticketId, A);
    expect(again.claimSeq).toBe(first.claimSeq);
    expect(again.leaseExpiresAt).toBe(first.leaseExpiresAt);
    expect(await transitionsOf(t, ticketId)).toHaveLength(2);
  });

  test("claim needs a ticketId or a queue and gets INVALID_ARGUMENT without either", async () => {
    const t = await ready();
    await expectCode(
      t.run((ctx) => lab.claim(ctx, { actor: A })),
      "INVALID_ARGUMENT",
    );
  });

  test("claim next in a queue that does not exist gets UNKNOWN_QUEUE", async () => {
    const t = await ready();
    await expectCode(
      t.run((ctx) =>
        ctx.runMutation(mutations.claim, { actor: A, queue: "ghost" }),
      ),
      "UNKNOWN_QUEUE",
    );
  });

  test("claim with a queue that is not the ticket's queue gets WRONG_QUEUE", async () => {
    const t = await ready();
    const ticketId = await openProj(t, "work");
    await expectCode(
      t.run((ctx) => lab.claim(ctx, { ticketId, actor: A, queue: "people" })),
      "WRONG_QUEUE",
    );
  });

  test("claim next returns the caller's reserved tickets first, never another party's, then unassigned ones by priority and age", async () => {
    const t = await ready();
    const tick = () => vi.advanceTimersByTime(1000);
    const u1 = await openPeople(t, "u1", REQ, 2);
    tick();
    const u2 = await openPeople(t, "u2", REQ, 0);
    tick();
    const u3 = await openPeople(t, "u3", REQ, 2);
    tick();
    const reservedForA = await openPeople(t, "rA", REQ, 4);
    tick();
    const urgentForA = await openPeople(t, "rA-urgent", REQ, 1);
    tick();
    const reservedForB = await openPeople(t, "rB", REQ, 0);
    await t.run((ctx) =>
      lab.assign(ctx, { ticketId: reservedForA, actor: LEAD, assignee: A }),
    );
    await t.run((ctx) =>
      lab.assign(ctx, { ticketId: urgentForA, actor: LEAD, assignee: A }),
    );
    await t.run((ctx) =>
      lab.assign(ctx, { ticketId: reservedForB, actor: LEAD, assignee: B }),
    );

    const order: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const next = await t.run((ctx) =>
        lab.claim(ctx, { queue: "people", actor: A }),
      );
      if (!next.ok) throw new Error(`claim next lost with ${next.reason}`);
      order.push(next.ticketId);
    }
    expect(order).toEqual([urgentForA, reservedForA, u2, u1, u3]);
    expect(
      await t.run((ctx) => lab.claim(ctx, { queue: "people", actor: A })),
    ).toEqual({ ok: false, reason: "EMPTY" });
    expect(
      await t.run((ctx) => lab.claim(ctx, { queue: "people", actor: B })),
    ).toMatchObject({
      ok: true,
      ticketId: reservedForB,
    });
  });

  test("claim to lands a claim on the named started state, by id and by claim next", async () => {
    const t = await ready();
    const byId = await openProj(t, "by id");
    const next = await openProj(t, "next");
    const direct = await t.run((ctx) =>
      lab.claim(ctx, { ticketId: byId, actor: A, to: "in_review" }),
    );
    expect(direct).toMatchObject({ ok: true, state: "in_review" });
    const viaNext = await t.run((ctx) =>
      lab.claim(ctx, { queue: "proj", actor: A, to: "in_review" }),
    );
    expect(viaNext).toMatchObject({
      ok: true,
      ticketId: next,
      state: "in_review",
    });
    expect(await ticketOf(t, byId)).toMatchObject({
      state: "in_review",
      category: "started",
    });
  });

  test("a claim without to lands on the first started state", async () => {
    const t = await ready();
    const ticketId = await openProj(t, "work");
    expect(
      await t.run((ctx) => lab.claim(ctx, { ticketId, actor: A })),
    ).toMatchObject({ ok: true, state: "in_progress" });
  });

  test("claim to a state that is not started gets INVALID_TARGET and leaves the ticket unstarted", async () => {
    const t = await ready();
    const ticketId = await openProj(t, "work");
    await expectCode(
      t.run((ctx) => lab.claim(ctx, { ticketId, actor: A, to: "done" })),
      "INVALID_TARGET",
    );
    await expectCode(
      t.run((ctx) => lab.claim(ctx, { ticketId, actor: A, to: "todo" })),
      "INVALID_TARGET",
    );
    expect(await ticketOf(t, ticketId)).toMatchObject({
      category: "unstarted",
      claimSeq: 0,
    });
  });

  test("claim to a state the queue does not have gets UNKNOWN_STATE", async () => {
    const t = await ready();
    const ticketId = await openProj(t, "work");
    await expectCode(
      t.run((ctx) =>
        ctx.runMutation(mutations.claim, { ticketId, actor: A, to: "ghost" }),
      ),
      "UNKNOWN_STATE",
    );
  });
});

describe("lease on (agent queue)", () => {
  test("claim starts a lease of the queue's leaseMs", async () => {
    const t = await ready();
    const ticketId = await openAgent(t);
    const start = Date.now();
    const claim = await claimOk(t, ticketId, A);
    expect(claim).toMatchObject({ ticketId, claimSeq: 1, state: "working" });
    expectNear(claim.leaseExpiresAt, start + 5 * MINUTE);
  });

  test("renew extends the lease by leaseMs from now", async () => {
    const t = await ready();
    const ticketId = await openAgent(t);
    const { claimSeq } = await claimOk(t, ticketId, A);
    await drain(t, 4 * MINUTE);
    const start = Date.now();
    const renewed = await t.run((ctx) =>
      lab.renew(ctx, { ticketId, actor: A, claimSeq }),
    );
    expectNear(renewed.expiresAt ?? undefined, start + 5 * MINUTE);
    const detail = await t.run((ctx) => lab.get(ctx, { ticketId }));
    expect(detail?.leaseExpiresAt).toBe(renewed.expiresAt);
  });

  test("a renew by a party that is not the holder gets NOT_HOLDER", async () => {
    const t = await ready();
    const ticketId = await openAgent(t);
    const { claimSeq } = await claimOk(t, ticketId, A);
    await expectCode(
      t.run((ctx) => lab.renew(ctx, { ticketId, actor: B, claimSeq })),
      "NOT_HOLDER",
    );
  });

  test("after 5 minutes without a renew the ticket returns to the queue as lease_expired", async () => {
    const t = await ready();
    const ticketId = await openAgent(t);
    const { claimSeq } = await claimOk(t, ticketId, A);
    await drain(t, 5 * MINUTE + 1000);
    const back = await ticketOf(t, ticketId);
    expect(back).toMatchObject({
      queue: "agent",
      state: "open",
      category: "unstarted",
      claimSeq: claimSeq + 1,
      leaseExpiryCount: 1,
    });
    expect(back.assigneeRef).toBeUndefined();
    const detail = await t.run((ctx) => lab.get(ctx, { ticketId }));
    expect(detail?.leaseExpiresAt).toBeUndefined();
    const history = await transitionsOf(t, ticketId);
    expect(history.map((h) => h.type)).toEqual([
      "opened",
      "claimed",
      "lease_expired",
    ]);
    expect(history[2]).toMatchObject({
      actorRef: SYSTEM_REF,
      actorKind: "system",
      fromCategory: "started",
      toCategory: "unstarted",
      fromAssigneeRef: A.ref,
    });
    const sent = (await events(t)).filter((e) => e.ticketId === ticketId);
    expect(sent.map((e) => e.type)).toEqual([
      "opened",
      "claimed",
      "lease_expired",
    ]);
    expect(sent[2]).toMatchObject({
      category: "unstarted",
      actorRef: SYSTEM_REF,
    });
  });

  test("another party can claim the returned ticket with a fresh claimSeq and lease", async () => {
    const t = await ready();
    const ticketId = await openAgent(t);
    await claimOk(t, ticketId, A);
    await drain(t, 5 * MINUTE + 1000);
    const again = await claimOk(t, ticketId, B);
    expect(again.claimSeq).toBe(3);
    expect(again.leaseExpiresAt).toBeGreaterThan(Date.now());
    expect(await ticketOf(t, ticketId)).toMatchObject({
      assigneeRef: B.ref,
      category: "started",
    });
  });

  test("a renewed lease does not expire at the first timer and expires 5 minutes after the last renew", async () => {
    const t = await ready();
    const ticketId = await openAgent(t);
    const { claimSeq } = await claimOk(t, ticketId, A);
    await drain(t, 4 * MINUTE);
    await t.run((ctx) => lab.renew(ctx, { ticketId, actor: A, claimSeq }));

    await drain(t, MINUTE + 1000);
    expect(await ticketOf(t, ticketId)).toMatchObject({
      category: "started",
      assigneeRef: A.ref,
      leaseExpiryCount: 0,
    });
    await drain(t, 3 * MINUTE);
    expect(await ticketOf(t, ticketId)).toMatchObject({
      category: "started",
      assigneeRef: A.ref,
      leaseExpiryCount: 0,
    });
    await drain(t, 2 * MINUTE);
    expect(await ticketOf(t, ticketId)).toMatchObject({
      category: "unstarted",
      leaseExpiryCount: 1,
    });
  });

  test.each(FENCED_WRITES)(
    "a late $verb with the old claimSeq gets CLAIM_LOST after the lease expired and the ticket returned to the queue",
    async ({ write }) => {
      const t = await ready();
      const ticketId = await openAgent(t);
      const { claimSeq } = await claimOk(t, ticketId, A);
      await drain(t, 5 * MINUTE + 1000);
      expect((await ticketOf(t, ticketId)).category).toBe("unstarted");
      await expectCode(
        write(t, { ticketId, actor: A, claimSeq }),
        "CLAIM_LOST",
      );
    },
  );

  test.each(HOLDER_WRITES)(
    "a $verb with the old claimSeq gets CLAIM_LOST after another party claimed the returned ticket",
    async ({ write }) => {
      const t = await ready();
      const ticketId = await openAgent(t);
      const { claimSeq } = await claimOk(t, ticketId, A);
      await drain(t, 5 * MINUTE + 1000);
      await claimOk(t, ticketId, B);
      await expectCode(
        write(t, { ticketId, actor: A, claimSeq }),
        "CLAIM_LOST",
      );
    },
  );

  test("the new holder keeps writing after the old holder was refused", async () => {
    const t = await ready();
    const ticketId = await openAgent(t);
    const { claimSeq: stale } = await claimOk(t, ticketId, A);
    await drain(t, 5 * MINUTE + 1000);
    const fresh = await claimOk(t, ticketId, B);
    await expectCode(
      t.run((ctx) => lab.renew(ctx, { ticketId, actor: A, claimSeq: stale })),
      "CLAIM_LOST",
    );
    const renewed = await t.run((ctx) =>
      lab.renew(ctx, { ticketId, actor: B, claimSeq: fresh.claimSeq }),
    );
    expect(renewed.expiresAt).toBeGreaterThan(Date.now());
  });

  test.each(HOLDER_WRITES)(
    "a $verb with the current claimSeq gets CLAIM_LOST while the lease is past expiry and the timer has not run",
    async ({ write }) => {
      const t = await ready();
      const ticketId = await openAgent(t);
      const { claimSeq } = await claimOk(t, ticketId, A);
      jump(5 * MINUTE + 1000);
      await expectCode(
        write(t, { ticketId, actor: A, claimSeq }),
        "CLAIM_LOST",
      );
      expect(await ticketOf(t, ticketId)).toMatchObject({
        category: "started",
        assigneeRef: A.ref,
        claimSeq,
      });
    },
  );

  test("the expiry timer still returns the ticket after the clock jumped past the lease", async () => {
    const t = await ready();
    const ticketId = await openAgent(t);
    await claimOk(t, ticketId, A);
    jump(5 * MINUTE + 1000);
    await drain(t, 5 * MINUTE + 1000);
    expect(await ticketOf(t, ticketId)).toMatchObject({
      category: "unstarted",
      leaseExpiryCount: 1,
    });
  });

  test("the third lease expiry escalates the ticket to the humans queue instead of returning it", async () => {
    const t = await ready();
    const ticketId = await openAgent(t);
    for (const actor of [A, B]) {
      await claimOk(t, ticketId, actor);
      await drain(t, 5 * MINUTE + 1000);
      expect(await ticketOf(t, ticketId)).toMatchObject({
        queue: "agent",
        category: "unstarted",
      });
    }
    expect((await ticketOf(t, ticketId)).leaseExpiryCount).toBe(2);

    const { claimSeq } = await claimOk(t, ticketId, C);
    await drain(t, 5 * MINUTE + 1000);
    const escalated = await ticketOf(t, ticketId);
    expect(escalated).toMatchObject({
      queue: "humans",
      state: "new",
      category: "unstarted",
      leaseExpiryCount: 3,
      priority: 1,
      claimSeq: claimSeq + 1,
    });
    expect(escalated.assigneeRef).toBeUndefined();
    expect(escalated.escalatedAt).toBeDefined();
    const history = await transitionsOf(t, ticketId);
    expect(history.at(-1)).toMatchObject({
      type: "escalated",
      actorRef: SYSTEM_REF,
      fromQueue: "agent",
      toQueue: "humans",
      reason: expect.stringContaining("lease expired"),
    });
    expect(history.filter((h) => h.type === "lease_expired")).toHaveLength(2);
    await expectCode(
      t.run((ctx) => lab.renew(ctx, { ticketId, actor: C, claimSeq })),
      "CLAIM_LOST",
    );
  });

  test("an escalated ticket is claimed in the desk queue without a lease", async () => {
    const t = await ready();
    const ticketId = await openAgent(t);
    for (const actor of [A, B, C]) {
      await claimOk(t, ticketId, actor);
      await drain(t, 5 * MINUTE + 1000);
    }
    const claim = await claimOk(t, ticketId, LEAD);
    expect(claim.state).toBe("open");
    expect(claim.leaseExpiresAt).toBeUndefined();
    await drain(t, 30 * DAY);
    expect(await ticketOf(t, ticketId)).toMatchObject({
      queue: "humans",
      category: "started",
      assigneeRef: LEAD.ref,
    });
  });

  test("without an escalateTo a ticket keeps returning to its queue after maxReturns expiries", async () => {
    const solo = mount({
      solo: defineQueue({ policy: { leaseMs: MINUTE, maxReturns: 1 } }),
    });
    const t = await readyWith(solo);
    const ticketId = await t.run((ctx) =>
      solo.open(ctx, { queue: "solo", actor: REQ, title: "x" }),
    );
    for (const expected of [1, 2]) {
      await claimOk(t, ticketId, A);
      await drain(t, MINUTE + 1000);
      expect(await ticketOf(t, ticketId)).toMatchObject({
        queue: "solo",
        category: "unstarted",
        leaseExpiryCount: expected,
      });
    }
  });

  test("an expiry timer set for an earlier claim does nothing after the ticket changed hands", async () => {
    const t = await ready();
    const ticketId = await openAgent(t);
    const first = await claimOk(t, ticketId, A);
    await drain(t, MINUTE);
    await t.run((ctx) =>
      lab.release(ctx, { ticketId, actor: A, claimSeq: first.claimSeq }),
    );
    const second = await claimOk(t, ticketId, B);
    expect(second.claimSeq).toBe(3);

    await drain(t, 4 * MINUTE + 1000);
    expect(await ticketOf(t, ticketId)).toMatchObject({
      category: "started",
      assigneeRef: B.ref,
      leaseExpiryCount: 0,
      claimSeq: 3,
    });
    await drain(t, 2 * MINUTE);
    expect(await ticketOf(t, ticketId)).toMatchObject({
      category: "unstarted",
      leaseExpiryCount: 1,
    });
  });

  test("release stops the lease: no lease is reported and nothing expires later", async () => {
    const t = await ready();
    const ticketId = await openAgent(t);
    const { claimSeq } = await claimOk(t, ticketId, A);
    await t.run((ctx) => lab.release(ctx, { ticketId, actor: A, claimSeq }));
    expect(
      (await t.run((ctx) => lab.get(ctx, { ticketId })))?.leaseExpiresAt,
    ).toBeUndefined();
    await drain(t, 10 * MINUTE);
    expect(await ticketOf(t, ticketId)).toMatchObject({
      category: "unstarted",
      leaseExpiryCount: 0,
    });
  });

  test("assign on a started ticket replaces the holder and restarts the lease", async () => {
    const t = await ready();
    const ticketId = await openAgent(t);
    const first = await claimOk(t, ticketId, A);
    await drain(t, 4 * MINUTE);
    const start = Date.now();
    const result = await t.run((ctx) =>
      lab.assign(ctx, { ticketId, actor: LEAD, assignee: B }),
    );
    expect(result).toMatchObject({
      category: "started",
      claimSeq: first.claimSeq + 1,
    });
    expect(await ticketOf(t, ticketId)).toMatchObject({
      assigneeRef: B.ref,
      claimSeq: first.claimSeq + 1,
    });
    const detail = await t.run((ctx) => lab.get(ctx, { ticketId }));
    expectNear(detail?.leaseExpiresAt, start + 5 * MINUTE);

    await drain(t, 2 * MINUTE);
    expect(await ticketOf(t, ticketId)).toMatchObject({
      category: "started",
      assigneeRef: B.ref,
      leaseExpiryCount: 0,
    });
    await expectCode(
      t.run((ctx) =>
        lab.renew(ctx, { ticketId, actor: A, claimSeq: first.claimSeq }),
      ),
      "CLAIM_LOST",
    );
    await drain(t, 4 * MINUTE);
    expect(await ticketOf(t, ticketId)).toMatchObject({
      category: "unstarted",
      leaseExpiryCount: 1,
    });
  });
});

describe("lease off (people queue), assign and release", () => {
  test("a claim in a queue without a lease reports no lease and renew returns expiresAt null", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    const claim = await claimOk(t, ticketId, A);
    expect(claim.leaseExpiresAt).toBeUndefined();
    expect(
      await t.run((ctx) =>
        lab.renew(ctx, { ticketId, actor: A, claimSeq: claim.claimSeq }),
      ),
    ).toEqual({ expiresAt: null });
    expect(
      (await t.run((ctx) => lab.get(ctx, { ticketId })))?.leaseExpiresAt,
    ).toBeUndefined();
  });

  test("the fence stays on without a lease: renew with an old claimSeq gets CLAIM_LOST and by a stranger NOT_HOLDER", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    const { claimSeq } = await claimOk(t, ticketId, A);
    await expectCode(
      t.run((ctx) =>
        lab.renew(ctx, { ticketId, actor: A, claimSeq: claimSeq - 1 }),
      ),
      "CLAIM_LOST",
    );
    await expectCode(
      t.run((ctx) => lab.renew(ctx, { ticketId, actor: B, claimSeq })),
      "NOT_HOLDER",
    );
  });

  test("30 days pass and the holder still holds and can still resolve", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    const { claimSeq } = await claimOk(t, ticketId, A);
    await drain(t, 30 * DAY);
    expect(await ticketOf(t, ticketId)).toMatchObject({
      category: "started",
      assigneeRef: A.ref,
      claimSeq,
      leaseExpiryCount: 0,
    });
    const history = await transitionsOf(t, ticketId);
    expect(history.map((h) => h.type)).toEqual(["opened", "claimed"]);
    const done = await t.run((ctx) =>
      lab.resolve(ctx, {
        ticketId,
        actor: A,
        claimSeq,
        resolution: "completed",
      }),
    );
    expect(done).toMatchObject({ category: "done" });
  });

  test.each(HOLDER_WRITES)(
    "after assign to another party the old holder's $verb gets CLAIM_LOST",
    async ({ write }) => {
      const t = await ready();
      const ticketId = await openPeople(t);
      const { claimSeq } = await claimOk(t, ticketId, A);
      const assigned = await t.run((ctx) =>
        lab.assign(ctx, { ticketId, actor: LEAD, assignee: B }),
      );
      expect(assigned).toMatchObject({
        category: "started",
        claimSeq: claimSeq + 1,
      });
      await expectCode(
        write(t, { ticketId, actor: A, claimSeq }),
        "CLAIM_LOST",
      );
      expect(await ticketOf(t, ticketId)).toMatchObject({
        assigneeRef: B.ref,
        category: "started",
      });
    },
  );

  test("after assign the new holder writes with the new claimSeq", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    await claimOk(t, ticketId, A);
    const assigned = await t.run((ctx) =>
      lab.assign(ctx, { ticketId, actor: LEAD, assignee: B }),
    );
    const done = await t.run((ctx) =>
      lab.resolve(ctx, {
        ticketId,
        actor: B,
        claimSeq: assigned.claimSeq,
        resolution: "completed",
      }),
    );
    expect(done.category).toBe("done");
  });

  test("assign on an unstarted ticket is a reservation: the state stays, claimSeq rises and only the assignee can claim", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    const reserved = await t.run((ctx) =>
      lab.assign(ctx, { ticketId, actor: LEAD, assignee: B }),
    );
    expect(reserved).toEqual({
      queue: "people",
      state: "open",
      category: "unstarted",
      claimSeq: 1,
    });
    expect(await ticketOf(t, ticketId)).toMatchObject({
      assigneeRef: B.ref,
      assigneeKind: "agent",
      category: "unstarted",
    });
    expect(
      await t.run((ctx) => lab.claim(ctx, { ticketId, actor: A })),
    ).toEqual({ ok: false, reason: "RESERVED", ticketId });
    const claim = await claimOk(t, ticketId, B);
    expect(claim.claimSeq).toBeGreaterThan(reserved.claimSeq);
    expect(await ticketOf(t, ticketId)).toMatchObject({
      assigneeRef: B.ref,
      category: "started",
      claimSeq: claim.claimSeq,
    });
    const history = await transitionsOf(t, ticketId);
    expect(history[1]).toMatchObject({
      type: "assigned",
      actorRef: LEAD.ref,
      toAssigneeRef: B.ref,
    });
  });

  test("assign raises claimSeq each time the assignee changes, including when the reservation is cleared", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    const toB = await t.run((ctx) =>
      lab.assign(ctx, { ticketId, actor: LEAD, assignee: B }),
    );
    const toC = await t.run((ctx) =>
      lab.assign(ctx, { ticketId, actor: LEAD, assignee: C }),
    );
    const cleared = await t.run((ctx) =>
      lab.assign(ctx, { ticketId, actor: LEAD, assignee: null }),
    );
    expect([toB.claimSeq, toC.claimSeq, cleared.claimSeq]).toEqual([1, 2, 3]);
    expect((await ticketOf(t, ticketId)).assigneeRef).toBeUndefined();
    expect(
      await t.run((ctx) => lab.claim(ctx, { ticketId, actor: A })),
    ).toMatchObject({ ok: true });
  });

  test("assign null on a started ticket gets HOLDER_REQUIRED", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    await claimOk(t, ticketId, A);
    await expectCode(
      t.run((ctx) =>
        lab.assign(ctx, { ticketId, actor: LEAD, assignee: null }),
      ),
      "HOLDER_REQUIRED",
    );
    expect((await ticketOf(t, ticketId)).assigneeRef).toBe(A.ref);
  });

  test("assign null on a waiting ticket gets HOLDER_REQUIRED", async () => {
    const t = await ready();
    const ticketId = await t.run((ctx) =>
      lab.open(ctx, { queue: "humans", actor: REQ, title: "help" }),
    );
    const { claimSeq } = await claimOk(t, ticketId, A);
    await t.run((ctx) => lab.hold(ctx, { ticketId, actor: A, claimSeq }));
    await expectCode(
      t.run((ctx) =>
        lab.assign(ctx, { ticketId, actor: LEAD, assignee: null }),
      ),
      "HOLDER_REQUIRED",
    );
  });

  test("assign to the party that already holds the ticket is a no-op", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    const { claimSeq } = await claimOk(t, ticketId, A);
    const before = await ticketOf(t, ticketId);
    const result = await t.run((ctx) =>
      lab.assign(ctx, { ticketId, actor: LEAD, assignee: A }),
    );
    expect(result).toMatchObject({ category: "started", claimSeq });
    expect(await ticketOf(t, ticketId)).toEqual(before);
    expect(await transitionsOf(t, ticketId)).toHaveLength(2);
  });

  test("assign null on a ticket with no assignee is a no-op", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    const result = await t.run((ctx) =>
      lab.assign(ctx, { ticketId, actor: LEAD, assignee: null }),
    );
    expect(result).toMatchObject({ category: "unstarted", claimSeq: 0 });
    expect(await transitionsOf(t, ticketId)).toHaveLength(1);
  });

  test("assign on a done ticket gets INVALID_MOVE", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    const { claimSeq } = await claimOk(t, ticketId, A);
    await t.run((ctx) =>
      lab.resolve(ctx, {
        ticketId,
        actor: A,
        claimSeq,
        resolution: "completed",
      }),
    );
    await expectCode(
      t.run((ctx) => lab.assign(ctx, { ticketId, actor: LEAD, assignee: B })),
      "INVALID_MOVE",
    );
  });

  test("release by the holder returns the ticket to unstarted, clears the holder and raises claimSeq", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    const { claimSeq } = await claimOk(t, ticketId, A);
    const result = await t.run((ctx) =>
      lab.release(ctx, { ticketId, actor: A, claimSeq, reason: "out of time" }),
    );
    expect(result).toEqual({
      queue: "people",
      state: "open",
      category: "unstarted",
      claimSeq: claimSeq + 1,
    });
    const ticket = await ticketOf(t, ticketId);
    expect(ticket.assigneeRef).toBeUndefined();
    const history = await transitionsOf(t, ticketId);
    expect(history.at(-1)).toMatchObject({
      type: "released",
      actorRef: A.ref,
      reason: "out of time",
      fromAssigneeRef: A.ref,
    });
    expect(
      await t.run((ctx) => lab.claim(ctx, { ticketId, actor: B })),
    ).toMatchObject({ ok: true, claimSeq: claimSeq + 2 });
  });

  test("a trusted release works without the claimSeq and the old holder's claim is gone", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    const { claimSeq } = await claimOk(t, ticketId, A);
    const result = await t.run((ctx) =>
      lab.release(ctx, { ticketId, actor: LEAD, trusted: true }),
    );
    expect(result).toMatchObject({
      category: "unstarted",
      claimSeq: claimSeq + 1,
    });
    expect((await ticketOf(t, ticketId)).assigneeRef).toBeUndefined();
    await expectCode(
      t.run((ctx) => lab.renew(ctx, { ticketId, actor: A, claimSeq })),
      "CLAIM_LOST",
    );
  });

  test("a release without a claimSeq and without trusted gets INVALID_ARGUMENT", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    await claimOk(t, ticketId, A);
    await expectCode(
      t.run((ctx) => lab.release(ctx, { ticketId, actor: A })),
      "INVALID_ARGUMENT",
    );
    expect((await ticketOf(t, ticketId)).assigneeRef).toBe(A.ref);
  });

  test("a release by another party gets NOT_HOLDER and with an old claimSeq CLAIM_LOST", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    const { claimSeq } = await claimOk(t, ticketId, A);
    await expectCode(
      t.run((ctx) => lab.release(ctx, { ticketId, actor: B, claimSeq })),
      "NOT_HOLDER",
    );
    await expectCode(
      t.run((ctx) =>
        lab.release(ctx, { ticketId, actor: A, claimSeq: claimSeq - 1 }),
      ),
      "CLAIM_LOST",
    );
  });

  test("a release on a ticket that nobody started gets INVALID_MOVE", async () => {
    const t = await ready();
    const ticketId = await openPeople(t);
    await expectCode(
      t.run((ctx) =>
        lab.release(ctx, { ticketId, actor: LEAD, trusted: true }),
      ),
      "INVALID_MOVE",
    );
  });
});
