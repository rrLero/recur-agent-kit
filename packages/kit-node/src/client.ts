import type { Access } from "./types.ts";

const IDENTITY_KIND = "app";

export class RecurApiError extends Error {
  status: number;
  code: string | undefined;

  constructor(status: number, code: string | undefined) {
    super(code ? `API request failed (${status} ${code})` : `API request failed (${status})`);
    this.status = status;
    this.code = code;
  }
}

export function createClient(options: { apiKey: string; baseUrl: string; fetch?: typeof fetch }) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await doFetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "x-api-key": options.apiKey, "content-type": "application/json" },
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code = (body as { code?: unknown } | undefined)?.code;
      throw new RecurApiError(response.status, typeof code === "string" ? code : undefined);
    }
    return body as T;
  }

  async function getAccess(userId: string, productId: number): Promise<Access> {
    const query = new URLSearchParams({
      productId: String(productId),
      kind: IDENTITY_KIND,
      externalId: userId,
    });
    return request<Access>(`/integration/access?${query}`);
  }

  return {
    async createCheckout(userId: string, productId: number): Promise<string> {
      const { url } = await request<{ url: string }>("/identities/link-codes", {
        method: "POST",
        body: JSON.stringify({ kind: IDENTITY_KIND, externalId: userId, productId }),
      });
      return url;
    },
    getAccess,
    async hasAccess(userId: string, productId: number): Promise<boolean> {
      return (await getAccess(userId, productId)).active;
    },
  };
}
