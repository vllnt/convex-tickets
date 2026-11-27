import type { FunctionReturnType } from "convex/server";
import { v } from "convex/values";
import type { ObjectType, PropertyValidators } from "convex/values";
import {
  categoryValidator,
  partyValidator,
  resolutionValidator,
  scalarRecordValidator,
  visibilityValidator,
} from "../shared.js";
import type { Party, Visibility } from "../shared.js";
import type { ComponentApi } from "../component/_generated/component.js";
import type { ListFilter, TicketDetail, Tickets } from "./index.js";
import type { QueueMap, RunMutationCtx } from "./types.js";

/**
 * One tool definition: a name, a description for the model, Convex argument
 * validators and a handler. Adapt it to your agent framework or MCP server.
 */
export interface TicketTool<A extends PropertyValidators, R> {
  name: string;
  description: string;
  args: A;
  handler: (ctx: RunMutationCtx, args: ObjectType<A>) => Promise<R>;
}

/** Who the tools act as. The party is bound by the host, never a tool argument. */
export interface ToolBinding {
  party: Party;
  /** `internal` lets this agent read internal notes. Default `public`. */
  view?: Visibility;
}

/** The names of the eight default tools. */
export const TOOL_NAMES = ["open", "list", "get", "claim", "reply", "requestInput", "handoff", "resolve"] as const;

function tool<A extends PropertyValidators, R>(definition: TicketTool<A, R>): TicketTool<A, R> {
  return definition;
}

const openArgs = {
  queue: v.string(),
  title: v.string(),
  fields: v.optional(scalarRecordValidator),
  body: v.optional(v.string()),
  to: v.optional(v.string()),
  priority: v.optional(v.number()),
  subjectRef: v.optional(v.string()),
  parentId: v.optional(v.string()),
  blockedBy: v.optional(v.array(v.string())),
  idempotencyKey: v.optional(v.string()),
};

const listArgs = {
  by: v.union(
    v.literal("queue"),
    v.literal("assignee"),
    v.literal("requester"),
    v.literal("subject"),
    v.literal("parent"),
    v.literal("search"),
  ),
  value: v.string(),
  queue: v.optional(v.string()),
  state: v.optional(v.string()),
  category: v.optional(categoryValidator),
  cursor: v.optional(v.union(v.string(), v.null())),
  numItems: v.optional(v.number()),
};

const getArgs = { ticketId: v.string() };

const claimArgs = { ticketId: v.optional(v.string()), queue: v.optional(v.string()) };

const replyArgs = {
  ticketId: v.string(),
  body: v.string(),
  visibility: v.optional(visibilityValidator),
  fields: v.optional(scalarRecordValidator),
  idempotencyKey: v.optional(v.string()),
};

const requestInputArgs = {
  ticketId: v.string(),
  claimSeq: v.number(),
  body: v.string(),
  fields: v.optional(v.array(v.string())),
};

const handoffArgs = {
  ticketId: v.string(),
  claimSeq: v.number(),
  toQueue: v.optional(v.string()),
  toParty: v.optional(partyValidator),
  reason: v.optional(v.string()),
  fields: v.optional(scalarRecordValidator),
};

const resolveArgs = {
  ticketId: v.string(),
  claimSeq: v.number(),
  resolution: resolutionValidator,
  result: v.optional(scalarRecordValidator),
  body: v.optional(v.string()),
};

type Mutations = ComponentApi["mutations"];
type Queries = ComponentApi["queries"];

/** What the `list` tool returns: a page of tickets. A title search returns one page with `isDone: true`. */
export type ListToolResult =
  | FunctionReturnType<Queries["list"]>
  | { page: FunctionReturnType<Queries["search"]>; isDone: boolean; continueCursor: string };

/** The eight default tools, keyed by name. */
export interface TicketTools {
  open: TicketTool<typeof openArgs, FunctionReturnType<Mutations["open"]>>;
  list: TicketTool<typeof listArgs, ListToolResult>;
  get: TicketTool<typeof getArgs, TicketDetail | null>;
  claim: TicketTool<typeof claimArgs, FunctionReturnType<Mutations["claim"]>>;
  reply: TicketTool<typeof replyArgs, FunctionReturnType<Mutations["reply"]>>;
  requestInput: TicketTool<typeof requestInputArgs, FunctionReturnType<Mutations["requestInput"]>>;
  handoff: TicketTool<typeof handoffArgs, FunctionReturnType<Mutations["handoff"]>>;
  resolve: TicketTool<typeof resolveArgs, FunctionReturnType<Mutations["resolve"]>>;
}

