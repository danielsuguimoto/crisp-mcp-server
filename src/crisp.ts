import { z } from "zod";

const CRISP_API_BASE = "https://api.crisp.chat/v1";

const connectedWebsitesSchema = z.object({
  data: z.array(z.object({ website_id: z.string().trim().min(1) })),
});

const WEBSITE_ID_HELP =
  "Pass website_id explicitly, set DEFAULT_WEBSITE_ID, or add ?website_id=... to the MCP URL.";

export type CrispTier = "website" | "plugin";

export class CrispApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
    public readonly path: string,
  ) {
    super(`Crisp API ${status} on ${path}: ${reason}`);
    this.name = "CrispApiError";
  }
}

type QueryValue = string | number | boolean | undefined | null;

interface ConversationSummary {
  state: "pending" | "unresolved" | "resolved";
  updated_at?: number;
  waiting_since?: number;
  unread?: { operator: number; visitor: number };
  assigned?: { user_id: string };
}

interface ConversationMessage {
  type: string;
  from: "user" | "operator";
  timestamp: number;
  fingerprint?: number;
  content: unknown;
  user?: { user_id?: string; nickname?: string };
  automated?: boolean;
  mentions?: string[];
}

function summarizeMessage(message: ConversationMessage) {
  return {
    type: message.type,
    from: message.from,
    timestamp: message.timestamp,
    fingerprint: message.fingerprint ?? null,
    content: message.content,
    user: message.user
      ? { user_id: message.user.user_id ?? null, nickname: message.user.nickname ?? null }
      : null,
    automated: message.automated ?? false,
    mentions: message.mentions ?? [],
  };
}

export class CrispClient {
  private resolvedWebsiteId?: Promise<string>;

  constructor(
    private readonly token: string,
    private readonly tier: CrispTier,
    private readonly defaultWebsiteId?: string,
  ) {}

  async resolveWebsiteId(websiteId?: string): Promise<string> {
    if (websiteId !== undefined) return websiteId;
    const defaultWebsiteId = this.defaultWebsiteId?.trim();
    if (defaultWebsiteId) return defaultWebsiteId;
    return this.resolvedWebsiteId ??= this.discoverWebsiteId();
  }

