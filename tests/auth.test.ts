import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extractToken, isValidToken, loadAuthConfig, requireAuth } from "../src/auth.js";

const TOKEN_A = "a".repeat(32);
const TOKEN_B = "b".repeat(40);

describe("loadAuthConfig", () => {
  it("loads a comma-separated token list", () => {
    const cfg = loadAuthConfig({ FETCH_CRAWL_TOKENS: ` ${TOKEN_A} , ${TOKEN_B} ,` } as NodeJS.ProcessEnv);
    expect(cfg.tokens).toHaveLength(2);
    expect(cfg.allowUnauthenticated).toBe(false);
  });

  it("refuses short tokens", () => {
    expect(() => loadAuthConfig({ FETCH_CRAWL_TOKENS: "short" } as NodeJS.ProcessEnv)).toThrow(/at least/);
  });

  it("refuses to run open in production", () => {
    expect(() => loadAuthConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/refusing/);
  });

  it("allows an open server only when explicitly requested, or outside production", () => {
    expect(loadAuthConfig({ NODE_ENV: "production", ALLOW_UNAUTHENTICATED: "true" } as NodeJS.ProcessEnv).allowUnauthenticated).toBe(true);
    expect(loadAuthConfig({ NODE_ENV: "development" } as NodeJS.ProcessEnv).allowUnauthenticated).toBe(true);
  });
});

describe("token extraction and comparison", () => {
  const cfg = loadAuthConfig({ FETCH_CRAWL_TOKENS: `${TOKEN_A},${TOKEN_B}` } as NodeJS.ProcessEnv);

  it("reads Bearer header first, then ?token=", () => {
    expect(extractToken({ headers: { authorization: `Bearer ${TOKEN_A}` }, query: {} } as never)).toBe(TOKEN_A);
    expect(extractToken({ headers: { authorization: `bearer  ${TOKEN_A} ` }, query: {} } as never)).toBe(TOKEN_A);
    expect(extractToken({ headers: {}, query: { token: TOKEN_B } } as never)).toBe(TOKEN_B);
    expect(extractToken({ headers: { authorization: "Basic xyz" }, query: {} } as never)).toBeNull();
  });

  it("accepts any configured token and nothing else", () => {
    expect(isValidToken(TOKEN_A, cfg)).toBe(true);
    expect(isValidToken(TOKEN_B, cfg)).toBe(true);
    expect(isValidToken(TOKEN_A + "x", cfg)).toBe(false);
    expect(isValidToken("", cfg)).toBe(false);
    expect(isValidToken(null, cfg)).toBe(false);
  });
});

describe("requireAuth over HTTP", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    const auth = requireAuth(loadAuthConfig({ FETCH_CRAWL_TOKENS: TOKEN_A } as NodeJS.ProcessEnv));
    app.get("/health", (_req, res) => res.json({ status: "ok" }));
    app.post("/mcp", auth, (_req, res) => res.json({ reached: true }));
    await new Promise<void>((r) => {
      server = app.listen(0, "127.0.0.1", () => r());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("keeps /health public", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("rejects missing or wrong tokens with 401", async () => {
    const none = await fetch(`${base}/mcp`, { method: "POST" });
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    const wrong = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${TOKEN_B}` } });
    expect(wrong.status).toBe(401);
  });

  it("accepts the token in the header or the query string", async () => {
    const header = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${TOKEN_A}` } });
    expect(await header.json()).toEqual({ reached: true });
    const query = await fetch(`${base}/mcp?token=${TOKEN_A}`, { method: "POST" });
    expect(query.status).toBe(200);
  });
});
