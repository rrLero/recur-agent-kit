import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type PaywallOptions, recurPaywall } from "@repo/kit-node";

export const ECHO_ROUTE = "/v1/echo";
export const COMPANY_ROUTE = "/v1/company/";

async function echo(request: Request): Promise<Response> {
  return Response.json({ echo: new URL(request.url).searchParams.get("say") ?? "hello" });
}

export async function sampleCompany(request: Request): Promise<Response> {
  const krs = new URL(request.url).pathname.slice(COMPANY_ROUTE.length);
  if (!/^\d{10}$/.test(krs)) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({
    krs,
    name: "Northside Traders sp. z o.o.",
    status: "active",
    city: "Kraków",
    sample: true,
  });
}

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers))
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  return new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers,
  });
}

async function send(res: ServerResponse, response: Response) {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  res.end(await response.text());
}

export function createPaywallServer(options: PaywallOptions) {
  const paywall = recurPaywall(options);
  const paid = paywall.fetch(echo, { route: ECHO_ROUTE });
  const paidCompany = paywall.fetch(sampleCompany, { route: `${COMPANY_ROUTE}:krs` });
  const server = createServer((req, res) => {
    const request = toRequest(req);
    const path = new URL(request.url).pathname;
    const answer =
      request.method === "GET" && path === ECHO_ROUTE
        ? paid(request)
        : request.method === "GET" && path.startsWith(COMPANY_ROUTE)
          ? paidCompany(request)
          : Promise.resolve(Response.json({ error: "not found" }, { status: 404 }));
    answer.then(
      (response) => send(res, response),
      () => send(res, Response.json({ error: "paywall failed" }, { status: 500 })),
    );
  });
  server.on("close", () => void paywall.close().catch(() => {}));
  return { server, paywall };
}
