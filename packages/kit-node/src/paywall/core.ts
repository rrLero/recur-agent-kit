import { base58Decode } from "./base58.ts";
import { type Binding, parseAuthorization, verifyProof } from "./mpp.ts";

export type PaywallOptions = {
  apiKey: string;
  productId: number;
  baseUrl: string;
  mode?: "stateful" | "stateless";
  cacheMs?: number;
  reportMs?: number;
  onCall?: (call: { wallet: string; method: string; route: string }) => void;
  fetch?: typeof fetch;
};

export type PaywallRequest = { method: string; route: string; headers: Headers };

export type PaywallResult =
  | { ok: true; wallet: string; headers: Headers }
  | { ok: false; status: 402 | 503; headers: Headers; body: string };

export type WaitUntil = (promise: Promise<unknown>) => void;

type Access = {
  active: boolean;
  until: string | null;
  callsLeft: number;
  binding: Binding | null;
};

type Problem = { type: string; title: string; status: number; detail: string };

class RecurUnavailableError extends Error {
  status: number | undefined;

  constructor(status?: number) {
    super(status ? `Recur answered ${status}` : "Recur is unreachable");
    this.status = status;
  }
}

const PROBLEM_BASE = "https://paymentauth.org/problems/";
const USAGE_BATCH = 500;
const MAX_PENDING = 10_000;
const MAX_CACHED = 10_000;
const ROUTE_MAX = 200;
const TITLES = {
  "payment-required": "Payment required",
  "payment-insufficient": "Included calls used up",
  "verification-failed": "Payment verification failed",
  "malformed-credential": "Malformed payment credential",
} as const;

