import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransactionMessage,
  createTransactionMessage,
  decompileTransactionMessage,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  type ReadonlyUint8Array,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { LIGHTHOUSE_MAINNET_WIRE } from "./fixtures/lighthouse-mainnet.ts";
import { WALLET_GUARD_PROGRAMS, withoutWalletGuards } from "./wallet-guards.ts";

const [LIGHTHOUSE] = WALLET_GUARD_PROGRAMS;
const MEMO = address("MemoSq4gqABAXKb1qbqY1aDt1hD6Cj3bNTHBMqGHjNQ");
const STRANGER = address("SysvarRent111111111111111111111111111111111");
const LOOKUP_TABLE = address("AddressLookupTab1e1111111111111111111111111");

const returnedBytes = getTransactionDecoder().decode(
  getBase64Encoder().encode(LIGHTHOUSE_MAINNET_WIRE),
).messageBytes;
const decoded = getCompiledTransactionMessageDecoder().decode(returnedBytes);
if (decoded.version !== 0) throw new Error("the fixture is not a v0 message");
const returned = decoded;
type Compiled = typeof returned;
type CompiledInstruction = Compiled["instructions"][number];

const decompiled = decompileTransactionMessage(returned, { lastValidBlockHeight: 0n });
const built = getCompiledTransactionMessageEncoder().encode(
  compileTransactionMessage({
    ...decompiled,
    instructions: decompiled.instructions.filter((i) => i.programAddress !== LIGHTHOUSE),
  }),
);

const guardIndex = returned.staticAccounts.indexOf(LIGHTHOUSE as Address);
const encode = (message: Compiled) => getCompiledTransactionMessageEncoder().encode(message);
const isGuard = (i: CompiledInstruction) => i.programAddressIndex === guardIndex;
const withInstructions = (map: (instructions: CompiledInstruction[]) => CompiledInstruction[]) =>
  encode({ ...returned, instructions: map([...returned.instructions]) });
const replaceFirstGuard = (instruction: Partial<CompiledInstruction>) =>
  withInstructions((all) => {
    const at = all.findIndex(isGuard);
    all[at] = { ...(all[at] as CompiledInstruction), ...instruction };
    return all;
  });
const appendReadonlyKey = (key: Address, extra: Partial<Compiled> = {}) =>
  ({
    ...returned,
    staticAccounts: [...returned.staticAccounts, key],
    header: {
      ...returned.header,
      numReadonlyNonSignerAccounts: returned.header.numReadonlyNonSignerAccounts + 1,
    },
    ...extra,
  }) as Compiled;

const accepted = (message: ReadonlyUint8Array) => {
  const stripped = withoutWalletGuards(message);
  return stripped !== null && Buffer.from(stripped).equals(Buffer.from(built));
};

