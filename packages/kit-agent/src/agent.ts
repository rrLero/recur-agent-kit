import { rail } from "@repo/solana-client";
import {
  type Address,
  createKeyPairSignerFromBytes,
  createSignerFromKeyPair,
  createSolanaRpc,
  type GetAccountInfoApi,
  type GetLatestBlockhashApi,
  getBase64EncodedWireTransaction,
  type KeyPairSigner,
  type Rpc,
} from "@solana/kit";
import { buildActivation } from "./activation.ts";
import {
  type Authentication,
  authenticate,
  type Challenge,
  credentialHeader,
  parseChallenge,
  readRequest,
  type SubscriptionRequest,
  sourceOf,
} from "./mpp.ts";

export type AgentRpc = Rpc<GetAccountInfoApi & GetLatestBlockhashApi>;

export type RecurAgentOptions = {
  keypair: Parameters<typeof createSignerFromKeyPair>[0] | Uint8Array;
  rpcUrl: string;
  budget: { monthly: bigint };
  fetch?: typeof fetch;
  rpc?: AgentRpc;
};

type Proof = { challenge: Challenge; delegation: Address; authentication: Authentication };

const HOURS_PER_MONTH = 720n;

export const monthlyCost = (request: Pick<SubscriptionRequest, "amount" | "periodHours">) =>
  (request.amount * HOURS_PER_MONTH) / request.periodHours;

export function recurAgent(options: RecurAgentOptions): typeof fetch {
  const doFetch = options.fetch ?? fetch;
  const rpc = options.rpc ?? createSolanaRpc(options.rpcUrl);
  const signer: Promise<KeyPairSigner> =
    options.keypair instanceof Uint8Array
      ? createKeyPairSignerFromBytes(options.keypair)
      : createSignerFromKeyPair(options.keypair);
  const proofs = new Map<string, Proof>();

  const proofHeader = (proof: Proof) =>
    credentialHeader({
      challenge: proof.challenge,
      payload: {
        type: "proof",
        subscriptionDelegation: proof.delegation,
        authentication: proof.authentication,
      },
    });

  async function subscribe(
    send: (authorization: string) => Promise<Response>,
    origin: string,
    challenge: Challenge,
    request: SubscriptionRequest,
    member: KeyPairSigner,
  ): Promise<Response | null> {
    const [authorityAddress] = await rail.findSubscriptionAuthorityPda({
      user: member.address,
      tokenMint: request.mint,
    });
    const [plan, authority] = await Promise.all([
      rail.fetchMaybePlan(rpc, request.plan),
      rail.fetchMaybeSubscriptionAuthority(rpc, authorityAddress),
    ]);
    if (
      !plan.exists ||
      plan.data.data.mint !== request.mint ||
      plan.data.data.terms.amount !== request.amount ||
      plan.data.data.terms.periodHours !== request.periodHours
    )
      return null;
    const { value: lifetime } = await rpc.getLatestBlockhash().send();
    const { transaction, subscription } = await buildActivation({
      subscriber: member,
      terms: {
        plan: request.plan,
        owner: plan.data.owner,
        planId: plan.data.data.planId,
        planBump: plan.data.bump,
        mint: request.mint,
        amount: request.amount,
        periodHours: request.periodHours,
        createdAt: plan.data.data.terms.createdAt,
        recipient: request.recipient,
        puller: request.puller,
        feePayer: request.feePayer,
        tokenProgram: request.tokenProgram,
      },
      authorityInitId: authority.exists ? authority.data.initId : null,
      lifetime,
    });
    const authentication = await authenticate(member, challenge.id, subscription);
    const response = await send(
      credentialHeader({
        challenge,
        source: sourceOf(request.network, member.address),
        payload: {
          type: "transaction",
          transaction: getBase64EncodedWireTransaction(transaction),
          authentication,
        },
      }),
    );
    if (response.ok) proofs.set(origin, { challenge, delegation: subscription, authentication });
    return response;
  }

  return async (input, init) => {
    const original = new Request(input, init);
    const origin = new URL(original.url).origin;
    const send = (authorization?: string) => {
      const request = new Request(original.clone());
      if (authorization) request.headers.set("authorization", authorization);
      return doFetch(request);
    };
    const member = await signer;
    const stored = proofs.get(origin);
    const first = await send(stored && proofHeader(stored));
    if (first.status !== 402) return first;
    const challenge = parseChallenge(first.headers.get("www-authenticate"));
    const request = challenge && readRequest(challenge.request);
    if (!challenge || !request || monthlyCost(request) > options.budget.monthly) return first;
    return (await subscribe(send, origin, challenge, request, member)) ?? first;
  };
}
