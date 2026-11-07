import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhook, WebhookVerificationError } from "./webhook.ts";

const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const id = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const timestamp = "1614265330";
const body = '{"test": 2432232314}';
const signature = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
const headers = {
  "webhook-id": id,
  "webhook-timestamp": timestamp,
  "webhook-signature": signature,
};
const now = () => 1614265330;

describe("verifyWebhook", () => {
  it("verifies_the_standard_webhooks_test_vector", () => {
    expect(verifyWebhook(body, headers, secret, { now })).toEqual({ test: 2432232314 });
  });

  it("accepts_one_valid_signature_among_several", () => {
    const list = { ...headers, "webhook-signature": `v1,AAAA ${signature} v1,BBBB` };
    expect(verifyWebhook(Buffer.from(body), list, secret, { now })).toEqual({ test: 2432232314 });
  });

  it("reads_a_fetch_Headers_object_and_array_header_values", () => {
    expect(verifyWebhook(body, new Headers(headers), secret, { now })).toEqual({
      test: 2432232314,
    });
    const arrays = {
      "Webhook-Id": [id],
      "Webhook-Timestamp": [timestamp],
      "Webhook-Signature": [signature],
    };
    expect(verifyWebhook(body, arrays, secret, { now })).toEqual({ test: 2432232314 });
  });

  it("rejects_a_tampered_body", () => {
    expect(() => verifyWebhook('{"test": 1}', headers, secret, { now })).toThrow(
      expect.objectContaining({ reason: "signature" }),
    );
  });

  it("rejects_a_timestamp_outside_tolerance", () => {
    const late = () => 1614265330 + 301;
    expect(() => verifyWebhook(body, headers, secret, { now: late })).toThrow(
      expect.objectContaining({ reason: "timestamp" }),
    );
    expect(() =>
      verifyWebhook(body, headers, secret, { now: () => 1614265330 + 300 }),
    ).not.toThrow();
  });

  it("rejects_missing_headers", () => {
    expect(() => verifyWebhook(body, {}, secret, { now })).toThrow(
      expect.objectContaining({ reason: "headers" }),
    );
  });

  it("rejects_a_non_json_body", () => {
    const text = "not json";
    const digest = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
      .update(`${id}.${timestamp}.${text}`)
      .digest("base64");
    const signed = { ...headers, "webhook-signature": `v1,${digest}` };
    expect(() => verifyWebhook(text, signed, secret, { now })).toThrow(
      expect.objectContaining({ reason: "json" }),
    );
  });
});