describe("withoutWalletGuards", () => {
  it("strips_phantom_mainnet_lighthouse", () => {
    const tags = returned.instructions.map((i) => (isGuard(i) ? `g${i.data?.[0]}` : "ours"));
    expect(tags).toEqual(["ours", "ours", "g6", "g6", "ours", "g6", "g10"]);
    expect(accepted(returnedBytes)).toBe(true);
  });

  it("keeps_an_unchanged_message", () => {
    expect(withoutWalletGuards(built)).toEqual(built);
  });

  it("allows_a_guard_on_the_fee_payer", () => {
    expect(accepted(replaceFirstGuard({ accountIndices: [0] }))).toBe(true);
  });

  it("refuses_a_non_allow_listed_program", () => {
    const memoIndex = returned.staticAccounts.length;
    const message = appendReadonlyKey(MEMO);
    const withMemo = encode({
      ...message,
      instructions: [
        ...message.instructions,
        { programAddressIndex: memoIndex, data: new Uint8Array([104, 105]) },
      ],
    });
    expect(accepted(withMemo)).toBe(false);
  });

  it("refuses_a_changed_compute_price", () => {
    const changed = withInstructions((all) => {
      all[1] = {
        ...(all[1] as CompiledInstruction),
        data: new Uint8Array([3, 0x20, 0x4e, 0, 0, 0, 0, 0, 0]),
      };
      return all;
    });
    expect(accepted(changed)).toBe(false);
  });

  it("refuses_reordered_instructions", () => {
    const reordered = withInstructions(([limit, price, ...rest]) => [
      price as CompiledInstruction,
      limit as CompiledInstruction,
      ...rest,
    ]);
    expect(accepted(reordered)).toBe(false);
  });

  it("refuses_a_new_account_in_a_guard", () => {
    const message = appendReadonlyKey(STRANGER);
    const at = message.instructions.findIndex(isGuard);
    const instructions = [...message.instructions];
    instructions[at] = {
      ...(instructions[at] as CompiledInstruction),
      accountIndices: [message.staticAccounts.length - 1],
    };
    expect(withoutWalletGuards(encode({ ...message, instructions }))).toBeNull();
  });

  it("refuses_the_guard_program_as_a_guard_account", () => {
    expect(withoutWalletGuards(replaceFirstGuard({ accountIndices: [guardIndex] }))).toBeNull();
  });

  it("refuses_an_added_signer", () => {
    const shift = (index: number) => (index >= 1 ? index + 1 : index);
    const message = {
      ...returned,
      staticAccounts: [returned.staticAccounts[0], STRANGER, ...returned.staticAccounts.slice(1)],
      header: { ...returned.header, numSignerAccounts: returned.header.numSignerAccounts + 1 },
      instructions: returned.instructions.map((i) => ({
        ...i,
        programAddressIndex: shift(i.programAddressIndex),
        accountIndices: i.accountIndices?.map(shift),
      })),
    } as Compiled;
    expect(withoutWalletGuards(encode(message))).toBeNull();
  });

  it("refuses_an_unused_extra_static_key", () => {
    expect(withoutWalletGuards(encode(appendReadonlyKey(STRANGER)))).toBeNull();
  });

  it("refuses_address_table_lookups", () => {
    const message = {
      ...returned,
      addressTableLookups: [
        { lookupTableAddress: LOOKUP_TABLE, writableIndexes: [0], readonlyIndexes: [] },
      ],
    } as Compiled;
    expect(withoutWalletGuards(encode(message))).toBeNull();
  });

  it("refuses_lighthouse_memory_write", () => {
    const memoryWrite = replaceFirstGuard({
      accountIndices: [0, 1],
      data: new Uint8Array([0, 0, 255, 0, 0]),
    });
    expect(withoutWalletGuards(memoryWrite)).toBeNull();
  });

  it("refuses_lighthouse_sysvar_clock_assert", () => {
    const clock = replaceFirstGuard({
      accountIndices: [],
      data: new Uint8Array([15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    });
    expect(withoutWalletGuards(clock)).toBeNull();
  });
});

const sameBytes = (a: ReadonlyUint8Array | null, b: ReadonlyUint8Array) =>
  a !== null && Buffer.from(a).equals(Buffer.from(b));

const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
const v1Config = {
  computeUnitLimit: 400_000,
  loadedAccountsDataSizeLimit: 1_769_472,
  priorityFeeLamports: 4_000n,
};
const withoutBudget = decompiled.instructions.filter((i) => i.programAddress !== COMPUTE_BUDGET);

const v1Message = (
  instructions: typeof decompiled.instructions,
  config: Parameters<typeof setTransactionMessageConfig>[0] = v1Config,
) =>
  setTransactionMessageConfig(
    config,
    appendTransactionMessageInstructions(
      instructions,
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k" as Blockhash,
          lastValidBlockHeight: 1n,
        },
        setTransactionMessageFeePayer(
          decompiled.feePayer.address,
          createTransactionMessage({ version: 1 }),
        ),
      ),
    ),
  );
const encodeV1 = (message: ReturnType<typeof v1Message>) =>
  getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message));
