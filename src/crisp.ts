const CRISP_API_BASE = "https://api.crisp.chat/v1";

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

export class CrispClient {
  constructor(
    private readonly token: string,
    private readonly tier: CrispTier,
  ) {}

  private async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    const url = new URL(CRISP_API_BASE + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Basic ${this.token}`,
        "X-Crisp-Tier": this.tier,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      let reason: string;
      try {
        const body = (await res.json()) as { reason?: string; error?: string; message?: string };
        reason = body.reason ?? body.error ?? body.message ?? res.statusText;
      } catch {
        reason = res.statusText;
      }
      throw new CrispApiError(res.status, reason, path);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
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
    return this.get<{ data: unknown }>(
      `/website/${encodeURIComponent(websiteId)}/conversation/${encodeURIComponent(sessionId)}`,
    );
  }

  getConversationMessages(
    websiteId: string,
    sessionId: string,
    timestamps: { timestamp_before?: string | number; timestamp_after?: string | number; timestamp_around?: string | number } = {},
  ) {
    return this.get<{ data: unknown }>(
      `/website/${encodeURIComponent(websiteId)}/conversation/${encodeURIComponent(sessionId)}/messages`,
      timestamps as Record<string, QueryValue>,
    );
  }
}
