const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(input: string): Uint8Array<ArrayBuffer> {
  let value = 0n;
  for (const char of input) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error("invalid base58");
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  const zeros = input.length - input.replace(/^1+/, "").length;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

export function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  const zeros = bytes.findIndex((byte) => byte !== 0);
  return "1".repeat(zeros < 0 ? bytes.length : zeros) + out;
}
