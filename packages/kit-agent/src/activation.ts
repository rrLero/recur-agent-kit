import { rail } from "@repo/solana-client";
import {
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  createNoopSigner,
  createTransactionMessage,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";

export const UNKNOWN_INIT_ID = -(2n ** 63n);
const COMPUTE_UNIT_LIMIT = 400_000;
const MICROLAMPORTS_PER_UNIT = 5_000n;

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111" as Address;
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;

export type ActivationTerms = {
  plan: Address;
  owner: Address;
  planId: bigint;
  planBump: number;
  mint: Address;
  amount: bigint;
  periodHours: bigint;
  createdAt: bigint;
  recipient: Address;
  puller: Address;
  feePayer: Address;
  tokenProgram: Address;
};

export type ActivationInput = {
  subscriber: TransactionSigner;
  terms: ActivationTerms;
  authorityInitId: bigint | null;
  lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint };
};

export async function tokenAccount(owner: Address, mint: Address, tokenProgram: Address) {
  const encoder = getAddressEncoder();
  const [address] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [encoder.encode(owner), encoder.encode(tokenProgram), encoder.encode(mint)],
  });
  return address;
}

function computeBudget(kind: 2 | 3, value: bigint, size: 4 | 8): Instruction {
  const data = new Uint8Array(1 + size);
  data[0] = kind;
  const view = new DataView(data.buffer);
  if (size === 4) view.setUint32(1, Number(value), true);
  else view.setBigUint64(1, value, true);
  return { programAddress: COMPUTE_BUDGET, data };
}

export async function buildActivation({
  subscriber,
  terms,
  authorityInitId,
  lifetime,
}: ActivationInput) {
  const sponsor = createNoopSigner(terms.feePayer);
  const memberAta = await tokenAccount(subscriber.address, terms.mint, terms.tokenProgram);
  const [authority] = await rail.findSubscriptionAuthorityPda({
    user: subscriber.address,
    tokenMint: terms.mint,
  });
  const [subscription] = await rail.findSubscriptionDelegationPda({
    planPda: terms.plan,
    subscriber: subscriber.address,
  });
  const instructions: Instruction[] = [
    computeBudget(2, BigInt(COMPUTE_UNIT_LIMIT), 4),
    computeBudget(3, MICROLAMPORTS_PER_UNIT, 8),
  ];
  if (authorityInitId === null)
    instructions.push(
      await rail.getInitSubscriptionAuthorityInstructionAsync({
        owner: subscriber,
        tokenMint: terms.mint,
        userAta: memberAta,
        tokenProgram: terms.tokenProgram,
        payer: sponsor,
      }),
    );
  instructions.push(
    await rail.getSubscribeInstructionAsync({
      subscriber,
      merchant: terms.owner,
      planPda: terms.plan,
      subscriptionAuthorityPda: authority,
      payer: sponsor,
      subscribeData: {
        planId: terms.planId,
        planBump: terms.planBump,
        expectedMint: terms.mint,
        expectedAmount: terms.amount,
        expectedPeriodHours: terms.periodHours,
        expectedCreatedAt: terms.createdAt,
        expectedSubscriptionAuthorityInitId: authorityInitId ?? UNKNOWN_INIT_ID,
      },
    }),
    await rail.getTransferSubscriptionInstructionAsync({
      subscriptionPda: subscription,
      planPda: terms.plan,
      subscriptionAuthority: authority,
      delegatorAta: memberAta,
      receiverAta: await tokenAccount(terms.recipient, terms.mint, terms.tokenProgram),
      caller: createNoopSigner(terms.puller),
      tokenMint: terms.mint,
      tokenProgram: terms.tokenProgram,
      transferData: { amount: terms.amount, delegator: subscriber.address, mint: terms.mint },
    }),
  );
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(sponsor, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return { transaction: await partiallySignTransactionMessageWithSigners(message), subscription };
}
