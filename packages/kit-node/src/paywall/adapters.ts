import { type PaywallOptions, type PaywallResult, paywallCore, type WaitUntil } from "./core.ts";

export type ExpressLikeRequest = {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  route?: { path?: unknown };
};

export type ExpressLikeResponse = {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
};

export type HonoLikeContext = {
  req: { raw: Request; routePath: string };
  header(name: string, value: string): void;
  readonly executionCtx?: { waitUntil(promise: Promise<unknown>): void };
};

export type FetchPaywallOptions = {
  waitUntil?: WaitUntil;
  route?: string | ((request: Request) => string);
};

const refusal = (result: Extract<PaywallResult, { ok: false }>) =>
  new Response(result.body, { status: result.status, headers: result.headers });

const UNKNOWN_ROUTE = "/*";

const expressRoute = (req: ExpressLikeRequest) =>
  typeof req.route?.path === "string" ? req.route.path : UNKNOWN_ROUTE;

function honoWaitUntil(c: HonoLikeContext): WaitUntil | undefined {
  try {
    const context = c.executionCtx;
    return context ? (promise) => context.waitUntil(promise) : undefined;
  } catch {
    return undefined;
  }
}

function toHeaders(raw: ExpressLikeRequest["headers"]): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw))
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  return headers;
}

export function recurPaywall(options: PaywallOptions) {
  const core = paywallCore(options);

  return {
    ...core,
    express() {
      return (
        req: ExpressLikeRequest,
        res: ExpressLikeResponse,
        next: (error?: unknown) => void,
      ) => {
        core
          .check({ method: req.method, route: expressRoute(req), headers: toHeaders(req.headers) })
          .then((result) => {
            result.headers.forEach((value, name) => {
              res.setHeader(name, value);
            });
            if (result.ok) return next();
            res.statusCode = result.status;
            res.end(result.body);
          }, next);
      };
    },
    hono() {
      return async (
        c: HonoLikeContext,
        next: () => Promise<void>,
      ): Promise<Response | undefined> => {
        const waitUntil = honoWaitUntil(c);
        const result = await core.check(
          { method: c.req.raw.method, route: c.req.routePath, headers: c.req.raw.headers },
          waitUntil ? { waitUntil } : {},
        );
        if (!result.ok) return refusal(result);
        await next();
        result.headers.forEach((value, name) => {
          c.header(name, value);
        });
      };
    },
    fetch(
      handler: (request: Request) => Response | Promise<Response>,
      fetchOptions: FetchPaywallOptions = {},
    ) {
      return async (request: Request): Promise<Response> => {
        const { route } = fetchOptions;
        const result = await core.check(
          {
            method: request.method,
            route: typeof route === "function" ? route(request) : (route ?? UNKNOWN_ROUTE),
            headers: request.headers,
          },
          fetchOptions,
        );
        if (!result.ok) return refusal(result);
        const response = await handler(request);
        if ([...result.headers.keys()].length === 0) return response;
        const served = new Response(response.body, response);
        result.headers.forEach((value, name) => {
          served.headers.set(name, value);
        });
        return served;
      };
    },
  };
}

export type RecurPaywall = ReturnType<typeof recurPaywall>;
