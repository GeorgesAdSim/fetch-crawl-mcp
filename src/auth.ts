/**
 * Bearer-token authentication for the HTTP transports.
 *
 * Tokens come from FETCH_CRAWL_TOKENS (comma-separated, one per client, so a
 * leaked token can be revoked alone). A request is accepted with either:
 *   - header  `Authorization: Bearer <token>`  (preferred), or
 *   - query   `?token=<token>`  for clients that cannot send headers
 *     (e.g. a Claude.ai custom connector configured with a URL only).
 *     Query tokens can end up in proxy logs: use a dedicated token there.
 *
 * Without tokens the server refuses to start in production, unless
 * ALLOW_UNAUTHENTICATED=true is set explicitly (local development only).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const MIN_TOKEN_LENGTH = 24;

export interface AuthConfig {
  tokens: Buffer[];
  allowUnauthenticated: boolean;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const raw = (env.FETCH_CRAWL_TOKENS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const tooShort = raw.filter((t) => t.length < MIN_TOKEN_LENGTH);
  if (tooShort.length > 0) {
    throw new Error(`FETCH_CRAWL_TOKENS: every token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const allowUnauthenticated = env.ALLOW_UNAUTHENTICATED === "true";
  if (raw.length === 0 && !allowUnauthenticated && env.NODE_ENV === "production") {
    throw new Error(
      "FETCH_CRAWL_TOKENS is empty: refusing to start an open server in production " +
        "(set ALLOW_UNAUTHENTICATED=true only for local development)"
    );
  }
  return { tokens: raw.map(digest), allowUnauthenticated: raw.length === 0 };
}

export function extractToken(req: Pick<Request, "headers" | "query">): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  const query = req.query?.token;
  if (typeof query === "string" && query) return query;
  return null;
}

/** Constant-time comparison against every configured token. */
export function isValidToken(token: string | null, config: AuthConfig): boolean {
  if (!token) return false;
  const candidate = digest(token);
  let ok = false;
  for (const expected of config.tokens) {
    // Always compare against all tokens: no early exit timing signal.
    if (timingSafeEqual(candidate, expected)) ok = true;
  }
  return ok;
}

export function requireAuth(config: AuthConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (config.allowUnauthenticated) return next();
    if (isValidToken(extractToken(req), config)) return next();
    res.setHeader("WWW-Authenticate", 'Bearer realm="fetch-crawl-mcp"');
    res.status(401).json({ error: "Unauthorized" });
  };
}
