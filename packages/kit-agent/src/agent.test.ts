import { recurPaywall } from "@repo/kit-node";
import { rail } from "@repo/solana-client";
import {
  type Address,
  createKeyPairSignerFromBytes,
  decompileTransactionMessage,
  generateKeyPair,
  generateKeyPairSigner,
  getAddressFromPublicKey,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Instruction,
} from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { UNKNOWN_INIT_ID } from "./activation.ts";
import { type AgentRpc, recurAgent } from "./agent.ts";

const BASE = "https://recur.test/api/v1";
const URL_ = "https://api.example/v1/data";
const EMPTY = "11111111111111111111111111111111" as Address;
const DAY_PRICE = 1_000_000n;
const MONTHLY = DAY_PRICE * 30n;

type Terms = {
  plan: Address;
  owner: Address;
  mint: Address;
  recipient: Address;
  puller: Address;
  sponsor: Address;
};

let terms: Terms;
let chain: Map<string, Uint8Array>;

const b64url = (value: string) =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (value: string) => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "=")));
};

function requestFor(overrides: Record<string, unknown> = {}) {
  const amount = DAY_PRICE.toString();
  return {
    amount,
    currency: terms.mint,
    periodUnit: "day",
    periodCount: "1",
    recipient: terms.recipient,
    methodDetails: {
      mint: terms.mint,
      decimals: 6,
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      puller: terms.puller,
      planAddress: terms.plan,
      subscriptionProgram: rail.SUBSCRIPTIONS_PROGRAM_ADDRESS,
      network: "devnet",
      feePayer: true,
      feePayerKey: terms.sponsor,
      merchant: terms.owner,
      recipient: terms.recipient,
      amount,
      expectedPeriodHours: 24,
      ...overrides,
    },
  };
}

const rpc = {
  getAccountInfo: (address: string) => ({
    send: async () => {
      const bytes = chain.get(address);
      return {
        context: { slot: 0n },
        value: bytes
          ? {
              data: [getBase64Decoder().decode(bytes), "base64"],
              executable: false,
              lamports: 1n,
              owner: rail.SUBSCRIPTIONS_PROGRAM_ADDRESS,
              space: BigInt(bytes.length),
            }
          : null,
      };
    },
  }),
  getLatestBlockhash: () => ({
    send: async () => ({
      context: { slot: 0n },
      value: { blockhash: EMPTY, lastValidBlockHeight: 0n },
    }),
  }),
} as unknown as AgentRpc;

function putPlan() {
  chain.set(
    terms.plan,
    new Uint8Array(
      rail.getPlanEncoder().encode({
        discriminator: 2,
        owner: terms.owner,
        bump: 254,
        status: 1,
        data: {
          planId: 9n,
          mint: terms.mint,
          terms: { amount: DAY_PRICE, periodHours: 24n, createdAt: 1_700_000_000n },
          endTs: 0n,
          destinations: [terms.recipient, EMPTY, EMPTY, EMPTY],
          pullers: [terms.puller, EMPTY, EMPTY, EMPTY],
          metadataUri: "",
        },
      }),
    ),
  );
}

async function putAuthority(user: Address, initId: bigint) {
  const [address] = await rail.findSubscriptionAuthorityPda({ user, tokenMint: terms.mint });
  chain.set(
    address,
    new Uint8Array(
      rail.getSubscriptionAuthorityEncoder().encode({
        discriminator: 1,
        user,
        tokenMint: terms.mint,
        payer: terms.sponsor,
        bump: 255,
        initId,
      }),
    ),
  );
}

type Activated = {
  credential: {
    challenge: Record<string, string>;
    source?: string;
    payload: {
      transaction: string;
      authentication: { challengeId: string; payer: string; signature: string };
    };
  };
  instructions: Instruction[];
  signers: Record<string, unknown>;
  feePayer: string;
};

