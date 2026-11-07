import {
  type Address,
  address,
  compileTransactionMessage,
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  type ReadonlyUint8Array,
} from "@solana/kit";

const LIGHTHOUSE_PROGRAM_ADDRESS = address("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");

const LIGHTHOUSE_ASSERTION_TAGS: readonly number[] = [5, 6, 9, 10];

export const WALLET_GUARD_PROGRAMS: readonly Address[] = [LIGHTHOUSE_PROGRAM_ADDRESS];

export function withoutWalletGuards(messageBytes: ReadonlyUint8Array): ReadonlyUint8Array | null {
  try {
    return strip(messageBytes);
  } catch {
    return null;
  }
}

function strip(messageBytes: ReadonlyUint8Array): ReadonlyUint8Array | null {
  const returned = getCompiledTransactionMessageDecoder().decode(messageBytes);
  if (!sameBytesAs(getCompiledTransactionMessageEncoder().encode(returned), messageBytes))
    return null;
  if (hasLookups(returned)) return null;
  const guardIndex = returned.staticAccounts.indexOf(LIGHTHOUSE_PROGRAM_ADDRESS);
  if (guardIndex === -1) return messageBytes;

  const { header, staticAccounts } = returned;
  const firstReadonlyUnsigned = staticAccounts.length - header.numReadonlyNonSignerAccounts;
  if (guardIndex < firstReadonlyUnsigned) return null;

  const decompiled = decompileTransactionMessage(returned, { lastValidBlockHeight: 0n });
  const guards = guardsOf(decompiled);
  for (const { tag } of guards) {
    if (tag === undefined || !LIGHTHOUSE_ASSERTION_TAGS.includes(tag)) return null;
  }

  const ours = decompiled.instructions.filter(
    (i) => i.programAddress !== LIGHTHOUSE_PROGRAM_ADDRESS,
  );
  const strippedBytes = getCompiledTransactionMessageEncoder().encode(
    compileTransactionMessage({ ...decompiled, instructions: ours }),
  );
  const stripped = getCompiledTransactionMessageDecoder().decode(strippedBytes);

  const strippedKeys = new Set(stripped.staticAccounts);
  if (strippedKeys.has(LIGHTHOUSE_PROGRAM_ADDRESS)) return null;
  if (staticAccounts.length !== stripped.staticAccounts.length + 1) return null;
  if (!staticAccounts.every((key) => key === LIGHTHOUSE_PROGRAM_ADDRESS || strippedKeys.has(key)))
    return null;
  for (const { accounts } of guards) {
    if (!accounts.every((account) => strippedKeys.has(account))) return null;
  }

  if (
    stripped.version !== returned.version ||
    stripped.header.numSignerAccounts !== header.numSignerAccounts ||
    stripped.header.numReadonlySignerAccounts !== header.numReadonlySignerAccounts ||
    stripped.lifetimeToken !== returned.lifetimeToken ||
    !sameConfig(stripped, returned)
  )
    return null;

  return strippedBytes;
}

function sameBytesAs(a: ReadonlyUint8Array, b: ReadonlyUint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

type CompiledMessage = ReturnType<
  ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]
>;
function hasLookups(message: CompiledMessage): boolean {
  return "addressTableLookups" in message && (message.addressTableLookups?.length ?? 0) > 0;
}

type Decompiled = ReturnType<typeof decompileTransactionMessage>;

function guardsOf(decompiled: Decompiled) {
  return decompiled.instructions
    .filter((i) => i.programAddress === LIGHTHOUSE_PROGRAM_ADDRESS)
    .map((i) => ({
      tag: i.data?.[0],
      accounts: (i.accounts ?? []).map((account) => account.address),
    }));
}

function sameConfig(a: CompiledMessage, b: CompiledMessage): boolean {
  if (!("configMask" in a) || !("configMask" in b)) return true;
  return (
    a.configMask === b.configMask &&
    a.configValues.length === b.configValues.length &&
    a.configValues.every(
      (value, at) =>
        value.kind === b.configValues[at]?.kind && value.value === b.configValues[at]?.value,
    )
  );
}
