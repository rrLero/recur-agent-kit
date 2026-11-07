import { createPaywallServer, ECHO_ROUTE } from "./server.ts";

const apiKey = process.env.RECUR_API_KEY;
const productId = Number(process.env.RECUR_PRODUCT_ID);
if (!apiKey || !Number.isInteger(productId)) throw new Error("set RECUR_API_KEY and RECUR_PRODUCT_ID");

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4901);
const { server } = createPaywallServer({
  apiKey,
  productId,
  baseUrl: process.env.RECUR_API_URL ?? "http://localhost:4000",
});
server.listen(port, host, () => console.log(`paywall on http://${host}:${port}${ECHO_ROUTE}`));