function merchant(request: Record<string, unknown> = requestFor()) {
  const state = {
    activations: [] as Activated[],
    access: new Map<string, { active: boolean; binding: unknown }>(),
    seen: [] as (string | null)[],
    subscribed: new Set<string>(),
    failAfterSend: false,
  };
  const challenge = `Payment id="challenge-1", realm="api.example", method="solana", intent="subscription", request="${b64url(JSON.stringify(request))}", expires="2099-01-01T00:00:00.000Z"`;
  const recur = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/integration/agents/challenge")
      return Response.json({ wwwAuthenticate: challenge, expiresAt: "2099-01-01T00:00:00.000Z" });
    if (path === "/integration/agents/activate") {
      const credential = fromB64url(body.authorization.replace(/^Payment /, ""));
      const tx = getTransactionDecoder().decode(
        getBase64Encoder().encode(credential.payload.transaction),
      );
      const message = decompileTransactionMessage(
        getCompiledTransactionMessageDecoder().decode(tx.messageBytes),
      );
      const { payer, challengeId, signature } = credential.payload.authentication;
      state.activations.push({
        credential,
        instructions: [...message.instructions] as Instruction[],
        signers: tx.signatures,
        feePayer: message.feePayer.address,
      });
      if (state.subscribed.has(payer) && state.access.get(payer)?.binding)
        return Response.json({
          ok: false,
          status: 402,
          wwwAuthenticate: challenge,
          problem: {
            type: "https://paymentauth.org/problems/verification-failed",
            title: "Payment verification failed",
            status: 402,
            detail: "This wallet already has a live subscription to this plan",
          },
        });
      state.subscribed.add(payer);
      if (state.failAfterSend) {
        state.failAfterSend = false;
        return Response.json({ code: "internal" }, { status: 500 });
      }
      state.access.set(payer, { active: true, binding: { challengeId, signature } });
      return Response.json({ ok: true, paymentReceipt: "receipt", wallet: payer });
    }
    if (path === "/integration/agents/access") {
      const found = state.access.get(url.searchParams.get("wallet") ?? "");
      return Response.json({
        active: found?.active ?? false,
        until: found?.active ? "2099-01-01T00:00:00.000Z" : null,
        callsLeft: found?.active ? 100 : 0,
        binding: found?.binding ?? null,
      });
    }
    return new Response(null, { status: 204 });
  };
  const paywall = recurPaywall({
    apiKey: "rk_test",
    productId: 1,
    baseUrl: BASE,
    mode: "stateless",
    cacheMs: 0,
    fetch: recur as typeof fetch,
  });
  const handler = paywall.fetch(() => Response.json({ data: 42 }), { route: "/v1/data" });
  const serve = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    state.seen.push(request.headers.get("authorization"));
    return handler(request);
  }) as typeof fetch;
  return { state, serve };
}

const kind = (authorization: string | null) =>
  authorization ? fromB64url(authorization.replace(/^Payment /, "")).payload.type : null;

const railTags = (instructions: Instruction[]) =>
  instructions
    .filter((ix) => ix.programAddress === rail.SUBSCRIPTIONS_PROGRAM_ADDRESS)
    .map((ix) => rail.identifySubscriptionsInstruction(ix.data ?? new Uint8Array()));

async function secretBytes() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as {
    publicKey: InstanceType<typeof CryptoKey>;
    privateKey: InstanceType<typeof CryptoKey>;
  };
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return new Uint8Array([...pkcs8.slice(-32), ...raw]);
}

beforeEach(async () => {
  const keys = await Promise.all(Array.from({ length: 6 }, () => generateKeyPairSigner()));
  const [plan, owner, mint, recipient, puller, sponsor] = keys.map((key) => key.address);
  terms = { plan, owner, mint, recipient, puller, sponsor } as Terms;
  chain = new Map();
  putPlan();
});