function toFilter(args: ObjectType<typeof listArgs> & { by: Exclude<ObjectType<typeof listArgs>["by"], "search"> }): ListFilter {
  switch (args.by) {
    case "queue":
      return { by: "queue", queue: args.value, state: args.state, category: args.category };
    case "assignee":
      return { by: "assignee", assigneeRef: args.value, category: args.category };
    case "requester":
      return { by: "requester", requesterRef: args.value, category: args.category };
    case "subject":
      return { by: "subject", subjectRef: args.value };
    case "parent":
      return { by: "parent", parentId: args.value };
  }
}

/**
 * Build the eight default agent tools for one bound party: open, list, get,
 * claim, reply, requestInput, handoff and resolve. Host moves (assign, close,
 * trusted overrides) are never included. Add move, hold, release, renew,
 * cancel, reopen or link yourself when an agent needs them.
 *
 * @param tickets - The host's `Tickets` client.
 * @param binding - The party the tools act as, and the view it may read.
 * @returns The tools, keyed by name.
 * @example
 * const tools = ticketTools(tickets, { party: { ref: "agent:billing", kind: "agent" } });
 * await tools.claim.handler(ctx, { queue: "billing" });
 */
export function ticketTools<Q extends QueueMap>(tickets: Tickets<Q>, binding: ToolBinding): TicketTools {
  const actor = binding.party;
  const view = binding.view ?? "public";
  return {
    open: tool({
      name: "open",
      description:
        "Open a ticket in a queue with typed fields. Optionally as a child of another ticket (parentId) or blocked by other tickets (blockedBy). Returns the ticket id.",
      args: openArgs,
      handler: async (ctx, args) => await ctx.runMutation(tickets.component.mutations.open, { ...args, actor }),
    }),
    list: tool({
      name: "list",
      description:
        "List tickets by queue (optionally one state or category), by assignee, by requester, by subject or by parent ticket, or search titles (by: search, value: the text, optional queue and category). Paginated: pass the returned continueCursor as cursor.",
      args: listArgs,
      handler: async (ctx, args): Promise<ListToolResult> => {
        const numItems = Math.min(args.numItems ?? 20, 100);
        if (args.by === "search") {
          const page = await ctx.runQuery(tickets.component.queries.search, {
            text: args.value,
            queue: args.queue,
            category: args.category,
            limit: numItems,
          });
          return { page, isDone: true, continueCursor: "" };
        }
        return await tickets.list(ctx, {
          filter: toFilter({ ...args, by: args.by }),
          paginationOpts: { cursor: args.cursor ?? null, numItems },
        });
      },
    }),
    get: tool({
      name: "get",
      description:
        "Read one ticket: state, category, fields, result, links, blockers and recent messages. Note your claimSeq from claim; every write needs it.",
      args: getArgs,
      handler: async (ctx, args) => await tickets.get(ctx, { ticketId: args.ticketId, view }),
    }),
    claim: tool({
      name: "claim",
      description:
        "Take a named ticket, or the next claimable one in a queue. Returns ok with a claimSeq, or a reason: TAKEN, BLOCKED, RESERVED, EMPTY or NOT_CLAIMABLE.",
      args: claimArgs,
      handler: async (ctx, args) =>
        await ctx.runMutation(tickets.component.mutations.claim, { ticketId: args.ticketId, queue: args.queue, actor }),
    }),
    reply: tool({
      name: "reply",
      description:
        "Add a public message for the requester, or an internal note (visibility: internal) for the parties doing the work. As the requester of a ticket waiting on you, supply the requested fields.",
      args: replyArgs,
      handler: async (ctx, args) => await ctx.runMutation(tickets.component.mutations.reply, { ...args, actor }),
    }),
    requestInput: tool({
      name: "requestInput",
      description:
        "As the holder, ask the requester a question and name the queue fields you need. The ticket waits on the requester until they reply.",
      args: requestInputArgs,
      handler: async (ctx, args) =>
        await ctx.runMutation(tickets.component.mutations.requestInput, { ...args, actor }),
    }),
    handoff: tool({
      name: "handoff",
      description:
        "As the holder, pass the ticket to another queue (toQueue) or a named party (toParty), with a reason. Refused with HOP_LIMIT or PING_PONG when it has bounced too often; the ticket then escalates if its queue has an escalation target.",
      args: handoffArgs,
      handler: async (ctx, args) => await ctx.runMutation(tickets.component.mutations.handoff, { ...args, actor }),
    }),
    resolve: tool({
      name: "resolve",
      description:
        "As the holder, finish the ticket as completed, failed or rejected, with a result that matches the queue. The requester reads the result as data.",
      args: resolveArgs,
      handler: async (ctx, args) => await ctx.runMutation(tickets.component.mutations.resolve, { ...args, actor }),
    }),
  };
}
