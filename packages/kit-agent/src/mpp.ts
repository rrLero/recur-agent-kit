import { rail } from "@repo/solana-client";
import {
  type Address,
  getBase58Decoder,
  isAddress,
  type KeyPairSigner,
  signBytes,
} from "@solana/kit";

export const PROOF_DOMAIN = "mpp-subscription-auth-v1";

export type Challenge = Record<string, string> & {
  id: string;
  realm: string;
  method: string;
  intent: string;
  request: string;
};

export type SubscriptionRequest = {
  amount: bigint;
  plan: Address;
  mint: Address;
  recipient: Address;
  puller: Address;
  feePayer: Address;
  tokenProgram: Address;
  network: string;
  periodHours: bigint;
};

export type Authentication = {
  type: "proof";
  challengeId: string;
  payer: string;
  signature: string;
};

const NETWORK_REFERENCES: Record<string, string> = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
};

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

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function toBase64Url(value: string): string {
  const binary = String.fromCharCode(...new TextEncoder().encode(value));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function parseChallenge(header: string | null): Challenge | null {
  if (!header || !/^\s*Payment\s/i.test(header)) return null;
  const params: Record<string, string> = {};
  for (const [, name, quoted, bare] of header
    .replace(/^\s*Payment\s+/i, "")
    .matchAll(/([A-Za-z][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g))
    if (name && !(name in params)) params[name] = (quoted ?? bare ?? "").replace(/\\(.)/g, "$1");
  const { id, realm, method, intent, request } = params;
  if (!id || realm === undefined || method !== "solana" || intent !== "subscription" || !request)
    return null;
  return { ...params, id, realm, method, intent, request };
}

const UNSIGNED = /^(?:0|[1-9]\d*)$/;

export function readRequest(encoded: string): SubscriptionRequest | null {
  let json: unknown;
  try {
    json = JSON.parse(fromBase64Url(encoded));
  } catch {
    return null;
  }
  if (!isObject(json) || !isObject(json.methodDetails)) return null;
  const details = json.methodDetails;
  const addresses = [
    details.planAddress,
    details.mint,
    json.recipient,
    details.puller,
    details.feePayerKey,
    details.tokenProgram,
  ];
  const hours = details.expectedPeriodHours;
  if (
    typeof json.amount !== "string" ||
    !UNSIGNED.test(json.amount) ||
    details.amount !== json.amount ||
    json.currency !== details.mint ||
    details.subscriptionProgram !== rail.SUBSCRIPTIONS_PROGRAM_ADDRESS ||
    details.feePayer !== true ||
    (details.recipient !== undefined && details.recipient !== json.recipient) ||
    typeof hours !== "number" ||
    !Number.isSafeInteger(hours) ||
    hours <= 0 ||
    typeof details.network !== "string" ||
    !addresses.every((value) => typeof value === "string" && isAddress(value))
  )
    return null;
  const [plan, mint, recipient, puller, feePayer, tokenProgram] = addresses as [
    Address,
    Address,
    Address,
    Address,
    Address,
    Address,
  ];
  return {
    amount: BigInt(json.amount),
    plan,
    mint,
    recipient,
    puller,
    feePayer,
    tokenProgram,
    network: details.network,
    periodHours: BigInt(hours),
  };
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

export async function authenticate(
  signer: KeyPairSigner,
  challengeId: string,
  delegation: Address,
): Promise<Authentication> {
  const message = proofMessage({ payer: signer.address, challengeId, delegation });
  const signature = await signBytes(signer.keyPair.privateKey, message);
  return {
    type: "proof",
    challengeId,
    payer: signer.address,
    signature: getBase58Decoder().decode(signature),
  };
}

export function sourceOf(network: string, subscriber: Address): string | undefined {
  const reference = NETWORK_REFERENCES[network];
  return reference ? `did:pkh:solana:${reference}:${subscriber}` : undefined;
}

export function credentialHeader(credential: {
  challenge: Challenge;
  source?: string | undefined;
  payload: Record<string, unknown>;
}): string {
  return `Payment ${toBase64Url(JSON.stringify(credential))}`;
}
