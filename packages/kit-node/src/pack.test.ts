import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const packageRoot = join(import.meta.dirname, "..");
const workDir = mkdtempSync(join(tmpdir(), "kit-node-pack-"));

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("packed tarball", () => {
  it("installs_offline_and_verifies_a_webhook", () => {
    execFileSync("pnpm", ["pack", "--pack-destination", workDir], { cwd: packageRoot });
    const tarball = join(workDir, "repo-kit-node-0.0.0.tgz");
    const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
    expect(listing).toContain("package/dist/index.mjs");
    expect(listing).toContain("package/dist/index.d.mts");

    const target = join(workDir, "consumer", "node_modules", "@repo", "kit-node");
    mkdirSync(target, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "-C", target, "--strip-components=1"]);
    const packed = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    expect(packed.exports["."]).toEqual({
      types: "./dist/index.d.mts",
      default: "./dist/index.mjs",
    });

    const consumer = join(workDir, "consumer");
    writeFileSync(join(consumer, "package.json"), '{"type":"module"}');
    const script = `
      import("@repo/kit-node").then((m) => {
        const event = m.verifyWebhook('{"test": 2432232314}', {
          "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
          "webhook-timestamp": "1614265330",
          "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
        }, "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", { now: () => 1614265330 });
        const paywall = m.recurPaywall({ apiKey: "k", productId: 1, baseUrl: "http://localhost:1" });
        const ok = event.test === 2432232314 && typeof paywall.fetch === "function";
        console.log(ok ? "ok" : "bad");
      });
    `;
    const output = execFileSync("node", ["-e", script], { cwd: consumer, encoding: "utf8" });
    expect(output.trim()).toBe("ok");
  }, 60_000);
});