const v1Built = encodeV1(v1Message(withoutBudget.filter((i) => i.programAddress !== LIGHTHOUSE)));
const v1Guarded = v1Message(withoutBudget);
const guardAt = (instructions: typeof withoutBudget) =>
  instructions.findIndex((i) => i.programAddress === LIGHTHOUSE);
const v1WithGuard = (guard: Partial<(typeof withoutBudget)[number]>, config = v1Config) => {
  const instructions = [...withoutBudget];
  const at = guardAt(instructions);
  instructions[at] = { ...(instructions[at] as (typeof withoutBudget)[number]), ...guard };
  return encodeV1(v1Message(instructions, config));
};

describe("withoutWalletGuards with a v1 message", () => {
  it("builds_a_v1_fixture", () => {
    const compiled = getCompiledTransactionMessageDecoder().decode(encodeV1(v1Guarded));
    expect(compiled.version).toBe(1);
    expect(withoutBudget.filter((i) => i.programAddress === LIGHTHOUSE)).toHaveLength(4);
  });

  it("strips_guards_back_to_the_built_bytes", () => {
    expect(sameBytes(withoutWalletGuards(encodeV1(v1Guarded)), v1Built)).toBe(true);
  });

  it("keeps_a_v1_message_without_guards", () => {
    expect(withoutWalletGuards(v1Built)).toEqual(v1Built);
  });

  it("allows_a_guard_on_the_fee_payer", () => {
    const feePayer = decompiled.feePayer.address;
    const bytes = v1WithGuard({ accounts: [{ address: feePayer, role: AccountRole.READONLY }] });
    expect(sameBytes(withoutWalletGuards(bytes), v1Built)).toBe(true);
  });

  it("refuses_a_non_allow_listed_lighthouse_tag", () => {
    expect(
      withoutWalletGuards(v1WithGuard({ data: new Uint8Array([0, 0, 255, 0, 0]) })),
    ).toBeNull();
  });

  it("refuses_a_guard_on_an_account_outside_the_build", () => {
    const bytes = v1WithGuard({ accounts: [{ address: STRANGER, role: AccountRole.READONLY }] });
    expect(withoutWalletGuards(bytes)).toBeNull();
  });

  it("refuses_a_guard_adding_a_signer", () => {
    const bytes = v1WithGuard({
      accounts: [{ address: STRANGER, role: AccountRole.READONLY_SIGNER }],
    });
    expect(withoutWalletGuards(bytes)).toBeNull();
  });

  it("refuses_a_changed_config_value", () => {
    const bytes = v1WithGuard({}, { ...v1Config, priorityFeeLamports: 5_000n });
    expect(withoutWalletGuards(bytes)).not.toBeNull();
    expect(sameBytes(withoutWalletGuards(bytes), v1Built)).toBe(false);
  });

  it("refuses_a_config_field_removed", () => {
    const { computeUnitLimit: _removed, ...fewer } = v1Config;
    const bytes = encodeV1(v1Message(withoutBudget, fewer));
    expect(sameBytes(withoutWalletGuards(bytes), v1Built)).toBe(false);
  });

  it("refuses_a_config_field_added", () => {
    const { computeUnitLimit: _removed, ...fewer } = v1Config;
    const builtWithFewer = encodeV1(
      v1Message(
        withoutBudget.filter((i) => i.programAddress !== LIGHTHOUSE),
        fewer,
      ),
    );
    expect(sameBytes(withoutWalletGuards(encodeV1(v1Guarded)), builtWithFewer)).toBe(false);
  });

  it("refuses_trailing_bytes_after_a_guarded_message", () => {
    const junk = new Uint8Array([...encodeV1(v1Guarded), 1, 2, 3]);
    expect(withoutWalletGuards(junk)).toBeNull();
  });

  it("refuses_trailing_bytes_after_an_unguarded_message", () => {
    const junk = new Uint8Array([...v1Built, 1, 2, 3]);
    expect(withoutWalletGuards(junk)).toBeNull();
  });
});
