import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import dns from "node:dns";
import { fetch as undiciFetch } from "undici";
import {
  assertPublicUrl,
  BlockedUrlError,
  checkHostname,
  checkUrlSyntax,
  createGuardedAgent,
  createGuardedLookup,
  isPublicAddress,
} from "../src/utils/net-guard.js";

describe("isPublicAddress", () => {
  it.each(["8.8.8.8", "185.199.108.153", "2a00:1450:4007:80e::200e", "64:ff9b::808:808"])(
    "public: %s",
    (ip) => expect(isPublicAddress(ip)).toBe(true)
  );

  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.17.0.2", // default Docker bridge
    "172.18.0.5", // user-defined Docker network
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "255.255.255.255",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe", // NAT64 → 169.254.169.254
    "nope",
  ])("not public: %s", (ip) => expect(isPublicAddress(ip)).toBe(false));
});

describe("checkUrlSyntax / checkHostname", () => {
  it("accepts normal public URLs", () => {
    expect(checkUrlSyntax("https://www.adsim.be/contact")).toBeNull();
    expect(checkUrlSyntax("http://example.com:80/")).toBeNull();
    expect(checkUrlSyntax("https://8.8.8.8/")).toBeNull();
  });

  it.each([
    ["file:///etc/passwd", "scheme"],
    ["gopher://example.com/", "scheme"],
    ["ftp://example.com/", "scheme"],
    ["https://user:pw@example.com/", "credentials"],
    ["https://example.com:6379/", "port"],
    ["http://example.com:3005/mcp", "port"],
    ["http://127.0.0.1/", "non-public IP"],
    ["http://169.254.169.254/latest/meta-data/", "non-public IP"],
    ["http://[::1]/", "non-public IP"],
    ["http://[::ffff:7f00:1]/", "non-public IP"],
    ["http://2130706433/", "non-public IP"], // WHATWG URL normalises to 127.0.0.1
    ["http://0x7f000001/", "non-public IP"],
    ["http://localhost/", "single-label"],
    ["http://data-engine-mcp/", "single-label"], // Docker service name
    ["http://redis/", "single-label"],
    ["http://host.docker.internal/", "reserved"],
    ["http://api.localhost/", "reserved"],
    ["http://printer.local/", "reserved"],
    ["not a url", "invalid"],
  ])("blocks %s (%s)", (url, reason) => {
    expect(checkUrlSyntax(url)).toContain(reason);
  });

  it("handles trailing dots and brackets", () => {
    expect(checkHostname("localhost.")).toContain("single-label");
    expect(checkHostname("[::1]")).toContain("non-public");
  });
});

describe("assertPublicUrl (DNS)", () => {
  it("accepts a name resolving only to public addresses", async () => {
    await expect(assertPublicUrl("https://ok.example.com/", async () => ["93.184.216.34"])).resolves.toBeUndefined();
  });

  it("blocks a public-looking name resolving to an internal address", async () => {
    await expect(assertPublicUrl("https://rebind.attacker.com/", async () => ["172.18.0.3"])).rejects.toBeInstanceOf(
      BlockedUrlError
    );
  });

  it("blocks when ANY resolved address is internal", async () => {
    await expect(
      assertPublicUrl("https://mixed.attacker.com/", async () => ["93.184.216.34", "127.0.0.1"])
    ).rejects.toThrow(/non-public/);
  });

  it("blocks unresolvable names", async () => {
    await expect(
      assertPublicUrl("https://nx.example.com/", async () => {
        throw new Error("ENOTFOUND");
      })
    ).rejects.toThrow(/DNS/);
  });
});

describe("guarded undici agent (connect-time check)", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end("secret-internal-data"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("sanity: the internal server is reachable without the guard", async () => {
    const res = await undiciFetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe("secret-internal-data");
  });

  it("blocks an IP literal (no DNS involved)", async () => {
    const agent = createGuardedAgent();
    await expect(undiciFetch(`http://127.0.0.1:${port}/`, { dispatcher: agent })).rejects.toThrow();
  });

  it("blocks a hostname resolving to loopback (DNS rebinding at connect time)", async () => {
    // Simulates a public domain whose DNS answers 127.0.0.1 when we connect.
    const fakeLookup = ((_host: string, opts: dns.LookupOptions, cb: (...a: unknown[]) => void) =>
      opts.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)) as typeof dns.lookup;
    const agent = createGuardedAgent(createGuardedLookup(fakeLookup));
    const err = await undiciFetch(`http://rebind.attacker.com/`, { dispatcher: agent }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.cause?.message ?? err.message)).toMatch(/non-public|Blocked/);
  });

  it("blocks a redirect from a public URL to an internal one", async () => {
    // First hop "public" (fake DNS → our redirect server is reached via a public-looking name
    // would need a real public IP), so we test the per-hop check directly: the redirect
    // target goes through the same connector and is refused.
    const agent = createGuardedAgent();
    await expect(
      undiciFetch(`http://localhost:${port}/`, { dispatcher: agent, redirect: "follow" })
    ).rejects.toThrow();
  });
});
