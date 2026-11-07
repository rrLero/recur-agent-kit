import { base58Decode } from "./base58.ts";

export const PROOF_DOMAIN = "mpp-subscription-auth-v1";

export type Credential = {
  challenge: Record<string, unknown>;
  source?: string;
  payload: {
    type: string;
    subscriptionDelegation?: string;
    authentication: { type: string; challengeId: string; payer: string; signature: string };
  };
};

export type Binding = { challengeId: string; signature: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value))
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function proofMessage(input: {
  payer: string;
  challengeId: string;
  delegation: string;
}): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    canonicalJson({
      domain: PROOF_DOMAIN,
      payer: input.payer,
      subscriptionChallengeId: input.challengeId,
      subscriptionDelegation: input.delegation,
    }),
  );
}

export function parseAuthorization(header: string): Credential | null {
  const match = /^Payment\s+([A-Za-z0-9_-]+)\s*$/i.exec(header);
  if (!match?.[1]) return null;
  try {
    const padded = match[1].replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
    const json: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))),
    );
    if (!isObject(json) || !isObject(json.challenge) || !isObject(json.payload)) return null;
    const { authentication } = json.payload;
    if (
      typeof json.payload.type !== "string" ||
      !isObject(authentication) ||
      typeof authentication.type !== "string" ||
      typeof authentication.challengeId !== "string" ||
      typeof authentication.payer !== "string" ||
      typeof authentication.signature !== "string"
    )
      return null;
    return json as Credential;
  } catch {
    return null;
  }
}

export async function verifyProof(
  credential: Credential,
  binding: Binding | null,
): Promise<boolean> {
  if (!binding || credential.payload.type !== "proof") return false;
  const { authentication, subscriptionDelegation } = credential.payload;
  if (
    typeof subscriptionDelegation !== "string" ||
    authentication.challengeId !== binding.challengeId ||
    authentication.signature !== binding.signature
  )
    return false;
  try {
    const payer = base58Decode(authentication.payer);
    const signature = base58Decode(authentication.signature);
    if (payer.length !== 32 || signature.length !== 64) return false;
    const key = await crypto.subtle.importKey("raw", payer, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      signature,
      proofMessage({
        payer: authentication.payer,
        challengeId: authentication.challengeId,
        delegation: subscriptionDelegation,
      }),
    );
  } catch {
    return false;
  }
}
