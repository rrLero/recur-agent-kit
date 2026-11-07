import { afterEach, describe, expect, it, vi } from "vitest";
import { recurPaywall } from "./adapters.ts";
import { base58Encode } from "./base58.ts";
import { proofMessage } from "./mpp.ts";

const BASE = "https://recur.test/api/v1";
const DELEGATION = "8tWbqLkUJoYy7zXc5h2EvCRoaQEv2xnQjUuYhc3rzCgT";
const CHALLENGE = 'Payment id="challenge-1", method="solana", intent="subscription"';

const encode = (body: unknown) =>
  `Payment ${btoa(JSON.stringify(body)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

async function agent(challengeId = "challenge-1") {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as {
    publicKey: InstanceType<typeof CryptoKey>;
    privateKey: InstanceType<typeof CryptoKey>;
  };
  const wallet = base58Encode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const signature = base58Encode(
    new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        pair.privateKey,
        proofMessage({ payer: wallet, challengeId, delegation: DELEGATION }),
      ),
    ),
  );
  const authorization = encode({
    challenge: { id: challengeId },
    payload: {
      type: "proof",
      subscriptionDelegation: DELEGATION,
      authentication: { type: "proof", challengeId, payer: wallet, signature },
    },
  });
  return { wallet, signature, authorization, binding: { challengeId, signature } };
}

type AccessAnswer = {
  active: boolean;
  until: string | null;
  callsLeft: number;
  binding: { challengeId: string; signature: string } | null;
};

function fakeRecur() {
  const state = {
    down: false,
    usageFails: false,
    html: false,
    activateStatus: 200,
    access: new Map<string, AccessAnswer>(),
    activation: undefined as unknown,
    calls: [] as { path: string; body: unknown; apiKey: string | null }[],
  };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    state.calls.push({ path, body, apiKey: new Headers(init?.headers).get("x-api-key") });
    if (state.down) throw new TypeError("fetch failed");
    if (state.html) return new Response("<html>proxy</html>", { status: 200 });
    if (state.usageFails && path === "/integration/agents/usage")
      throw new TypeError("fetch failed");
    if (path === "/integration/agents/activate" && state.activateStatus !== 200)
      return Response.json({ code: "sponsorPaused" }, { status: state.activateStatus });
    const json = (value: unknown) => Response.json(value);
    if (path === "/integration/agents/challenge")
      return json({
        wwwAuthenticate: CHALLENGE,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
    if (path === "/integration/agents/activate") return json(state.activation);
    if (path === "/integration/agents/access") {
      const access = state.access.get(url.searchParams.get("wallet") ?? "");
      return json({
        status: access?.active ? "active" : "none",
        source: access?.active ? "paid" : null,
        includedCalls: 1000,
        ...(access ?? { active: false, until: null, callsLeft: 0, binding: null }),
      });
    }
    if (path === "/integration/agents/usage") return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  });
  const callsTo = (path: string) => state.calls.filter((call) => call.path === path);
  return { state, fetch: fetch as unknown as typeof globalThis.fetch, callsTo };
}

const future = () => new Date(Date.now() + 86_400_000).toISOString();

function setup(options: { mode?: "stateful" | "stateless"; cacheMs?: number } = {}) {
  const recur = fakeRecur();
  const paywall = recurPaywall({
    apiKey: "rk_test",
    productId: 7,
    baseUrl: `${BASE}/`,
    fetch: recur.fetch,
    ...options,
  });
  const handler = paywall.fetch(() => new Response("served"), {
    route: (request) =>
      new URL(request.url).pathname.startsWith("/users/") ? "/users/:id" : "/search",
  });
  const call = (authorization?: string, path = "/search?q=1") =>
    handler(
      new Request(`https://merchant.test${path}`, {
        headers: authorization ? { authorization } : {},
      }),
    );
  return { recur, paywall, call };
}

afterEach(() => vi.useRealTimers());

