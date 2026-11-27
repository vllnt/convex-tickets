import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { categoryValidator, ticketsError, visibilityValidator } from "../shared.js";
import type { Doc } from "./_generated/dataModel.js";
import { query } from "./_generated/server.js";
import { linkView, messageView, queueView, ticketDetail, ticketView, transitionView } from "./validators.js";
import { toLinkView, toMessageView, toTicketView, toTransitionView } from "./views.js";

/** How many recent messages `get` returns. Page the rest with `listMessages`. */
export const GET_MESSAGES = 20;
/** How many links, and how many blockers, `get` returns. */
export const GET_LINKS = 100;

/**
 * Read one ticket with its lease expiry, links, blockers and recent messages.
 * Internal notes are returned only for `view: "internal"`.
 *
 * Args: `ticketId`; `view` (`public` by default); `queue` (optional check that the ticket is in this queue).
 * Returns the ticket detail (the newest 20 messages, oldest first), or null when the ticket does not exist.
 *
 * @throws `WRONG_QUEUE` when `queue` is given and the ticket is in another queue.
 */
export const get = query({
  args: {
    ticketId: v.id("tickets"),
    view: v.optional(visibilityValidator),
    queue: v.optional(v.string()),
  },
  returns: v.union(ticketDetail, v.null()),
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get("tickets", args.ticketId);
    if (!ticket) return null;
    if (args.queue !== undefined && ticket.queue !== args.queue) {
      throw ticketsError("WRONG_QUEUE", `the ticket is in queue "${ticket.queue}", not "${args.queue}"`);
    }
    const id = ticket._id;
    const messagesQuery =
      args.view === "internal"
        ? ctx.db.query("messages").withIndex("by_ticket_seq", (q) => q.eq("ticketId", id))
        : ctx.db.query("messages").withIndex("by_ticket_visibility", (q) => q.eq("ticketId", id).eq("visibility", "public"));
    const [lease, links, blockerLinks, messages] = await Promise.all([
      ctx.db.query("leases").withIndex("by_ticket", (q) => q.eq("ticketId", id)).unique(),
      ctx.db.query("links").withIndex("by_ticket", (q) => q.eq("ticketId", id)).take(GET_LINKS),
      ctx.db.query("links").withIndex("by_target", (q) => q.eq("toTicketId", id).eq("relation", "blocks")).take(GET_LINKS),
      messagesQuery.order("desc").take(GET_MESSAGES),
    ]);
    const blockerRows = await Promise.all(blockerLinks.map((l) => ctx.db.get("tickets", l.ticketId)));
    const blockers = blockerLinks.flatMap((l, i) => {
      const b = blockerRows[i];
      if (!b) return [];
      return [
        {
          linkId: l._id,
          ticketId: b._id,
          state: b.state,
          category: b.category,
          resolution: b.resolution,
          completed: b.category === "done" && b.resolution === "completed",
        },
      ];
    });
    return {
      ticket: toTicketView(ticket),
      leaseExpiresAt: lease?.expiresAt,
      links: links.map(toLinkView),
      blockers,
      messages: messages.reverse().map(toMessageView),
    };
  },
});

const listFilter = v.union(
  v.object({ by: v.literal("queue"), queue: v.string(), state: v.optional(v.string()), category: v.optional(categoryValidator) }),
  v.object({ by: v.literal("assignee"), assigneeRef: v.string(), category: v.optional(categoryValidator) }),
  v.object({ by: v.literal("requester"), requesterRef: v.string(), category: v.optional(categoryValidator) }),
  v.object({ by: v.literal("subject"), subjectRef: v.string() }),
  v.object({ by: v.literal("parent"), parentId: v.id("tickets") }),
);

/**
 * Page through tickets by queue (and state or category), assignee, requester,
 * subject or parent. Every branch reads one index range.
 *
 * Args: `filter` (`{ by: "queue", queue, state? or category? }`, `{ by: "assignee", assigneeRef, category? }`, `{ by: "requester", requesterRef, category? }`, `{ by: "subject", subjectRef }` or `{ by: "parent", parentId }`) and `paginationOpts`.
 * Returns one page of ticket views.
 *
 * @throws `INVALID_ARGUMENT` when a queue filter gives both `state` and `category`.
 */
