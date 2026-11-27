/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    mutations: {
      assign: FunctionReference<
        "mutation",
        "internal",
        {
          actor: { kind: "human" | "agent" | "system"; ref: string };
          assignee: { kind: "human" | "agent" | "system"; ref: string } | null;
          reason?: string;
          ticketId: string;
        },
        {
          category:
            | "backlog"
            | "unstarted"
            | "started"
            | "waiting"
            | "done"
            | "canceled";
          claimSeq: number;
          queue: string;
          state: string;
        },
        Name
      >;
      cancel: FunctionReference<
        "mutation",
        "internal",
        {
          actor: { kind: "human" | "agent" | "system"; ref: string };
          reason?: string;
          ticketId: string;
          to?: string;
          trusted?: boolean;
        },
        {
          category:
            | "backlog"
            | "unstarted"
            | "started"
            | "waiting"
            | "done"
            | "canceled";
          claimSeq: number;
          queue: string;
          state: string;
        },
        Name
      >;
      claim: FunctionReference<
        "mutation",
        "internal",
        {
          actor: { kind: "human" | "agent" | "system"; ref: string };
          queue?: string;
          ticketId?: string;
          to?: string;
        },
        | {
            claimSeq: number;
            leaseExpiresAt?: number;
            ok: true;
            state: string;
            ticketId: string;
          }
        | {
            ok: false;
            reason:
              "TAKEN" | "BLOCKED" | "RESERVED" | "EMPTY" | "NOT_CLAIMABLE";
            ticketId?: string;
          },
        Name
      >;
      close: FunctionReference<
        "mutation",
        "internal",
        {
          actor: { kind: "human" | "agent" | "system"; ref: string };
          ticketId: string;
        },
        {
          category:
            | "backlog"
            | "unstarted"
            | "started"
            | "waiting"
            | "done"
            | "canceled";
          claimSeq: number;
          queue: string;
          state: string;
        },
        Name
      >;
      escalate: FunctionReference<
        "mutation",
        "internal",
        {
          actor: { kind: "human" | "agent" | "system"; ref: string };
          claimSeq?: number;
          reason: string;
          ticketId: string;
          trusted?: boolean;
        },
        {
          category:
            | "backlog"
            | "unstarted"
            | "started"
            | "waiting"
            | "done"
            | "canceled";
          claimSeq: number;
          queue: string;
          state: string;
        },
        Name
      >;
      handoff: FunctionReference<
        "mutation",
        "internal",
        {
          actor: { kind: "human" | "agent" | "system"; ref: string };
          claimSeq: number;
          fields?: Record<string, string | number | boolean | null>;
          reason?: string;
          ticketId: string;
          toParty?: { kind: "human" | "agent" | "system"; ref: string };
          toQueue?: string;
        },
        | { claimSeq: number; ok: true; queue: string; state: string }
        | { escalated: boolean; ok: false; reason: "HOP_LIMIT" | "PING_PONG" },
        Name
      >;
      hold: FunctionReference<
        "mutation",
        "internal",
        {
          actor: { kind: "human" | "agent" | "system"; ref: string };
          blockers?: Array<string>;
          claimSeq: number;
          reason?: string;
          ticketId: string;
          to?: string;
          waitingOn?: "blockers" | "external";
        },
        {
          category:
            | "backlog"
            | "unstarted"
            | "started"
            | "waiting"
            | "done"
            | "canceled";
          claimSeq: number;
          queue: string;
          state: string;
        },
        Name
      >;
      link: FunctionReference<
        "mutation",
        "internal",
        {
          actor: { kind: "human" | "agent" | "system"; ref: string };
          label?: string;
          ref?: string;
          refKind?: string;
          relation: "blocks" | "duplicates" | "relates" | "ref";
          ticketId: string;
          toTicketId?: string;
        },
        string,
        Name
      >;
      move: FunctionReference<
        "mutation",
        "internal",
        {
          actor: { kind: "human" | "agent" | "system"; ref: string };
          claimSeq?: number;
          queue?: string;
          ticketId: string;
          to: string;
          trusted?: boolean;
        },
        {
          category:
            | "backlog"
            | "unstarted"
            | "started"
            | "waiting"
            | "done"
            | "canceled";
          claimSeq: number;
          queue: string;
          state: string;
        },
        Name
      >;
      open: FunctionReference<
        "mutation",
        "internal",
        {
          actor: { kind: "human" | "agent" | "system"; ref: string };
          blockedBy?: Array<string>;
          body?: string;
          fields?: Record<string, string | number | boolean | null>;
          idempotencyKey?: string;
          parentId?: string;
          priority?: number;
          queue: string;
          subjectRef?: string;
          title: string;
          to?: string;
        },
        string,
        Name
      >;
      release: FunctionReference<
        "mutation",
        "internal",
        {
          actor: { kind: "human" | "agent" | "system"; ref: string };
          claimSeq?: number;
          reason?: string;
          ticketId: string;
          to?: string;
          trusted?: boolean;
        },
        {
          category:
            | "backlog"
            | "unstarted"
            | "started"
            | "waiting"
            | "done"
            | "canceled";
          claimSeq: number;
          queue: string;
          state: string;
        },
        Name
      >;
      renew: FunctionReference<
        "mutation",
        "internal",
        {
          actor: { kind: "human" | "agent" | "system"; ref: string };
          claimSeq: number;
          ticketId: string;
        },
        { expiresAt: number | null },
        Name
      >;
      reopen: FunctionReference<
        "mutation",
        "internal",
        {
          actor: { kind: "human" | "agent" | "system"; ref: string };
          reason?: string;
          ticketId: string;
          to?: string;
          trusted?: boolean;
        },
        {
          category:
            | "backlog"
            | "unstarted"
            | "started"
            | "waiting"
            | "done"
            | "canceled";
          claimSeq: number;
          queue: string;
          state: string;
        },
        Name
      >;
      reply: FunctionReference<
        "mutation",
        "internal",
        {
          actor: { kind: "human" | "agent" | "system"; ref: string };
          body: string;
          fields?: Record<string, string | number | boolean | null>;
          idempotencyKey?: string;
          queue?: string;
          ticketId: string;
          visibility?: "public" | "internal";
        },
        | { duplicate: boolean; messageId: string; ok: true; resumed: boolean }
        | { escalated: boolean; ok: false; reason: "MESSAGE_LIMIT" },
        Name
      >;
      requestInput: FunctionReference<
        "mutation",
        "internal",
        {
          actor: { kind: "human" | "agent" | "system"; ref: string };
          body: string;
          claimSeq: number;
          fields?: Array<string>;
          queue?: string;
          ticketId: string;
          to?: string;
        },
        {
          category: "waiting";
          claimSeq: number;
          messageId: string;
          queue: string;
          state: string;
        },
        Name
      >;
      resolve: FunctionReference<
        "mutation",
        "internal",
        {
          actor: { kind: "human" | "agent" | "system"; ref: string };
          body?: string;
          claimSeq: number;
          queue?: string;
          resolution: "completed" | "failed" | "rejected";
          result?: Record<string, string | number | boolean | null>;
          ticketId: string;
          to?: string;
        },
        {
          category:
            | "backlog"
            | "unstarted"
            | "started"
            | "waiting"
            | "done"
            | "canceled";
          claimSeq: number;
          queue: string;
          state: string;
        },
        Name
      >;
      resume: FunctionReference<
        "mutation",
        "internal",
        {
          actor: { kind: "human" | "agent" | "system"; ref: string };
          claimSeq?: number;
          reason?: string;
          ticketId: string;
          to?: string;
          trusted?: boolean;
        },
        {
          category:
            | "backlog"
            | "unstarted"
            | "started"
            | "waiting"
            | "done"
            | "canceled";
          claimSeq: number;
          queue: string;
          state: string;
        },
        Name
      >;
      sync: FunctionReference<
        "mutation",
        "internal",
        {
          limits?: {
            maxBlocked?: number;
            maxBlockers?: number;
            maxBodyChars?: number;
            maxFields?: number;
            maxGraphWalk?: number;
            maxStringChars?: number;
            messagesPerMinute?: number;
            opensPerMinute?: number;
          };
          onEventHandle?: string;
          queues: Array<{
            fields: Array<{
              key: string;
              options?: Array<string>;
              required: boolean;
              type: "string" | "number" | "boolean" | "enum";
            }>;
            name: string;
            policy: {
              dueInMs?: number;
              escalateOnDue?: boolean;
              escalateTo?: string;
              leaseMs: number | null;
              maxHops: number;
              maxMessages: number;
              maxOpenPerRequester: number;
              maxReturns: number;
              reopenWindowMs: number | null;
            };
            resultFields: Array<{
              key: string;
              options?: Array<string>;
              required: boolean;
              type: "string" | "number" | "boolean" | "enum";
            }>;
            states: Array<{
              category:
                | "backlog"
                | "unstarted"
                | "started"
                | "waiting"
                | "done"
                | "canceled";
              name: string;
              on?: "requester" | "external";
            }>;
          }>;
          retentionMs?: number;
        },
        {
          created: Array<string>;
          unchanged: Array<string>;
          updated: Array<string>;
        },
        Name
      >;
      unlink: FunctionReference<
        "mutation",
        "internal",
        { linkId: string },
        null,
        Name
      >;
    };
    queries: {
      get: FunctionReference<
        "query",
        "internal",
        { queue?: string; ticketId: string; view?: "public" | "internal" },
        {
          blockers: Array<{
            category:
              | "backlog"
              | "unstarted"
              | "started"
              | "waiting"
              | "done"
              | "canceled";
            completed: boolean;
            linkId: string;
            resolution?: "completed" | "failed" | "rejected";
            state: string;
            ticketId: string;
          }>;
          leaseExpiresAt?: number;
          links: Array<{
            createdAt: number;
            createdByRef: string;
            label?: string;
            linkId: string;
            ref?: string;
            refKind?: string;
            relation: "blocks" | "duplicates" | "relates" | "ref";
            ticketId: string;
            toTicketId?: string;
          }>;
          messages: Array<{
            authorKind: "human" | "agent" | "system";
            authorRef: string;
            body: string;
            createdAt: number;
            data?: Record<string, string | number | boolean | null>;
            kind: "message" | "input_request" | "system";
            messageId: string;
            requestedFields?: Array<string>;
            seq: number;
            ticketId: string;
            visibility: "public" | "internal";
          }>;
          ticket: {
            assigneeKind?: "human" | "agent" | "system";
            assigneeRef?: string;
            canceledAt?: number;
            category:
              | "backlog"
              | "unstarted"
              | "started"
              | "waiting"
              | "done"
              | "canceled";
            claimSeq: number;
            closedAt?: number;
            createdAt: number;
            dueAt?: number;
            dueBreachedAt?: number;
            escalatedAt?: number;
            fields: Record<string, string | number | boolean | null>;
            hopCount: number;
            leaseExpiryCount: number;
            messageCount: number;
            openBlockers: number;
            parentId?: string;
            priority: number;
            queue: string;
            requesterKind: "human" | "agent" | "system";
            requesterRef: string;
            resolution?: "completed" | "failed" | "rejected";
            resolvedAt?: number;
            result?: Record<string, string | number | boolean | null>;
            schemaVersion: number;
            state: string;
            subjectRef?: string;
            ticketId: string;
            title: string;
            updatedAt: number;
            waitingOn?: "requester" | "blockers" | "external";
          };
        } | null,
        Name
      >;
      getQueue: FunctionReference<
        "query",
        "internal",
        { name: string },
        {
          fields: Array<{
            key: string;
            options?: Array<string>;
            required: boolean;
            type: "string" | "number" | "boolean" | "enum";
          }>;
          name: string;
          policy: {
            dueInMs?: number;
            escalateOnDue?: boolean;
            escalateTo?: string;
            leaseMs: number | null;
            maxHops: number;
            maxMessages: number;
            maxOpenPerRequester: number;
            maxReturns: number;
            reopenWindowMs: number | null;
          };
          resultFields: Array<{
            key: string;
            options?: Array<string>;
            required: boolean;
            type: "string" | "number" | "boolean" | "enum";
          }>;
          schemaVersion: number;
          states: Array<{
            category:
              | "backlog"
              | "unstarted"
              | "started"
              | "waiting"
              | "done"
              | "canceled";
            name: string;
            on?: "requester" | "external";
          }>;
          updatedAt: number;
        } | null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        {
          filter:
            | {
                by: "queue";
                category?:
                  | "backlog"
                  | "unstarted"
                  | "started"
                  | "waiting"
                  | "done"
                  | "canceled";
                queue: string;
                state?: string;
              }
            | {
                assigneeRef: string;
                by: "assignee";
                category?:
                  | "backlog"
                  | "unstarted"
                  | "started"
                  | "waiting"
                  | "done"
                  | "canceled";
              }
            | {
                by: "requester";
                category?:
                  | "backlog"
                  | "unstarted"
                  | "started"
                  | "waiting"
                  | "done"
                  | "canceled";
                requesterRef: string;
              }
            | { by: "subject"; subjectRef: string }
            | { by: "parent"; parentId: string };
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            assigneeKind?: "human" | "agent" | "system";
            assigneeRef?: string;
            canceledAt?: number;
            category:
              | "backlog"
              | "unstarted"
              | "started"
              | "waiting"
              | "done"
              | "canceled";
            claimSeq: number;
            closedAt?: number;
            createdAt: number;
            dueAt?: number;
            dueBreachedAt?: number;
            escalatedAt?: number;
            fields: Record<string, string | number | boolean | null>;
            hopCount: number;
            leaseExpiryCount: number;
            messageCount: number;
            openBlockers: number;
            parentId?: string;
            priority: number;
            queue: string;
            requesterKind: "human" | "agent" | "system";
            requesterRef: string;
            resolution?: "completed" | "failed" | "rejected";
            resolvedAt?: number;
            result?: Record<string, string | number | boolean | null>;
            schemaVersion: number;
            state: string;
            subjectRef?: string;
            ticketId: string;
            title: string;
            updatedAt: number;
            waitingOn?: "requester" | "blockers" | "external";
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      listByRef: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          ref: string;
          refKind: string;
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            createdAt: number;
            createdByRef: string;
            label?: string;
            linkId: string;
            ref?: string;
            refKind?: string;
            relation: "blocks" | "duplicates" | "relates" | "ref";
            ticketId: string;
            toTicketId?: string;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      listMessages: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          ticketId: string;
          view?: "public" | "internal";
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            authorKind: "human" | "agent" | "system";
            authorRef: string;
            body: string;
            createdAt: number;
            data?: Record<string, string | number | boolean | null>;
            kind: "message" | "input_request" | "system";
            messageId: string;
            requestedFields?: Array<string>;
            seq: number;
            ticketId: string;
            visibility: "public" | "internal";
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      listTransitions: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          ticketId: string;
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            actorKind: "human" | "agent" | "system";
            actorRef: string;
            at: number;
            fromAssigneeRef?: string;
            fromCategory?:
              | "backlog"
              | "unstarted"
              | "started"
              | "waiting"
              | "done"
              | "canceled";
            fromQueue?: string;
            fromState?: string;
            reason?: string;
            seq: number;
            ticketId: string;
            toAssigneeRef?: string;
            toCategory:
              | "backlog"
              | "unstarted"
              | "started"
              | "waiting"
              | "done"
              | "canceled";
            toQueue?: string;
            toState: string;
            type:
              | "opened"
              | "moved"
              | "assigned"
              | "claimed"
              | "released"
              | "lease_expired"
              | "handed_off"
              | "input_requested"
              | "input_provided"
              | "held"
              | "resumed"
              | "unblocked"
              | "blocker_failed"
              | "resolved"
              | "reopened"
              | "closed"
              | "canceled"
              | "escalated"
              | "due_breached"
              | "guardrail_tripped";
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      search: FunctionReference<
        "query",
        "internal",
        {
          category?:
            | "backlog"
            | "unstarted"
            | "started"
            | "waiting"
            | "done"
            | "canceled";
          limit?: number;
          queue?: string;
          text: string;
        },
        Array<{
          assigneeKind?: "human" | "agent" | "system";
          assigneeRef?: string;
          canceledAt?: number;
          category:
            | "backlog"
            | "unstarted"
            | "started"
            | "waiting"
            | "done"
            | "canceled";
          claimSeq: number;
          closedAt?: number;
          createdAt: number;
          dueAt?: number;
          dueBreachedAt?: number;
          escalatedAt?: number;
          fields: Record<string, string | number | boolean | null>;
          hopCount: number;
          leaseExpiryCount: number;
          messageCount: number;
          openBlockers: number;
          parentId?: string;
          priority: number;
          queue: string;
          requesterKind: "human" | "agent" | "system";
          requesterRef: string;
          resolution?: "completed" | "failed" | "rejected";
          resolvedAt?: number;
          result?: Record<string, string | number | boolean | null>;
          schemaVersion: number;
          state: string;
          subjectRef?: string;
          ticketId: string;
          title: string;
          updatedAt: number;
          waitingOn?: "requester" | "blockers" | "external";
        }>,
        Name
      >;
    };
  };
