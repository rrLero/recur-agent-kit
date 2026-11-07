import {
  type Address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type ProgramDerivedAddress,
} from "@solana/kit";
import { RECUR_PROGRAM_ADDRESS } from "./generated/index.ts";

export async function findMerchantTransitPda(seeds: {
  owner: Address;
}): Promise<ProgramDerivedAddress> {
  return await getProgramDerivedAddress({
    programAddress: RECUR_PROGRAM_ADDRESS,
    seeds: [new TextEncoder().encode("transit"), getAddressEncoder().encode(seeds.owner)],
  });
}
