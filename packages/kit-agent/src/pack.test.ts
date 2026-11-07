import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const packageRoot = join(import.meta.dirname, "..");
const workDir = mkdtempSync(join(tmpdir(), "kit-agent-pack-"));

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("packed tarball", () => {
  it("installs_offline_and_builds_an_activation", () => {
    execFileSync("pnpm", ["pack", "--pack-destination", workDir], { cwd: packageRoot });
    const tarball = join(workDir, "repo-kit-agent-0.0.0.tgz");
    const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
    expect(listing).toContain("package/dist/index.mjs");
    expect(listing).toContain("package/dist/index.d.mts");

    const modules = join(workDir, "consumer", "node_modules");
    const target = join(modules, "@repo", "kit-agent");
    mkdirSync(target, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "-C", target, "--strip-components=1"]);
    const packed = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    expect(packed.exports["."]).toEqual({
      types: "./dist/index.d.mts",
      default: "./dist/index.mjs",
    });
    expect(Object.keys(packed.dependencies).sort()).toEqual([
      "@solana/kit",
      "@solana/program-client-core",
    ]);
    expect(readFileSync(join(target, "dist", "index.mjs"), "utf8")).not.toContain("@repo/");
    symlinkSync(join(packageRoot, "node_modules", "@solana"), join(modules, "@solana"));

    const consumer = join(workDir, "consumer");
    writeFileSync(join(consumer, "package.json"), '{"type":"module"}');
    const script = `
      const m = await import("@repo/kit-agent");
      const kit = await import("@solana/kit");
      const keys = await Promise.all(Array.from({ length: 7 }, () => kit.generateKeyPairSigner()));
      const [subscriber, plan, owner, mint, recipient, puller, feePayer] = keys;
      const { transaction } = await m.buildActivation({
        subscriber,
        terms: {
          plan: plan.address, owner: owner.address, planId: 1n, planBump: 255,
          mint: mint.address, amount: 1n, periodHours: 24n, createdAt: 0n,
          recipient: recipient.address, puller: puller.address, feePayer: feePayer.address,
          tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        },
        authorityInitId: null,
        lifetime: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 0n },
      });
      const agent = m.recurAgent({ keypair: await kit.generateKeyPair(), rpcUrl: "http://localhost:1", budget: { monthly: 1n } });
      const ok = Object.keys(transaction.signatures).length === 3 && typeof agent === "function";
      console.log(ok ? "ok" : "bad");
    `;
    const output = execFileSync("node", ["--input-type=module", "-e", script], {
      cwd: consumer,
      encoding: "utf8",
    });
    expect(output.trim()).toBe("ok");
  }, 60_000);
});
