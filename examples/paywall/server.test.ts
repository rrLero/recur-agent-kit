import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPANY_ROUTE, createPaywallServer, ECHO_ROUTE, sampleCompany } from "./server.ts";

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

  it("answers an unpaid company lookup with Recur's 402 challenge", async () => {
    const { recur, url } = await start();
    const response = await fetch(`${url}${COMPANY_ROUTE}0000123456`);
    expect(response.status).toBe(402);
    expect(response.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(recur).toHaveBeenCalledTimes(1);
  });

  it("returns a sample company record for a 10-digit registry number", async () => {
    const record = await sampleCompany(new Request(`http://api.test${COMPANY_ROUTE}0000123456`));
    expect(record.status).toBe(200);
    expect(await record.json()).toMatchObject({ krs: "0000123456", sample: true });
    const missing = await sampleCompany(new Request(`http://api.test${COMPANY_ROUTE}42`));
    expect(missing.status).toBe(404);
  });

  it("serves only the echo and company routes", async () => {
    const { recur, url } = await start();
    expect((await fetch(`${url}/v1/other`)).status).toBe(404);
    expect(recur).not.toHaveBeenCalled();
  });
});