  private async discoverWebsiteId(): Promise<string> {
    if (this.tier !== "plugin") {
      throw new Error(`Website-tier tokens cannot list connected websites for auto-resolution. ${WEBSITE_ID_HELP}`);
    }

    try {
      const firstPage = connectedWebsitesSchema.parse(await this.listConnectWebsites(1)).data;
      if (firstPage.length === 0) {
        throw new Error("No connected Crisp websites are available.");
      }
      if (firstPage.length > 1) {
        throw new Error("Multiple connected Crisp websites are available.");
      }
      const nextPage = connectedWebsitesSchema.parse(await this.listConnectWebsites(2)).data;
      if (nextPage.length > 0) {
        throw new Error("Multiple connected Crisp websites are available.");
      }
      return firstPage[0].website_id;
    } catch (error) {
      const reason = error instanceof z.ZodError
        ? "Crisp returned an invalid connected websites response."
        : error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot automatically resolve website_id: ${reason} ${WEBSITE_ID_HELP}`);
    }
  }

  private async request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, QueryValue>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(CRISP_API_BASE + path);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Basic ${this.token}`,
      "X-Crisp-Tier": this.tier,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url.toString(), { method, headers, body });

    if (!res.ok) {
      let reason: string;
      try {
        const resBody = (await res.json()) as { reason?: string; error?: string; message?: string };
        reason = resBody.reason ?? resBody.error ?? resBody.message ?? res.statusText;
      } catch {
        reason = res.statusText;
      }
      throw new CrispApiError(res.status, reason, path);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  private patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }

  getWebsite(websiteId: string) {
    return this.get<{ data: unknown }>(`/website/${encodeURIComponent(websiteId)}`);
  }

  listConnectWebsites(page: number, filterConfigured?: boolean, includePlan?: boolean) {
    return this.get<{ data: unknown }>(`/plugin/connect/websites/all/${page}`, {
      filter_configured: filterConfigured === undefined ? undefined : filterConfigured ? 1 : 0,
      include_plan: includePlan === undefined ? undefined : includePlan ? 1 : 0,
    });
  }

  getConnectAccount() {
    return this.get<{ data: unknown }>(`/plugin/connect/account`);
  }

  listWebsiteOperators(websiteId: string) {
    return this.get<{ data: unknown }>(`/website/${encodeURIComponent(websiteId)}/operators/list`);
  }

  listLastActiveWebsiteOperators(websiteId: string) {
    return this.get<{ data: unknown }>(`/website/${encodeURIComponent(websiteId)}/operators/active`);
  }

  getWebsiteOperator(websiteId: string, userId: string) {
    return this.get<{ data: unknown }>(
      `/website/${encodeURIComponent(websiteId)}/operator/${encodeURIComponent(userId)}`,
    );
  }

  listConversations(
    websiteId: string,
    page: number,
    options: {
      per_page?: number;
      include_empty?: 0 | 1;
      filter_inbox_id?: string;
      filter_unread?: 0 | 1;
      filter_resolved?: 0 | 1;
      filter_not_resolved?: 0 | 1;
      filter_mention?: 0 | 1;
      filter_assigned?: string;
      filter_unassigned?: 0 | 1;
      filter_date_start?: string;
      filter_date_end?: string;
      order_date_created?: 0 | 1;
      order_date_updated?: 0 | 1;
      order_date_waiting?: 0 | 1;
    } = {},
  ) {
    return this.get<{ data: unknown }>(
      `/website/${encodeURIComponent(websiteId)}/conversations/${page}`,
      options as Record<string, QueryValue>,
    );
  }

  getConversation(websiteId: string, sessionId: string) {
    return this.get<{ data: ConversationSummary }>(
      `/website/${encodeURIComponent(websiteId)}/conversation/${encodeURIComponent(sessionId)}`,
    );
  }

  getConversationMessages(
    websiteId: string,
    sessionId: string,
    timestamps: { timestamp_before?: string | number; timestamp_after?: string | number; timestamp_around?: string | number } = {},
  ) {
    return this.get<{ data: ConversationMessage[] }>(
      `/website/${encodeURIComponent(websiteId)}/conversation/${encodeURIComponent(sessionId)}/messages`,
      timestamps as Record<string, QueryValue>,
    );
  }

  async getConversationActivity(websiteId: string, sessionId: string, noteLimit = 5) {
    const [conversation, messages] = await Promise.all([
      this.getConversation(websiteId, sessionId),
      this.getConversationMessages(websiteId, sessionId),
    ]);
    const recent = [...messages.data].sort((a, b) => b.timestamp - a.timestamp);
    const notes = recent.filter((message) => message.type === "note");
    const lastOperator = recent.find((message) => message.from === "operator");
    const lastVisitor = recent.find((message) => message.from === "user");

    return {
      data: {
        state: conversation.data.state,
        updated_at: conversation.data.updated_at ?? null,
        waiting_since: conversation.data.waiting_since ?? null,
        unread: conversation.data.unread ?? null,
        assigned: conversation.data.assigned ?? null,
        last_event: recent[0] ? summarizeMessage(recent[0]) : null,
        last_operator_event: lastOperator ? summarizeMessage(lastOperator) : null,
        last_visitor_event: lastVisitor ? summarizeMessage(lastVisitor) : null,
        notes: notes.slice(0, noteLimit).map(summarizeMessage),
        window: {
          scope: "latest_message_batch",
          messages_scanned: recent.length,
          oldest_timestamp: recent.at(-1)?.timestamp ?? null,
          newest_timestamp: recent[0]?.timestamp ?? null,
          notes_truncated: notes.length > noteLimit,
        },
      },
    };
  }

  sendNoteInConversation(
    websiteId: string,
    sessionId: string,
    content: string,
    mentions: string[] = [],
  ) {
    return this.post<{ data: unknown }>(
      `/website/${encodeURIComponent(websiteId)}/conversation/${encodeURIComponent(sessionId)}/message`,
      { type: "note", from: "operator", origin: "chat", content, mentions },
    );
  }

  sendTextMessageInConversation(
    websiteId: string,
    sessionId: string,
    content: string,
    options: { fingerprint?: number; mentions?: string[] } = {},
  ) {
    return this.post<{ data: unknown }>(
      `/website/${encodeURIComponent(websiteId)}/conversation/${encodeURIComponent(sessionId)}/message`,
      {
        type: "text",
        from: "operator",
        origin: "chat",
        content,
        fingerprint: options.fingerprint ?? 0,
        ...(options.mentions && options.mentions.length ? { mentions: options.mentions } : {}),
      },
    );
  }

  getConversationState(websiteId: string, sessionId: string) {
    return this.get<{ data: unknown }>(
      `/website/${encodeURIComponent(websiteId)}/conversation/${encodeURIComponent(sessionId)}/state`,
    );
  }

  setConversationState(
    websiteId: string,
    sessionId: string,
    state: "pending" | "unresolved" | "resolved",
  ) {
    return this.patch<{ data: unknown }>(
      `/website/${encodeURIComponent(websiteId)}/conversation/${encodeURIComponent(sessionId)}/state`,
      { state },
    );
  }

  setConversationSegments(websiteId: string, sessionId: string, segments: string[]) {
    return this.patch<{ data: unknown }>(
      `/website/${encodeURIComponent(websiteId)}/conversation/${encodeURIComponent(sessionId)}/meta`,
      { segments },
    );
  }
}