export function routePattern(route: string): string {
  const path = route.split(/[?#]/, 1)[0] ?? "";
  return (path.startsWith("/") ? path : `/${path}`).slice(0, ROUTE_MAX);
}

export function paywallCore(options: PaywallOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const cacheMs = options.cacheMs ?? 30_000;
  const reportMs = options.reportMs ?? 60_000;
  const stateless = options.mode === "stateless";

  const accessCache = new Map<string, { access: Access; fetchedAt: number }>();
  const accessInFlight = new Map<string, Promise<Access>>();
  const pending = new Map<string, { wallet: string; route: string; calls: number }>();
  let flushing: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function recur<T>(path: string, init: RequestInit = {}): Promise<T | undefined> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        ...init,
        headers: { "x-api-key": options.apiKey, "content-type": "application/json" },
      });
    } catch {
      throw new RecurUnavailableError();
    }
    if (!response.ok) throw new RecurUnavailableError(response.status);
    if (response.status === 204) return undefined;
    try {
      return (await response.json()) as T;
    } catch {
      throw new RecurUnavailableError();
    }
  }

  const post = <T>(path: string, body: unknown) =>
    recur<T>(path, { method: "POST", body: JSON.stringify(body) });

  async function freshChallenge(): Promise<string> {
    const issued = await post<{ wwwAuthenticate: string }>("/integration/agents/challenge", {
      productId: options.productId,
    });
    if (!issued) throw new RecurUnavailableError();
    return issued.wwwAuthenticate;
  }

  const pendingCalls = (wallet: string) => {
    let calls = 0;
    for (const entry of pending.values()) if (entry.wallet === wallet) calls += entry.calls;
    return calls;
  };

  async function fetchAccess(wallet: string): Promise<Access> {
    const query = new URLSearchParams({ productId: String(options.productId), wallet });
    const access = await recur<Access>(`/integration/agents/access?${query}`);
    if (!access) throw new RecurUnavailableError();
    access.callsLeft = Math.max(0, access.callsLeft - pendingCalls(wallet));
    accessCache.delete(wallet);
    if (accessCache.size >= MAX_CACHED) accessCache.delete(accessCache.keys().next().value ?? "");
    accessCache.set(wallet, { access, fetchedAt: Date.now() });
    return access;
  }

  async function accessOf(wallet: string): Promise<Access> {
    const now = Date.now();
    const cached = accessCache.get(wallet);
    const until = cached?.access.until ? Date.parse(cached.access.until) : 0;
    if (cached && now < cached.fetchedAt + cacheMs && (!cached.access.active || now < until))
      return cached.access;
    let inFlight = accessInFlight.get(wallet);
    if (!inFlight) {
      inFlight = fetchAccess(wallet).finally(() => accessInFlight.delete(wallet));
      accessInFlight.set(wallet, inFlight);
    }
    try {
      return await inFlight;
    } catch (error) {
      if (cached?.access.active && now < until) return cached.access;
      throw error;
    }
  }

  function count(wallet: string, method: string, route: string) {
    const key = `${wallet} ${route}`;
    const entry = pending.get(key);
    if (entry) entry.calls += 1;
    else if (pending.size < MAX_PENDING) pending.set(key, { wallet, route, calls: 1 });
    options.onCall?.({ wallet, method, route });
  }

  async function sendPending() {
    const batch = [...pending.entries()].map(([key, entry]) => ({ key, ...entry }));
    for (let start = 0; start < batch.length; start += USAGE_BATCH) {
      const chunk = batch.slice(start, start + USAGE_BATCH);
      const settled = await post("/integration/agents/usage", {
        productId: options.productId,
        entries: chunk.map(({ wallet, route, calls }) => ({ wallet, route, calls })),
      }).then(
        () => true,
        (error: unknown) =>
          error instanceof RecurUnavailableError &&
          error.status !== undefined &&
          error.status < 500 &&
          error.status !== 429,
      );
      if (!settled) return;
      for (const { key, calls } of chunk) {
        const entry = pending.get(key);
        if (!entry) continue;
        entry.calls -= calls;
        if (entry.calls <= 0) pending.delete(key);
      }
    }
  }

  async function flush(): Promise<void> {
    while (flushing) await flushing;
    if (pending.size === 0) return;
    flushing = sendPending().finally(() => {
      flushing = undefined;
    });
    return flushing;
  }

  function startReporting() {
    if (timer || stateless) return;
    timer = setInterval(() => void flush().catch(() => {}), reportMs);
    (timer as { unref?: () => void }).unref?.();
  }

  async function refuse(type: keyof typeof TITLES, detail: string): Promise<PaywallResult> {
    const problem: Problem = {
      type: `${PROBLEM_BASE}${type}`,
      title: TITLES[type],
      status: 402,
      detail,
    };
    return payment402(await freshChallenge(), problem);
  }

  async function serve(
    wallet: string,
    request: PaywallRequest,
    headers: Headers,
    waitUntil?: WaitUntil,
  ): Promise<PaywallResult> {
    count(wallet, request.method, routePattern(request.route));
    if (stateless) {
      const reported = flush();
      if (waitUntil) waitUntil(reported);
      else await reported.catch(() => {});
    } else startReporting();
    return { ok: true, wallet, headers };
  }

  async function decide(request: PaywallRequest, waitUntil?: WaitUntil): Promise<PaywallResult> {
    const authorization = request.headers.get("authorization");
    if (!authorization) return refuse("payment-required", "This API needs a subscription");
    const credential = parseAuthorization(authorization);
    if (!credential) return refuse("malformed-credential", "The Payment credential can't be read");

    if (credential.payload.type === "transaction") {
      const activation = await post<
        | { ok: true; paymentReceipt: string; wallet: string }
        | { ok: false; wwwAuthenticate: string; problem: Problem }
      >("/integration/agents/activate", { productId: options.productId, authorization });
      if (!activation) throw new RecurUnavailableError();
      if (!activation.ok) return payment402(activation.wwwAuthenticate, activation.problem);
      accessCache.delete(activation.wallet);
      return serve(
        activation.wallet,
        request,
        new Headers({ "payment-receipt": activation.paymentReceipt }),
        waitUntil,
      );
    }

    if (credential.payload.type !== "proof")
      return refuse("malformed-credential", "Expected a transaction or proof credential");
    const { payer: wallet, signature } = credential.payload.authentication;
    if (byteLength(wallet) !== 32 || byteLength(signature) !== 64)
      return refuse("malformed-credential", "The proof's payer or signature isn't valid base58");
    const access = await accessOf(wallet);
    if (!access.active) return refuse("payment-required", "This wallet has no active subscription");
    if (!(await verifyProof(credential, access.binding)))
      return refuse("verification-failed", "The proof doesn't match this wallet's subscription");
    if (access.callsLeft <= 0)
      return refuse("payment-insufficient", "This period's included calls are used up");
    access.callsLeft -= 1;
    return serve(wallet, request, new Headers(), waitUntil);
  }

  return {
    async check(request: PaywallRequest, context: { waitUntil?: WaitUntil } = {}) {
      try {
        return await decide(request, context.waitUntil);
      } catch (error) {
        if (error instanceof RecurUnavailableError) return unavailable();
        throw error;
      }
    },
    forget(wallet: string) {
      accessCache.delete(wallet);
    },
    flush,
    async close() {
      clearInterval(timer);
      timer = undefined;
      await flush();
    },
  };
}

export type PaywallCore = ReturnType<typeof paywallCore>;

function byteLength(base58: string): number {
  if (base58.length > 100) return -1;
  try {
    return base58Decode(base58).length;
  } catch {
    return -1;
  }
}

function payment402(wwwAuthenticate: string, problem: Problem): PaywallResult {
  return {
    ok: false,
    status: 402,
    headers: new Headers({
      "www-authenticate": wwwAuthenticate,
      "cache-control": "no-store",
      "content-type": "application/problem+json",
    }),
    body: JSON.stringify(problem),
  };
}

function unavailable(): PaywallResult {
  return {
    ok: false,
    status: 503,
    headers: new Headers({
      "cache-control": "no-store",
      "content-type": "application/problem+json",
      "retry-after": "5",
    }),
    body: JSON.stringify({
      type: "about:blank",
      title: "Payment service unavailable",
      status: 503,
      detail: "Subscription checks are unavailable, try again shortly",
    }),
  };
}