describe("recurPaywall", () => {
  it("402s with Recur's challenge", async () => {
    const { recur, call } = setup();
    const first = await call();
    expect(first.status).toBe(402);
    expect(first.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("content-type")).toBe("application/problem+json");
    expect(await first.json()).toMatchObject({
      type: "https://paymentauth.org/problems/payment-required",
      status: 402,
    });
    expect((await call("Payment !!!")).status).toBe(402);
    expect(recur.callsTo("/integration/agents/challenge")).toHaveLength(2);
    expect(recur.state.calls[0]).toMatchObject({ body: { productId: 7 }, apiKey: "rk_test" });
  });

  it("forwards an activation and returns the receipt", async () => {
    const { recur, call } = setup();
    const authorization = encode({
      challenge: { id: "challenge-1" },
      payload: {
        type: "transaction",
        transaction: "AQID",
        authentication: { type: "proof", challengeId: "challenge-1", payer: "w", signature: "s" },
      },
    });
    recur.state.activation = {
      ok: false,
      status: 402,
      wwwAuthenticate: 'Payment id="fresh"',
      problem: {
        type: "https://paymentauth.org/problems/invalid-challenge",
        title: "Invalid payment challenge",
        status: 402,
        detail: "used",
      },
    };
    const refused = await call(authorization);
    expect(refused.status).toBe(402);
    expect(refused.headers.get("www-authenticate")).toBe('Payment id="fresh"');
    expect(await refused.json()).toMatchObject({ detail: "used" });

    recur.state.activation = {
      ok: true,
      paymentReceipt: "receipt-1",
      wallet: "Wallet1",
      paidUntil: future(),
    };
    const served = await call(authorization);
    expect(served.status).toBe(200);
    expect(served.headers.get("payment-receipt")).toBe("receipt-1");
    expect(await served.text()).toBe("served");
    expect(recur.callsTo("/integration/agents/activate")[1]?.body).toEqual({
      productId: 7,
      authorization,
    });
  });

  it("serves a valid bound proof", async () => {
    const { recur, call } = setup();
    const { wallet, authorization, binding } = await agent();
    recur.state.access.set(wallet, { active: true, until: future(), callsLeft: 5, binding });
    expect((await call(authorization)).status).toBe(200);
    expect((await call(authorization)).status).toBe(200);
    expect(recur.callsTo("/integration/agents/access")).toHaveLength(1);
  });

  it("402s an unbound proof", async () => {
    const { recur, call } = setup();
    const { wallet, authorization } = await agent();
    const other = await agent();
    recur.state.access.set(wallet, { active: true, until: future(), callsLeft: 5, binding: null });
    const unbound = await call(authorization);
    expect(unbound.status).toBe(402);
    expect(await unbound.json()).toMatchObject({
      type: "https://paymentauth.org/problems/verification-failed",
    });
    recur.state.access.set(other.wallet, {
      active: true,
      until: future(),
      callsLeft: 5,
      binding: { challengeId: "challenge-1", signature: (await agent()).signature },
    });
    expect((await call(other.authorization)).status).toBe(402);
  });

  it("402s once included calls are used", async () => {
    const { recur, paywall, call } = setup();
    const { wallet, authorization, binding } = await agent();
    recur.state.access.set(wallet, { active: true, until: future(), callsLeft: 2, binding });
    expect((await call(authorization)).status).toBe(200);
    expect((await call(authorization)).status).toBe(200);
    const used = await call(authorization);
    expect(used.status).toBe(402);
    expect(used.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(await used.json()).toMatchObject({
      type: "https://paymentauth.org/problems/payment-insufficient",
    });
    await paywall.close();
    expect(recur.callsTo("/integration/agents/usage")[0]?.body).toEqual({
      productId: 7,
      entries: [{ wallet, route: "/search", calls: 2 }],
    });
  });

  it("fails closed for unknown wallets when Recur is down", async () => {
    const { recur, call } = setup();
    const { authorization } = await agent();
    recur.state.down = true;
    const response = await call(authorization);
    expect(response.status).toBe(503);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect((await call()).status).toBe(503);
  });

  it("keeps serving a cached wallet when Recur is down", async () => {
    vi.useFakeTimers();
    const { recur, call } = setup({ cacheMs: 1000 });
    const { wallet, authorization, binding } = await agent();
    recur.state.access.set(wallet, { active: true, until: future(), callsLeft: 5, binding });
    expect((await call(authorization)).status).toBe(200);
    recur.state.down = true;
    vi.advanceTimersByTime(5000);
    expect((await call(authorization)).status).toBe(200);
    expect(recur.callsTo("/integration/agents/access")).toHaveLength(2);
  });

  it("batches usage per route pattern in stateful mode", async () => {
    const { recur, paywall, call } = setup();
    const { wallet, authorization, binding } = await agent();
    recur.state.access.set(wallet, { active: true, until: future(), callsLeft: 10, binding });
    await call(authorization, "/users/1");
    await call(authorization, "/users/2?x=1");
    await call(authorization, "/search?q=secret");
    expect(recur.callsTo("/integration/agents/usage")).toHaveLength(0);
    recur.state.down = true;
    await paywall.flush();
    recur.state.down = false;
    await paywall.close();
    const reports = recur.callsTo("/integration/agents/usage");
    expect(reports).toHaveLength(2);
    expect(reports.at(-1)?.body).toEqual({
      productId: 7,
      entries: [
        { wallet, route: "/users/:id", calls: 2 },
        { wallet, route: "/search", calls: 1 },
      ],
    });
    expect(JSON.stringify(recur.state.calls)).not.toContain(authorization);
  });

  it("stateless mode reports through waitUntil", async () => {
    const recur = fakeRecur();
    const paywall = recurPaywall({
      apiKey: "rk_test",
      productId: 7,
      baseUrl: BASE,
      mode: "stateless",
      fetch: recur.fetch,
    });
    const { wallet, authorization, binding } = await agent();
    recur.state.access.set(wallet, { active: true, until: future(), callsLeft: 10, binding });
    const background: Promise<unknown>[] = [];
    const handler = paywall.fetch(() => new Response("served"), {
      waitUntil: (promise) => background.push(promise),
    });
    const response = await handler(
      new Request("https://merchant.test/v1/quotes?symbol=SOL", { headers: { authorization } }),
    );
    expect(response.status).toBe(200);
    expect(background).toHaveLength(1);
    await Promise.all(background);
    expect(recur.callsTo("/integration/agents/usage")[0]?.body).toEqual({
      productId: 7,
      entries: [{ wallet, route: "/*", calls: 1 }],
    });
  });

  it("forget drops the cache", async () => {
    const { recur, paywall, call } = setup();
    const { wallet, authorization, binding } = await agent();
    recur.state.access.set(wallet, { active: true, until: future(), callsLeft: 5, binding });
    expect((await call(authorization)).status).toBe(200);
    recur.state.access.set(wallet, { active: false, until: null, callsLeft: 0, binding });
    paywall.forget(wallet);
    expect((await call(authorization)).status).toBe(402);
    expect(recur.callsTo("/integration/agents/access")).toHaveLength(2);
  });
});

const transactionAuthorization = encode({
  challenge: { id: "challenge-1" },
  payload: {
    type: "transaction",
    transaction: "AQID",
    authentication: { type: "proof", challengeId: "challenge-1", payer: "w", signature: "s" },
  },
});

describe("recurPaywall failures", () => {
  it("402s a proof whose payer isn't a 32-byte key without asking Recur", async () => {
    const { recur, call } = setup();
    const { signature } = await agent();
    for (const payer of ["not-base58-0OIl", "1111"]) {
      const response = await call(
        encode({
          challenge: { id: "challenge-1" },
          payload: {
            type: "proof",
            subscriptionDelegation: DELEGATION,
            authentication: { type: "proof", challengeId: "challenge-1", payer, signature },
          },
        }),
      );
      expect(response.status).toBe(402);
      expect(response.headers.get("www-authenticate")).toBe(CHALLENGE);
      expect(await response.json()).toMatchObject({
        type: "https://paymentauth.org/problems/malformed-credential",
      });
    }
    expect(recur.callsTo("/integration/agents/access")).toHaveLength(0);
  });

  it("answers 503 when Recur answers 200 with a non-JSON body", async () => {
    const { recur, call } = setup();
    recur.state.html = true;
    const response = await call();
    expect(response.status).toBe(503);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("answers 503 without a challenge when activate is refused by Recur", async () => {
    const { recur, call } = setup();
    recur.state.activateStatus = 503;
    const response = await call(transactionAuthorization);
    expect(response.status).toBe(503);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("serves the call when a stateless usage report fails", async () => {
    const recur = fakeRecur();
    const paywall = recurPaywall({
      apiKey: "rk_test",
      productId: 7,
      baseUrl: BASE,
      mode: "stateless",
      fetch: recur.fetch,
    });
    const { wallet, authorization, binding } = await agent();
    recur.state.access.set(wallet, { active: true, until: future(), callsLeft: 10, binding });
    recur.state.usageFails = true;
    const handler = paywall.fetch(() => new Response("served"));
    const response = await handler(
      new Request("https://merchant.test/v1/quotes", { headers: { authorization } }),
    );
    expect(response.status).toBe(200);
    expect(recur.callsTo("/integration/agents/usage")).toHaveLength(1);
  });
});

describe("adapters", () => {
  function express(paywall: ReturnType<typeof recurPaywall>) {
    return (headers: Record<string, string>, route?: { path: string }) =>
      new Promise<{ status: number; headers: Record<string, string>; next: boolean }>((resolve) => {
        const res = {
          statusCode: 200,
          headers: {} as Record<string, string>,
          setHeader(name: string, value: string) {
            res.headers[name] = value;
          },
          end: () => resolve({ status: res.statusCode, headers: res.headers, next: false }),
        };
        const req = {
          method: "GET",
          headers,
          baseUrl: "/tenants/acme",
          path: "/users/9",
          ...(route && { route }),
        };
        paywall.express()(req, res, () =>
          resolve({ status: res.statusCode, headers: res.headers, next: true }),
        );
      });
  }

  it("express reports the route pattern and never the concrete mount path", async () => {
    const { recur, paywall } = setup();
    const { wallet, authorization, binding } = await agent();
    recur.state.access.set(wallet, { active: true, until: future(), callsLeft: 5, binding });
    const run = express(paywall);
    expect(await run({}, { path: "/users/:id" })).toMatchObject({
      status: 402,
      next: false,
      headers: { "www-authenticate": CHALLENGE },
    });
    expect(await run({ authorization }, { path: "/users/:id" })).toMatchObject({
      status: 200,
      next: true,
    });
    await paywall.close();
    expect(recur.callsTo("/integration/agents/usage")[0]?.body).toMatchObject({
      entries: [{ wallet, route: "/users/:id", calls: 1 }],
    });
    expect(JSON.stringify(recur.state.calls)).not.toContain("acme");
  });

  it("express mounted app-wide reports /*", async () => {
    const { recur, paywall } = setup();
    const { wallet, authorization, binding } = await agent();
    recur.state.access.set(wallet, { active: true, until: future(), callsLeft: 5, binding });
    expect(await express(paywall)({ authorization })).toMatchObject({ next: true });
    await paywall.close();
    expect(recur.callsTo("/integration/agents/usage")[0]?.body).toMatchObject({
      entries: [{ wallet, route: "/*", calls: 1 }],
    });
  });

  it("fetch without a route option reports /*", async () => {
    const recur = fakeRecur();
    const paywall = recurPaywall({
      apiKey: "rk_test",
      productId: 7,
      baseUrl: BASE,
      fetch: recur.fetch,
    });
    const { wallet, authorization, binding } = await agent();
    recur.state.access.set(wallet, { active: true, until: future(), callsLeft: 5, binding });
    const handler = paywall.fetch(() => new Response("served"));
    await handler(new Request("https://merchant.test/users/42", { headers: { authorization } }));
    await paywall.close();
    expect(recur.callsTo("/integration/agents/usage")[0]?.body).toMatchObject({
      entries: [{ wallet, route: "/*", calls: 1 }],
    });
  });

  it("hono returns the 402 response and calls next for a served call", async () => {
    const { recur, paywall } = setup();
    const { wallet, authorization, binding } = await agent();
    recur.state.access.set(wallet, { active: true, until: future(), callsLeft: 5, binding });
    const next = vi.fn(async () => {});
    const context = (headers: Record<string, string>) => ({
      req: {
        raw: new Request("https://merchant.test/items/3", { headers }),
        routePath: "/items/:id",
      },
      header: vi.fn(),
      get executionCtx(): never {
        throw new Error("This context has no ExecutionContext");
      },
    });
    const refused = await paywall.hono()(context({}), next);
    expect(refused?.status).toBe(402);
    expect(next).not.toHaveBeenCalled();
    expect(await paywall.hono()(context({ authorization }), next)).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    await paywall.close();
    expect(recur.callsTo("/integration/agents/usage")[0]?.body).toMatchObject({
      entries: [{ wallet, route: "/items/:id", calls: 1 }],
    });
  });

  it("hono in stateless mode reports through executionCtx.waitUntil", async () => {
    const recur = fakeRecur();
    const paywall = recurPaywall({
      apiKey: "rk_test",
      productId: 7,
      baseUrl: BASE,
      mode: "stateless",
      fetch: recur.fetch,
    });
    const { wallet, authorization, binding } = await agent();
    recur.state.access.set(wallet, { active: true, until: future(), callsLeft: 5, binding });
    const background: Promise<unknown>[] = [];
    await paywall.hono()(
      {
        req: {
          raw: new Request("https://merchant.test/items/3", { headers: { authorization } }),
          routePath: "/items/:id",
        },
        header: vi.fn(),
        executionCtx: { waitUntil: (promise) => background.push(promise) },
      },
      async () => {},
    );
    expect(background).toHaveLength(1);
    await Promise.all(background);
    expect(recur.callsTo("/integration/agents/usage")).toHaveLength(1);
  });
});
