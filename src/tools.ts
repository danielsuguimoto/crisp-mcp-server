import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CrispApiError, type CrispClient } from "./crisp";

function textResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(error: unknown) {
  const message =
    error instanceof CrispApiError
      ? `Crisp API error ${error.status} on ${error.path}: ${error.reason}`
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function handle<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  return async (args: TArgs) => {
    try {
      return textResult(await fn(args));
    } catch (error) {
      return errorResult(error);
    }
  };
}

const zeroOne = z.union([z.literal(0), z.literal(1)]).optional();
const operatorId = z.uuid({
  error: "Use an operator user ID (UUID) from list_website_operators; names, emails, and 'me' are not supported.",
});
const websiteId = z.string().trim().min(1).optional().describe(
  "Crisp website ID (workspace ID). Omit to use the configured default or the only connected website (plugin tier).",
);

export function registerTools(server: McpServer, crisp: CrispClient): void {
  server.registerTool(
    "get_website",
    {
      description: "Get details of a single Crisp website (workspace).",
      inputSchema: { website_id: websiteId },
    },
    handle(async ({ website_id }) => crisp.getWebsite(await crisp.resolveWebsiteId(website_id))),
  );

  server.registerTool(
    "list_connect_websites",
    {
      description:
        "List all websites connected to the authenticated plugin token (plugin tier only). Paginated.",
      inputSchema: {
        page: z.number().int().min(1).default(1).describe("Page number, starting at 1"),
        filter_configured: z.boolean().optional().describe("Only return configured websites"),
        include_plan: z.boolean().optional().describe("Include plan info in the response"),
      },
    },
    handle(({ page, filter_configured, include_plan }) =>
      crisp.listConnectWebsites(page, filter_configured, include_plan),
    ),
  );

  server.registerTool(
    "get_connect_account",
    {
      description: "Get the authenticated plugin connect account details (plugin tier only).",
      inputSchema: {},
    },
    handle(() => crisp.getConnectAccount()),
  );

  server.registerTool(
    "list_website_operators",
    {
      description: "List all operators (agents) of a Crisp website.",
      inputSchema: { website_id: websiteId },
    },
    handle(async ({ website_id }) =>
      crisp.listWebsiteOperators(await crisp.resolveWebsiteId(website_id)),
    ),
  );

  server.registerTool(
    "list_last_active_website_operators",
    {
      description: "List the last active operators of a Crisp website.",
      inputSchema: { website_id: websiteId },
    },
    handle(async ({ website_id }) =>
      crisp.listLastActiveWebsiteOperators(await crisp.resolveWebsiteId(website_id)),
    ),
  );

  server.registerTool(
    "get_website_operator",
    {
      description: "Get details of a single operator (agent) of a Crisp website.",
      inputSchema: {
        website_id: websiteId,
        user_id: z.string().describe("Operator user ID"),
      },
    },
    handle(async ({ website_id, user_id }) =>
      crisp.getWebsiteOperator(await crisp.resolveWebsiteId(website_id), user_id),
    ),
  );

  server.registerTool(
    "list_conversations",
    {
      description:
        "List conversations of a Crisp website. Use assigned_operator_id for assignment to a specific operator. filter_mention is a separate 0/1 flag for mentions of the authenticated user, not an operator ID.",
      inputSchema: z.object({
        website_id: websiteId,
        page: z.number().int().min(1).default(1).describe("Page number, starting at 1"),
        per_page: z.number().int().min(20).max(50).optional().describe("Page size (20–50, defaults to 20)"),
        search_query: z.string().optional().describe("Search query across conversations: text for text or segment search, filter expression for filter search"),
        search_type: z.enum(["text", "segment", "filter"]).optional().describe("Search type: text, segment, or filter"),
        search_operator: z.enum(["and", "or"]).optional().describe("Boolean operator for filter search: and or or (Crisp defaults to and when omitted)"),
        include_empty: zeroOne.describe("Include conversations with no messages (1) or not (0)"),
        filter_inbox_id: z.string().optional(),
        filter_unread: zeroOne,
        filter_resolved: zeroOne,
        filter_not_resolved: zeroOne,
        assigned_operator_id: operatorId.optional().describe("Only conversations assigned to this operator user ID (UUID from list_website_operators)"),
        filter_mention: z.union([z.literal(0), z.literal(1)], {
          error: "filter_mention must be 0 or 1 for mentions of the authenticated user; filtering mentions by operator ID is not supported.",
        }).optional().describe("1: only mentions of the authenticated user; 0: no mention filter. Does not select an assigned operator."),
        filter_assigned: operatorId.optional().describe("Legacy alias for assigned_operator_id (operator user ID UUID)"),
        filter_unassigned: zeroOne.describe("1: only unassigned conversations; cannot combine with an assigned operator ID"),
        filter_date_start: z.string().optional().describe("ISO date, inclusive lower bound"),
        filter_date_end: z.string().optional().describe("ISO date, inclusive upper bound"),
        order_date_created: zeroOne,
        order_date_updated: zeroOne,
        order_date_waiting: zeroOne,
      }).superRefine((args, ctx) => {
        if (
          args.assigned_operator_id !== undefined &&
          args.filter_assigned !== undefined &&
          args.assigned_operator_id !== args.filter_assigned
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["filter_assigned"],
            message: "assigned_operator_id and filter_assigned must identify the same operator; use only assigned_operator_id.",
          });
        }
        if (
          args.filter_unassigned === 1 &&
          (args.assigned_operator_id !== undefined || args.filter_assigned !== undefined)
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["filter_unassigned"],
            message: "filter_unassigned=1 cannot be combined with assigned_operator_id or filter_assigned.",
          });
        }
      }),
    },
    handle(async ({ website_id, page, assigned_operator_id, filter_assigned, ...options }) =>
      crisp.listConversations(await crisp.resolveWebsiteId(website_id), page, {
        ...options,
        filter_assigned: assigned_operator_id ?? filter_assigned,
      }),
    ),
  );

  server.registerTool(
    "get_conversation",
    {
      description: "Get details of a single conversation.",
      inputSchema: {
        website_id: websiteId,
        session_id: z.string().describe("Conversation session ID"),
      },
    },
    handle(async ({ website_id, session_id }) =>
      crisp.getConversation(await crisp.resolveWebsiteId(website_id), session_id),
    ),
  );

  server.registerTool(
    "get_conversation_messages",
    {
      description:
        "Get messages of a conversation. Use one of timestamp_before / timestamp_after / timestamp_around to paginate.",
      inputSchema: {
        website_id: websiteId,
        session_id: z.string(),
        timestamp_before: z.union([z.string(), z.number()]).optional().describe("Return messages older than this timestamp"),
        timestamp_after: z.union([z.string(), z.number()]).optional().describe("Return messages newer than this timestamp"),
        timestamp_around: z.union([z.string(), z.number()]).optional().describe("Return messages around this timestamp"),
      },
    },
    handle(async ({ website_id, session_id, ...timestamps }) =>
      crisp.getConversationMessages(await crisp.resolveWebsiteId(website_id), session_id, timestamps),
    ),
  );

  server.registerTool(
    "get_conversation_activity",
    {
      description:
        "Get current conversation state, waiting/unread/assignment signals, recent internal notes, and the last overall/operator/visitor event. Reads only the latest message batch; never scans older history. Missing events/notes may exist in older batches. Use state and event timestamps/content to assess operator action; a note alone does not mean the conversation is handled.",
      inputSchema: {
        website_id: z.string().min(1).describe("Crisp website ID (workspace ID)"),
        session_id: z.string().min(1).describe("Conversation session ID"),
        note_limit: z.number().int().min(0).max(20).default(5).describe("Maximum recent notes to return (0–20, defaults to 5), newest first, from the latest message batch only"),
      },
    },
    handle(({ website_id, session_id, note_limit }) =>
      crisp.getConversationActivity(website_id, session_id, note_limit),
    ),
  );

  server.registerTool(
    "send_conversation_note",
    {
      description:
        "Post a private note in a conversation. Notes are only visible to operators, not to the visitor.",
      inputSchema: {
        website_id: websiteId,
        session_id: z.string(),
        content: z.string().describe("Note text (markdown supported)"),
        mentions: z.array(z.string()).optional().describe("Operator user IDs to mention"),
      },
    },
    handle(async ({ website_id, session_id, content, mentions }) =>
      crisp.sendNoteInConversation(await crisp.resolveWebsiteId(website_id), session_id, content, mentions ?? []),
    ),
  );

  server.registerTool(
    "send_conversation_message",
    {
      description:
        "Send a text message in a conversation as an operator. The message is visible to the visitor. Use send_conversation_note for internal notes.",
      inputSchema: {
        website_id: websiteId,
        session_id: z.string(),
        content: z.string().describe("Message text (markdown supported)"),
        fingerprint: z.number().int().optional().describe("Optional message fingerprint (defaults to 0)"),
        mentions: z.array(z.string()).optional().describe("Operator user IDs to mention"),
      },
    },
    handle(async ({ website_id, session_id, content, fingerprint, mentions }) =>
      crisp.sendTextMessageInConversation(await crisp.resolveWebsiteId(website_id), session_id, content, {
        fingerprint,
        mentions: mentions ?? [],
      }),
    ),
  );

  server.registerTool(
    "get_conversation_state",
    {
      description: "Get the current state of a conversation (pending, unresolved, or resolved).",
      inputSchema: {
        website_id: websiteId,
        session_id: z.string(),
      },
    },
    handle(async ({ website_id, session_id }) =>
      crisp.getConversationState(await crisp.resolveWebsiteId(website_id), session_id),
    ),
  );

  server.registerTool(
    "set_conversation_state",
    {
      description:
        "Change the state of a conversation. Use 'resolved' to resolve, 'unresolved' to reopen as unresolved, or 'pending' to mark pending.",
      inputSchema: {
        website_id: websiteId,
        session_id: z.string(),
        state: z.enum(["pending", "unresolved", "resolved"]).describe("New conversation state"),
      },
    },
    handle(async ({ website_id, session_id, state }) =>
      crisp.setConversationState(await crisp.resolveWebsiteId(website_id), session_id, state),
    ),
  );

  server.registerTool(
    "set_conversation_segments",
    {
      description:
        "Replace the segments assigned to a conversation. Pass the full desired list of segment names. Pass an empty array to remove all segments.",
      inputSchema: {
        website_id: websiteId,
        session_id: z.string(),
        segments: z.array(z.string()).describe("Full list of segment names to set (replaces existing)"),
      },
    },
    handle(async ({ website_id, session_id, segments }) =>
      crisp.setConversationSegments(await crisp.resolveWebsiteId(website_id), session_id, segments),
    ),
  );
}
