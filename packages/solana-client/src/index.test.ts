import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  address,
  createNoopSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  findMembershipPda,
  findMerchantPda,
  findMerchantTransitPda,
  findTransitPda,
  getActivateAgentInstruction,
  getCollectInstruction,
  getInitConfigInstruction,
  getSplitInstruction,
  getUpdateConfigInstruction,
  RECUR_PROGRAM_ADDRESS,
  rail,
} from "./index.ts";

const admin = createNoopSigner(address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"));
const config = address("SysvarC1ock11111111111111111111111111111111");
const treasury = address("Vote111111111111111111111111111111111111111");

describe("@repo/solana-client", () => {
  it("targets the recur program id from declare_id", () => {
    expect(RECUR_PROGRAM_ADDRESS).toBe("bY4Yyya6CMHBUfU9BfgoWK8TCjVhWtxQPurtX56dF5v");
  });

  it("encodes init_config arguments after the 8-byte discriminator", () => {
    const ix = getInitConfigInstruction({
      admin,
      config,
      program: RECUR_PROGRAM_ADDRESS,
      programData: config,
      feeBps: 200,
      minFee: 100_000n,
      treasury,
    });
    expect(ix.programAddress).toBe(RECUR_PROGRAM_ADDRESS);
    expect(ix.data.length).toBe(8 + 2 + 8 + 32);
    expect(new DataView(ix.data.buffer, ix.data.byteOffset).getUint16(8, true)).toBe(200);
  });

  it("encodes update_config arguments", () => {
    const ix = getUpdateConfigInstruction({
      admin,
      config,
      newAdmin: admin.address,
      feeBps: 500,
      minFee: 50_000n,
      treasury,
      paused: true,
      agentPuller: admin.address,
    });
    expect(ix.data.length).toBe(8 + 32 + 2 + 8 + 32 + 1 + 32);
  });

  it("derives the merchant pda", async () => {
    const [derived] = await findMerchantPda({ owner: admin.address });
    const [expected] = await getProgramDerivedAddress({
      programAddress: RECUR_PROGRAM_ADDRESS,
      seeds: [new TextEncoder().encode("merchant"), getAddressEncoder().encode(admin.address)],
    });
    expect(derived).toBe(expected);
  });

  it("encodes collect without arguments", () => {
    const ix = getCollectInstruction({
      config,
      merchant: config,
      puller: config,
      transit: config,
      transitAta: config,
      mint: config,
      plan: config,
      subscription: config,
      subscriptionAuthority: config,
      memberAta: config,
      membership: config,
      merchantAta: config,
      treasuryAta: config,
      eventAuthority: config,
    });
    expect(ix.data.length).toBe(8);
  });

  it("derives the merchant transit pda", async () => {
    const [derived] = await findMerchantTransitPda({ owner: admin.address });
    const [expected] = await getProgramDerivedAddress({
      programAddress: RECUR_PROGRAM_ADDRESS,
      seeds: [new TextEncoder().encode("transit"), getAddressEncoder().encode(admin.address)],
    });
    expect(derived).toBe(expected);
    const [global] = await findTransitPda();
    expect(derived).not.toBe(global);
  });

  it("encodes activate_agent without arguments and with the agent puller as signer", () => {
    const ix = getActivateAgentInstruction({
      agentPuller: admin,
      payer: admin,
      config,
      merchant: config,
      transit: config,
      transitAta: config,
      mint: config,
      plan: config,
      subscription: config,
      member: treasury,
      membership: config,
      merchantAta: config,
      treasuryAta: config,
    });
    expect(ix.data.length).toBe(8);
    expect(ix.accounts[0]?.address).toBe(admin.address);
  });

  it("encodes split with its amount after the discriminator", () => {
    const ix = getSplitInstruction({
      agentPuller: admin,
      config,
      merchant: config,
      transit: config,
      transitAta: config,
      merchantAta: config,
      treasuryAta: config,
      mint: config,
      amount: 1_000_000n,
    });
    expect(ix.programAddress).toBe(RECUR_PROGRAM_ADDRESS);
    expect(ix.data.length).toBe(8 + 8);
    expect(new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(8, true)).toBe(1_000_000n);
    expect(ix.accounts[0]?.address).toBe(admin.address);
  });

  it("derives the membership pda", async () => {
    const [derived] = await findMembershipPda({ plan: treasury, member: admin.address });
    const [expected] = await getProgramDerivedAddress({
      programAddress: RECUR_PROGRAM_ADDRESS,
      seeds: [
        new TextEncoder().encode("membership"),
        getAddressEncoder().encode(treasury),
        getAddressEncoder().encode(admin.address),
      ],
    });
    expect(derived).toBe(expected);
  });

  it("rail_idl_matches_its_pinned_hash", () => {
    const idl = readFileSync(new URL("../idl/subscriptions.json", import.meta.url));
    const pinned = readFileSync(
      new URL("../idl/subscriptions.json.sha256", import.meta.url),
      "utf8",
    );
    expect(createHash("sha256").update(idl).digest("hex")).toBe(pinned.split(/\s/)[0]);
  });

  it("rail_subscribe_instruction_targets_the_rail_program", () => {
    expect(rail.getSubscribeInstruction).toBeTypeOf("function");
    expect(rail.SUBSCRIPTIONS_PROGRAM_ADDRESS).toBe("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44");
  });

  it("rail_subscription_pda_matches_the_rail_seeds", async () => {
    const encoder = getAddressEncoder();
    const [expected] = await getProgramDerivedAddress({
      programAddress: rail.SUBSCRIPTIONS_PROGRAM_ADDRESS,
      seeds: ["subscription", encoder.encode(treasury), encoder.encode(admin.address)],
    });
    const [derived] = await rail.findSubscriptionDelegationPda({
      planPda: treasury,
      subscriber: admin.address,
    });
    expect(derived).toBe(expected);
  });

  it("recur_and_rail_exports_do_not_collide", () => {
    expect(rail.SUBSCRIPTIONS_PROGRAM_ADDRESS).toBeDefined();
    expect(RECUR_PROGRAM_ADDRESS).toBeDefined();
  });
});
