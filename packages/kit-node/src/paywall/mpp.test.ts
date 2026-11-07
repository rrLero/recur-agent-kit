import { describe, expect, it } from "vitest";
import { base58Encode } from "./base58.ts";
import { parseAuthorization, proofMessage, verifyProof } from "./mpp.ts";

const DELEGATION = "8tWbqLkUJoYy7zXc5h2EvCRoaQEv2xnQjUuYhc3rzCgT";
const VECTOR_PAYER = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
const VECTOR_SIGNATURE =
  "3ssiaRqzst4x5uFHHNadbzV8UHr6yD8Fe5AxFLyPUtfuC8bk2JRUa2Hshjebn9X7kD195pwRzbhAJxcKe8LRioec";

async function signedCredential(challengeId = "challenge-1", delegation = DELEGATION) {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as {
    publicKey: InstanceType<typeof CryptoKey>;
    privateKey: InstanceType<typeof CryptoKey>;
  };
  const payer = base58Encode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const message = proofMessage({ payer, challengeId, delegation });
  const signature = base58Encode(
    new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, message)),
  );
  const credential = {
    challenge: { id: challengeId },
    payload: {
      type: "proof",
      subscriptionDelegation: delegation,
      authentication: { type: "proof", challengeId, payer, signature },
    },
  };
  return { credential, payer, signature };
}

const header = (body: unknown) =>
  `Payment ${btoa(JSON.stringify(body)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

describe("proofMessage", () => {
  it("matches the pay-kit vector bytes", () => {
    const payer = "PayerKey1111111111111111111111111111111111";
    expect(
      new TextDecoder().decode(
        proofMessage({ payer, challengeId: "challenge-1", delegation: DELEGATION }),
      ),
    ).toBe(
      `{"domain":"mpp-subscription-auth-v1","payer":"${payer}","subscriptionChallengeId":"challenge-1","subscriptionDelegation":"${DELEGATION}"}`,
    );
  });
});

describe("parseAuthorization", () => {
  it("parses a credential and returns null otherwise", async () => {
    const { credential } = await signedCredential();
    expect(parseAuthorization(header(credential))).toEqual(credential);
    expect(parseAuthorization("Bearer abc")).toBeNull();
    expect(parseAuthorization("Payment !!!")).toBeNull();
    expect(parseAuthorization(header({ nope: true }))).toBeNull();
  });
});

describe("verifyProof", () => {
  it("pay-kit proof vector verifies", async () => {
    const credential = {
      challenge: { id: "challenge-1" },
      payload: {
        type: "proof",
        subscriptionDelegation: DELEGATION,
        authentication: {
          type: "proof",
          challengeId: "challenge-1",
          payer: VECTOR_PAYER,
          signature: VECTOR_SIGNATURE,
        },
      },
    };
    const binding = { challengeId: "challenge-1", signature: VECTOR_SIGNATURE };
    expect(await verifyProof(credential, binding)).toBe(true);
  });

  it("a proof signed with a fresh key verifies", async () => {
    const { credential, signature } = await signedCredential();
    expect(await verifyProof(credential, { challengeId: "challenge-1", signature })).toBe(true);
  });

  it("tampered signature fails", async () => {
    const { credential, signature } = await signedCredential();
    const other = await signedCredential();
    const tampered = {
      ...credential,
      payload: {
        ...credential.payload,
        authentication: { ...credential.payload.authentication, signature: other.signature },
      },
    };
    expect(
      await verifyProof(tampered, { challengeId: "challenge-1", signature: other.signature }),
    ).toBe(false);
    expect(await verifyProof(tampered, { challengeId: "challenge-1", signature })).toBe(false);
  });

  it("proof bound to another challenge fails", async () => {
    const { credential, signature } = await signedCredential();
    expect(await verifyProof(credential, { challengeId: "challenge-2", signature })).toBe(false);
    expect(await verifyProof(credential, null)).toBe(false);
  });

  it("changed delegation fails and malformed keys never throw", async () => {
    const { credential, signature } = await signedCredential();
    const binding = { challengeId: "challenge-1", signature };
    const moved = {
      ...credential,
      payload: {
        ...credential.payload,
        subscriptionDelegation: "9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ",
      },
    };
    expect(await verifyProof(moved, binding)).toBe(false);
    const broken = {
      ...credential,
      payload: {
        ...credential.payload,
        authentication: { ...credential.payload.authentication, payer: "0OIl" },
      },
    };
    expect(await verifyProof(broken, binding)).toBe(false);
  });
});