describe("recurAgent", () => {
  it("subscribes after a 402 and retries with the proof", async () => {
    const bytes = await secretBytes();
    const wallet = (await createKeyPairSignerFromBytes(bytes)).address;
    const { state, serve } = merchant();
    const agentFetch = recurAgent({
      keypair: bytes,
      rpcUrl: "http://rpc.test",
      budget: { monthly: MONTHLY },
      fetch: serve,
      rpc,
    });

    const response = await agentFetch(URL_);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: 42 });
    expect(response.headers.get("payment-receipt")).toBe("receipt");
    expect(state.seen.map(kind)).toEqual([null, "transaction"]);
    const [activation] = state.activations;
    expect(activation?.feePayer).toBe(terms.sponsor);
    expect(Object.keys(activation?.signers ?? {}).sort()).toEqual(
      [terms.sponsor, terms.puller, wallet].sort(),
    );
    expect(activation?.signers[wallet]).toBeInstanceOf(Uint8Array);
    expect(activation?.signers[terms.sponsor]).toBeNull();
    expect(activation?.signers[terms.puller]).toBeNull();
    expect(activation?.credential.source).toBe(
      `did:pkh:solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${wallet}`,
    );
    expect(activation?.credential.challenge.id).toBe("challenge-1");
    expect(activation?.credential.payload.authentication).toMatchObject({
      challengeId: "challenge-1",
      payer: wallet,
    });
  });

  it("respects the monthly budget", async () => {
    const { state, serve } = merchant();
    const agentFetch = recurAgent({
      keypair: await generateKeyPair(),
      rpcUrl: "http://rpc.test",
      budget: { monthly: MONTHLY - 1n },
      fetch: serve,
      rpc,
    });

    const response = await agentFetch(URL_);

    expect(response.status).toBe(402);
    expect(response.headers.get("www-authenticate")).toContain('id="challenge-1"');
    expect(state.activations).toHaveLength(0);

    const exact = recurAgent({
      keypair: await generateKeyPair(),
      rpcUrl: "http://rpc.test",
      budget: { monthly: MONTHLY },
      fetch: serve,
      rpc,
    });
    expect((await exact(URL_)).status).toBe(200);
  });

  it("refuses a challenge it can't validate before signing", async () => {
    for (const request of [
      requestFor({ subscriptionProgram: terms.owner }),
      { ...requestFor(), currency: terms.owner },
      requestFor({ recipient: terms.owner }),
      { ...requestFor(), recipient: terms.owner },
      requestFor({ feePayer: false }),
      requestFor({ network: undefined }),
    ]) {
      const { state, serve } = merchant(request);
      const agentFetch = recurAgent({
        keypair: await generateKeyPair(),
        rpcUrl: "http://rpc.test",
        budget: { monthly: MONTHLY },
        fetch: serve,
        rpc,
      });
      expect((await agentFetch(URL_)).status).toBe(402);
      expect(state.activations).toHaveLength(0);
    }
  });

  it("reuses the proof on later calls", async () => {
    const pair = await generateKeyPair();
    const wallet = await getAddressFromPublicKey(pair.publicKey);
    const { state, serve } = merchant();
    const agentFetch = recurAgent({
      keypair: pair,
      rpcUrl: "http://rpc.test",
      budget: { monthly: MONTHLY },
      fetch: serve,
      rpc,
    });

    await agentFetch(URL_);
    const later = await agentFetch(URL_, { method: "POST", body: "payload" });

    expect(later.status).toBe(200);
    expect(state.seen.map(kind)).toEqual([null, "transaction", "proof"]);
    expect(state.activations).toHaveLength(1);

    const binding = state.access.get(wallet)?.binding;
    state.access.set(wallet, { active: false, binding });
    const refused = await agentFetch(URL_);
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ detail: expect.stringContaining("live") });
    expect(state.activations).toHaveLength(2);
  });

  it("resumes when Recur failed after sending", async () => {
    const { state, serve } = merchant();
    state.failAfterSend = true;
    const agentFetch = recurAgent({
      keypair: await generateKeyPair(),
      rpcUrl: "http://rpc.test",
      budget: { monthly: MONTHLY },
      fetch: serve,
      rpc,
    });

    expect((await agentFetch(URL_)).status).toBe(503);
    const retried = await agentFetch(URL_);
    const later = await agentFetch(URL_);

    expect(retried.status).toBe(200);
    expect(later.status).toBe(200);
    expect(state.activations).toHaveLength(2);
    expect(state.seen.map(kind)).toEqual([null, "transaction", null, "transaction", "proof"]);
  });

  it("bundles init authority when missing", async () => {
    const missing = merchant();
    await recurAgent({
      keypair: await generateKeyPair(),
      rpcUrl: "http://rpc.test",
      budget: { monthly: MONTHLY },
      fetch: missing.serve,
      rpc,
    })(URL_);
    const bundled = missing.state.activations[0]?.instructions ?? [];
    expect(railTags(bundled)).toEqual([
      rail.SubscriptionsInstruction.InitSubscriptionAuthority,
      rail.SubscriptionsInstruction.Subscribe,
      rail.SubscriptionsInstruction.TransferSubscription,
    ]);
    const subscribeData = (instructions: Instruction[]) =>
      rail
        .getSubscribeInstructionDataDecoder()
        .decode(
          instructions.find(
            (ix) =>
              ix.programAddress === rail.SUBSCRIPTIONS_PROGRAM_ADDRESS &&
              rail.identifySubscriptionsInstruction(ix.data ?? new Uint8Array()) ===
                rail.SubscriptionsInstruction.Subscribe,
          )?.data ?? new Uint8Array(),
        ).subscribeData;
    expect(subscribeData(bundled).expectedSubscriptionAuthorityInitId).toBe(UNKNOWN_INIT_ID);

    const pair = await generateKeyPair();
    await putAuthority(await getAddressFromPublicKey(pair.publicKey), 7n);
    const existing = merchant();
    await recurAgent({
      keypair: pair,
      rpcUrl: "http://rpc.test",
      budget: { monthly: MONTHLY },
      fetch: existing.serve,
      rpc,
    })(URL_);
    const plain = existing.state.activations[0]?.instructions ?? [];
    expect(railTags(plain)).toEqual([
      rail.SubscriptionsInstruction.Subscribe,
      rail.SubscriptionsInstruction.TransferSubscription,
    ]);
    expect(subscribeData(plain).expectedSubscriptionAuthorityInitId).toBe(7n);
  });
});
