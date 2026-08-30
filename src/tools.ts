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

export function registerTools(server: McpServer, crisp: CrispClient): void {
  server.registerTool(
    "get_website",
    {
      description: "Get details of a single Crisp website (workspace).",
      inputSchema: { website_id: z.string().describe("Crisp website ID (workspace ID)") },
    },
    handle(({ website_id }) => crisp.getWebsite(website_id)),
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
      inputSchema: { website_id: z.string() },
    },
    handle(({ website_id }) => crisp.listWebsiteOperators(website_id)),
  );

  server.registerTool(
    "list_last_active_website_operators",
    {
      description: "List the last active operators of a Crisp website.",
      inputSchema: { website_id: z.string() },
    },
    handle(({ website_id }) => crisp.listLastActiveWebsiteOperators(website_id)),
  );

  server.registerTool(
    "get_website_operator",
    {
      description: "Get details of a single operator (agent) of a Crisp website.",
      inputSchema: {
        website_id: z.string(),
        user_id: z.string().describe("Operator user ID"),
      },
    },
    handle(({ website_id, user_id }) => crisp.getWebsiteOperator(website_id, user_id)),
  );

  server.registerTool(
    "list_conversations",
    {
      description: "List conversations of a Crisp website. Paginated, with optional filters.",
      inputSchema: {
        website_id: z.string(),
        page: z.number().int().min(1).default(1).describe("Page number, starting at 1"),
        per_page: z.number().int().min(20).max(50).optional().describe("Page size (20–50, defaults to 20)"),
        include_empty: zeroOne.describe("Include conversations with no messages (1) or not (0)"),
        filter_inbox_id: z.string().optional(),
        filter_unread: zeroOne,
        filter_resolved: zeroOne,
        filter_not_resolved: zeroOne,
        filter_mention: zeroOne,
        filter_assigned: z.string().optional().describe("Filter by assigned operator user ID"),
        filter_unassigned: zeroOne,
        filter_date_start: z.string().optional().describe("ISO date, inclusive lower bound"),
        filter_date_end: z.string().optional().describe("ISO date, inclusive upper bound"),
        order_date_created: zeroOne,
        order_date_updated: zeroOne,
        order_date_waiting: zeroOne,
      },
    },
    handle(({ website_id, page, ...options }) => crisp.listConversations(website_id, page, options)),
  );

  server.registerTool(
    "get_conversation",
    {
      description: "Get details of a single conversation.",
      inputSchema: {
        website_id: z.string(),
        session_id: z.string().describe("Conversation session ID"),
      },
    },
    handle(({ website_id, session_id }) => crisp.getConversation(website_id, session_id)),
  );

  server.registerTool(
    "get_conversation_messages",
    {
      description:
        "Get messages of a conversation. Use one of timestamp_before / timestamp_after / timestamp_around to paginate.",
      inputSchema: {
        website_id: z.string(),
        session_id: z.string(),
        timestamp_before: z.union([z.string(), z.number()]).optional().describe("Return messages older than this timestamp"),
        timestamp_after: z.union([z.string(), z.number()]).optional().describe("Return messages newer than this timestamp"),
        timestamp_around: z.union([z.string(), z.number()]).optional().describe("Return messages around this timestamp"),
      },
    },
    handle(({ website_id, session_id, ...timestamps }) =>
      crisp.getConversationMessages(website_id, session_id, timestamps),
    ),
  );

  server.registerTool(
    "send_conversation_note",
    {
      description:
        "Post a private note in a conversation. Notes are only visible to operators, not to the visitor.",
      inputSchema: {
        website_id: z.string(),
        session_id: z.string(),
        content: z.string().describe("Note text (markdown supported)"),
        mentions: z.array(z.string()).optional().describe("Operator user IDs to mention"),
      },
    },
    handle(({ website_id, session_id, content, mentions }) =>
      crisp.sendNoteInConversation(website_id, session_id, content, mentions ?? []),
    ),
  );

  server.registerTool(
    "send_conversation_message",
    {
      description:
        "Send a text message in a conversation as an operator. The message is visible to the visitor. Use send_conversation_note for internal notes.",
      inputSchema: {
        website_id: z.string(),
        session_id: z.string(),
        content: z.string().describe("Message text (markdown supported)"),
        fingerprint: z.number().int().optional().describe("Optional message fingerprint (defaults to 0)"),
        mentions: z.array(z.string()).optional().describe("Operator user IDs to mention"),
      },
    },
    handle(({ website_id, session_id, content, fingerprint, mentions }) =>
      crisp.sendTextMessageInConversation(website_id, session_id, content, {
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
        website_id: z.string(),
        session_id: z.string(),
      },
    },
    handle(({ website_id, session_id }) => crisp.getConversationState(website_id, session_id)),
  );

  server.registerTool(
    "set_conversation_state",
    {
      description:
        "Change the state of a conversation. Use 'resolved' to resolve, 'unresolved' to reopen as unresolved, or 'pending' to mark pending.",
      inputSchema: {
        website_id: z.string(),
        session_id: z.string(),
        state: z.enum(["pending", "unresolved", "resolved"]).describe("New conversation state"),
      },
    },
    handle(({ website_id, session_id, state }) =>
      crisp.setConversationState(website_id, session_id, state),
    ),
  );

  server.registerTool(
    "set_conversation_segments",
    {
      description:
        "Replace the segments assigned to a conversation. Pass the full desired list of segment names. Pass an empty array to remove all segments.",
      inputSchema: {
        website_id: z.string(),
        session_id: z.string(),
        segments: z.array(z.string()).describe("Full list of segment names to set (replaces existing)"),
      },
    },
    handle(({ website_id, session_id, segments }) =>
      crisp.setConversationSegments(website_id, session_id, segments),
    ),
  );
}
