import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookEvent } from "./types.ts";

const DEFAULT_TOLERANCE_SECONDS = 300;

export type WebhookFailureReason = "headers" | "timestamp" | "signature" | "json";

export class WebhookVerificationError extends Error {
  reason: WebhookFailureReason;

  constructor(message: string, reason: WebhookFailureReason) {
    super(message);
    this.reason = reason;
  }
}

type HeaderInput = Headers | Record<string, string | string[] | undefined>;

function readHeader(headers: HeaderInput, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? value[0] : value;
}

export function verifyWebhook(
  rawBody: string | Buffer,
  headers: HeaderInput,
  secret: string,
  options: { toleranceSeconds?: number; now?: () => number } = {},
): WebhookEvent {
  const id = readHeader(headers, "webhook-id");
  const timestamp = readHeader(headers, "webhook-timestamp");
  const signatures = readHeader(headers, "webhook-signature");
  if (!id || !signatures || !timestamp || !Number.isInteger(Number(timestamp))) {
    throw new WebhookVerificationError("missing or malformed webhook headers", "headers");
  }
  const nowSeconds = options.now ? options.now() : Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - Number(timestamp)) > tolerance) {
    throw new WebhookVerificationError("timestamp outside tolerance", "timestamp");
  }
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const digest = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  const expected = Buffer.from(`v1,${digest}`);
  const valid = signatures.split(" ").some((candidate) => {
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) throw new WebhookVerificationError("no matching signature", "signature");
  try {
    return JSON.parse(body) as WebhookEvent;
  } catch {
    throw new WebhookVerificationError("body is not valid JSON", "json");
  }
}