export const list = query({
  args: { filter: listFilter, paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(ticketView),
  handler: async (ctx, { filter, paginationOpts }) => {
    const tickets = ctx.db.query("tickets");
    const ranged = (() => {
      switch (filter.by) {
        case "queue": {
          if (filter.state !== undefined && filter.category !== undefined) {
            throw ticketsError("INVALID_ARGUMENT", "filter by state or by category, not both");
          }
          const { queue, state, category } = filter;
          if (state !== undefined) {
            return tickets.withIndex("by_queue_state", (q) => q.eq("queue", queue).eq("state", state));
          }
          if (category !== undefined) {
            return tickets.withIndex("by_queue_category", (q) => q.eq("queue", queue).eq("category", category));
          }
          return tickets.withIndex("by_queue_state", (q) => q.eq("queue", queue));
        }
        case "assignee": {
          const { assigneeRef, category } = filter;
          return tickets.withIndex("by_assignee", (q) =>
            category === undefined ? q.eq("assigneeRef", assigneeRef) : q.eq("assigneeRef", assigneeRef).eq("category", category),
          );
        }
        case "requester": {
          const { requesterRef, category } = filter;
          return tickets.withIndex("by_requester", (q) =>
            category === undefined ? q.eq("requesterRef", requesterRef) : q.eq("requesterRef", requesterRef).eq("category", category),
          );
        }
        case "subject":
          return tickets.withIndex("by_subject", (q) => q.eq("subjectRef", filter.subjectRef));
        case "parent":
          return tickets.withIndex("by_parent", (q) => q.eq("parentId", filter.parentId));
      }
    })();
    const page = await ranged.paginate(paginationOpts);
    return { ...page, page: page.page.map(toTicketView) };
  },
});

/**
 * Full-text search over titles, optionally inside one queue and category.
 *
 * Args: `text`; optional `queue` and `category`; `limit` (default 20).
 * Returns up to `limit` matching ticket views.
 *
 * @throws `INVALID_ARGUMENT` when `limit` is not an integer from 1 to 100.
 */
export const search = query({
  args: {
    text: v.string(),
    queue: v.optional(v.string()),
    category: v.optional(categoryValidator),
    limit: v.optional(v.number()),
  },
  returns: v.array(ticketView),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw ticketsError("INVALID_ARGUMENT", "limit must be an integer from 1 to 100");
    }
    const rows: Doc<"tickets">[] = await ctx.db
      .query("tickets")
      .withSearchIndex("search_title", (q) => {
        const base = q.search("title", args.text);
        const inQueue = args.queue === undefined ? base : base.eq("queue", args.queue);
        return args.category === undefined ? inQueue : inQueue.eq("category", args.category);
      })
      .take(limit);
    return rows.map(toTicketView);
  },
});

/**
 * Page through a ticket's thread, oldest first. Internal notes only for `view: "internal"`.
 *
 * Args: `ticketId`; `view` (`public` by default); `paginationOpts`.
 * Returns one page of message views. Throws no coded error.
 */
export const listMessages = query({
  args: { ticketId: v.id("tickets"), view: v.optional(visibilityValidator), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(messageView),
  handler: async (ctx, args) => {
    const id = args.ticketId;
    const ranged =
      args.view === "internal"
        ? ctx.db.query("messages").withIndex("by_ticket_seq", (q) => q.eq("ticketId", id))
        : ctx.db.query("messages").withIndex("by_ticket_visibility", (q) => q.eq("ticketId", id).eq("visibility", "public"));
    const page = await ranged.paginate(args.paginationOpts);
    return { ...page, page: page.page.map(toMessageView) };
  },
});

/**
 * Page through a ticket's history, oldest first.
 *
 * Args: `ticketId` and `paginationOpts`.
 * Returns one page of transition views. Throws no coded error.
 */
export const listTransitions = query({
  args: { ticketId: v.id("tickets"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(transitionView),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("transitions")
      .withIndex("by_ticket_seq", (q) => q.eq("ticketId", args.ticketId))
      .paginate(args.paginationOpts);
    return { ...page, page: page.page.map(toTransitionView) };
  },
});

/**
 * Every link to one outside thing, such as "which ticket belongs to this agent thread" or "every ticket with this label".
 *
 * Args: `refKind`, `ref` and `paginationOpts`.
 * Returns one page of link views. Throws no coded error.
 */
export const listByRef = query({
  args: { refKind: v.string(), ref: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(linkView),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("links")
      .withIndex("by_ref", (q) => q.eq("refKind", args.refKind).eq("ref", args.ref))
      .paginate(args.paginationOpts);
    return { ...page, page: page.page.map(toLinkView) };
  },
});

/**
 * Read one synced queue definition, or null.
 *
 * Args: `name`, the queue name.
 * Returns the queue's states, fields, result fields, policy, schema version and update time, or null before `sync`. Throws no coded error.
 */
export const getQueue = query({
  args: { name: v.string() },
  returns: v.union(queueView, v.null()),
  handler: async (ctx, args) => {
    const queue = await ctx.db
      .query("queues")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    if (!queue) return null;
    return {
      name: queue.name,
      states: queue.states,
      fields: queue.fields,
      resultFields: queue.resultFields,
      policy: queue.policy,
      schemaVersion: queue.schemaVersion,
      updatedAt: queue.updatedAt,
    };
  },
});
