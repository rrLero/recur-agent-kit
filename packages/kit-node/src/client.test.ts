import { describe, expect, it } from "vitest";
import { createClient, RecurApiError } from "./client.ts";

const baseUrl = "http://localhost:3000/api/v1";

function stub(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fakeFetch };
}

describe("createClient", () => {
  it("createCheckout_posts_the_app_identity_and_returns_the_url", async () => {
    const { calls, fakeFetch } = stub(200, { url: "https://x.test/link/abc" });
    const client = createClient({ apiKey: "k", baseUrl, fetch: fakeFetch });
    expect(await client.createCheckout("u1", 7)).toBe("https://x.test/link/abc");
    expect(calls[0]?.url).toBe(`${baseUrl}/identities/link-codes`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("x-api-key")).toBe("k");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      kind: "app",
      externalId: "u1",
      productId: 7,
    });
  });

  it("getAccess_calls_integration_access_with_kind_app", async () => {
    const access = { active: true, status: "active", source: "paid", until: null, wallet: null };
    const { calls, fakeFetch } = stub(200, access);
    const client = createClient({ apiKey: "k", baseUrl, fetch: fakeFetch });
    expect(await client.getAccess("u1", 7)).toEqual(access);
    expect(calls[0]?.url).toBe(`${baseUrl}/integration/access?productId=7&kind=app&externalId=u1`);
  });

  it("hasAccess_returns_active_only", async () => {
    const grace = stub(200, { active: true, status: "grace" });
    expect(
      await createClient({ apiKey: "k", baseUrl, fetch: grace.fakeFetch }).hasAccess("u", 1),
    ).toBe(true);
    const expired = stub(200, { active: false, status: "expired" });
    expect(
      await createClient({ apiKey: "k", baseUrl, fetch: expired.fakeFetch }).hasAccess("u", 1),
    ).toBe(false);
  });

  it("a_non_2xx_throws_RecurApiError_with_status_and_code", async () => {
    const { fakeFetch } = stub(401, { code: "invalidApiKey" });
    const client = createClient({ apiKey: "k", baseUrl, fetch: fakeFetch });
    const error = await client.getAccess("u", 1).catch((caught) => caught);
    expect(error).toBeInstanceOf(RecurApiError);
    expect(error.status).toBe(401);
    expect(error.code).toBe("invalidApiKey");
  });

  it("baseUrl_trailing_slash_is_tolerated", async () => {
    const { calls, fakeFetch } = stub(200, { url: "u" });
    await createClient({ apiKey: "k", baseUrl: `${baseUrl}/`, fetch: fakeFetch }).createCheckout(
      "u",
      1,
    );
    expect(calls[0]?.url).toBe(`${baseUrl}/identities/link-codes`);
  });
});
