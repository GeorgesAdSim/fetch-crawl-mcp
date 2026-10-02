/**
 * SSRF protection for every outgoing request made by this server.
 *
 * The server fetches arbitrary URLs on behalf of its callers. Without this
 * guard, anyone able to call a tool could make the host reach internal
 * services (Docker containers, Redis, cloud metadata at 169.254.169.254…).
 *
 * Two layers:
 *  - `assertPublicUrl()`: early, explicit check (scheme, port, hostname, DNS).
 *  - `installNetworkGuard()`: global undici dispatcher used by Node's `fetch`.
 *    The resolved IP is checked at connect time, so redirects and DNS
 *    rebinding (public at check time, private at connect time) are blocked too.
 *
 * Puppeteer navigations are guarded separately in `browser.ts`.
 */
import dns from "node:dns";
import net from "node:net";
import type { LookupAddress, LookupOptions } from "node:dns";
import ipaddr from "ipaddr.js";
import { Agent, buildConnector, setGlobalDispatcher } from "undici";

export class BlockedUrlError extends Error {
  constructor(
    public readonly url: string,
    public readonly reason: string
  ) {
    super(`Blocked request to ${url}: ${reason}`);
    this.name = "BlockedUrlError";
  }
}

const ALLOWED_PORTS = new Set(["", "80", "443"]);
const RESERVED_TLDS = new Set([
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "test",
  "example",
  "invalid",
  "onion",
  "arpa",
]);

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let ip = ipaddr.parse(address);
  if (ip.kind() === "ipv6") {
    const v6 = ip as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      ip = v6.toIPv4Address();
    } else {
      const range = v6.range();
      // NAT64 (64:ff9b::/96) embeds an IPv4 address: judge that one.
      if (range === "rfc6052") {
        return isPublicAddress(v6.toByteArray().slice(12).join("."));
      }
      return range === "unicast";
    }
  }
  return (ip as ipaddr.IPv4).range() === "unicast";
}

/**
 * Hostname-level check (no DNS). Rejects IP literals that are not public,
 * single-label names (Docker service names such as `redis` or
 * `data-engine-mcp`) and reserved TLDs.
 */
export function checkHostname(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return "empty hostname";
  if (net.isIP(host)) return isPublicAddress(host) ? null : "non-public IP address";
  // Numeric forms that WHATWG URL would not normalise to dotted quads.
  if (/^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return "numeric hostname";
  if (!host.includes(".")) return "single-label hostname";
  const tld = host.split(".").pop()!;
  if (RESERVED_TLDS.has(tld)) return "reserved hostname";
  return null;
}

/** URL-level check (no DNS): scheme, credentials, port, hostname. */
export function checkUrlSyntax(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "invalid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `scheme ${url.protocol} not allowed`;
  if (url.username || url.password) return "credentials in URL";
  const hostError = checkHostname(url.hostname);
  if (hostError) return hostError;
  if (!ALLOWED_PORTS.has(url.port)) return `port ${url.port} not allowed`;
  return null;
}

export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) =>
  (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** Full check: syntax + every resolved address must be public. */
export async function assertPublicUrl(rawUrl: string, resolve: Resolver = defaultResolver): Promise<void> {
  const syntaxError = checkUrlSyntax(rawUrl);
  if (syntaxError) throw new BlockedUrlError(rawUrl, syntaxError);
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return; // already validated as public
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new BlockedUrlError(rawUrl, "DNS resolution failed");
  }
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    throw new BlockedUrlError(rawUrl, "hostname resolves to a non-public address");
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;

type LookupFn = (hostname: string, options: LookupOptions, callback: LookupCallback) => void;

/** dns.lookup replacement that fails when any resolved address is not public. */
export function createGuardedLookup(baseLookup: typeof dns.lookup = dns.lookup): LookupFn {
  return (hostname, options, callback) => {
    const hostError = checkHostname(hostname);
    if (hostError) return callback(new BlockedUrlError(hostname, hostError) as NodeJS.ErrnoException, "");
    baseLookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err, "");
      const list = addresses as unknown as LookupAddress[];
      if (list.length === 0 || !list.every((a) => isPublicAddress(a.address))) {
        return callback(
          new BlockedUrlError(hostname, "hostname resolves to a non-public address") as NodeJS.ErrnoException,
          ""
        );
      }
      if (options.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

/**
 * undici connector: IP-literal hosts never go through DNS lookup, so they are
 * checked here; names are checked by the guarded lookup at connect time.
 */
export function createGuardedConnector(lookup: LookupFn = createGuardedLookup()): buildConnector.connector {
  const base = buildConnector({ lookup: lookup as never, timeout: 10_000 });
  return (options, callback) => {
    const hostError = checkHostname(options.hostname);
    if (hostError) {
      callback(new BlockedUrlError(options.hostname, hostError), null);
      return;
    }
    if (!ALLOWED_PORTS.has(String(options.port ?? ""))) {
      callback(new BlockedUrlError(`${options.hostname}:${options.port}`, `port ${options.port} not allowed`), null);
      return;
    }
    return base(options, callback);
  };
}

export function createGuardedAgent(lookup?: LookupFn): Agent {
  return new Agent({ connect: createGuardedConnector(lookup) });
}

let installed = false;

/** Route every `fetch()` in this process through the guarded agent. */
export function installNetworkGuard(): void {
  if (installed) return;
  setGlobalDispatcher(createGuardedAgent());
  installed = true;
}
