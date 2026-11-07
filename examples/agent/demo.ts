import { readFileSync } from "node:fs";
import { recurAgent } from "@repo/kit-agent";
import { address, createKeyPairSignerFromBytes, createSolanaRpc } from "@solana/kit";

const url = process.argv[2] ?? "http://127.0.0.1:4901/v1/echo?say=hello";
const keypairFile = process.env.AGENT_KEYPAIR;
if (!keypairFile) throw new Error("set AGENT_KEYPAIR to a solana-keygen JSON file");
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const monthly = BigInt(Math.round(Number(process.env.BUDGET_USDC ?? 30) * 1_000_000));

const keypair = new Uint8Array(JSON.parse(readFileSync(keypairFile, "utf8")));
const agent = await createKeyPairSignerFromBytes(keypair);
const rpc = createSolanaRpc(rpcUrl);
const sol = async () => Number((await rpc.getBalance(address(agent.address)).send()).value) / 1e9;

console.log(`agent ${agent.address}, ${await sol()} SOL, budget ${Number(monthly) / 1e6} USDC a month`);

const unpaid = await fetch(url);
console.log(`\nGET ${url}\n← ${unpaid.status} ${unpaid.statusText}`);
console.log(`  WWW-Authenticate: ${(unpaid.headers.get("www-authenticate") ?? "").slice(0, 96)}…`);

console.log("\nthe agent subscribes and retries…");
const paid = await recurAgent({ keypair, rpcUrl, budget: { monthly } })(url);
console.log(`← ${paid.status} ${paid.statusText}  ${await paid.text()}`);

const receipt = paid.headers.get("payment-receipt");
if (receipt) {
  const { reference, status } = JSON.parse(Buffer.from(receipt, "base64url").toString("utf8"));
  console.log(`  Payment-Receipt: ${status}, activation ${reference}`);
  console.log(`  https://explorer.solana.com/tx/${reference}?cluster=devnet`);
}
console.log(`\nagent still holds ${await sol()} SOL`);
