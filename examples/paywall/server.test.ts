import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaywallServer, ECHO_ROUTE } from "./server.ts";

const CHALLENGE = 'Payment id="c1", method="solana", intent="subscription"';

describe("example paywall", () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function start() {
    const recur = vi.fn(async () =>
      Response.json({
        wwwAuthenticate: CHALLENGE,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    );
    const { server } = createPaywallServer({
      apiKey: "rk_test_key",
      productId: 7,
      baseUrl: "http://recur.test",
      fetch: recur,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    close = () => server.close();
    const { port } = server.address() as AddressInfo;
    return { recur, url: `http://127.0.0.1:${port}` };
  }

  it("answers an unpaid echo with Recur's 402 challenge", async () => {
    const { recur, url } = await start();
    const response = await fetch(`${url}${ECHO_ROUTE}`);
    expect(response.status).toBe(402);
    expect(response.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(recur).toHaveBeenCalledWith(
      "http://recur.test/integration/agents/challenge",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ productId: 7 }) }),
    );
  });

  it("serves only the echo route", async () => {
    const { recur, url } = await start();
    expect((await fetch(`${url}/v1/other`)).status).toBe(404);
    expect(recur).not.toHaveBeenCalled();
  });
});
