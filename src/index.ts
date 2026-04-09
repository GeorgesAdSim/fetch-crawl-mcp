#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8")
);

const args = process.argv.slice(2);
const isHttpMode = args.includes("--http");
const portIndex = args.indexOf("--port");
const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3001;

async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Fetch Crawl MCP server running on stdio");
}

async function startHttp() {
  const { default: express } = await import("express");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const { SSEServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/sse.js"
  );

  const app = express();
  app.use(express.json());

  // SSE session store
  const sseTransports = new Map<string, InstanceType<typeof SSEServerTransport>>();

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", name: "fetch-crawl-mcp", version: pkg.version });
  });

  // --- Streamable HTTP (stateless) ---

  app.head("/mcp", (_req, res) => {
    res.setHeader("MCP-Protocol-Version", "2025-06-18");
    res.status(200).end();
  });

  app.post("/mcp", async (req, res) => {
    try {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({ error: "SSE not supported on /mcp. Use GET /sse instead." });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({ error: "Session termination not supported in stateless mode" });
  });

  // --- SSE transport (for Claude.ai connector) ---

  app.get("/sse", async (_req, res) => {
    try {
      const server = createServer();
      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;

      sseTransports.set(sessionId, transport);
      console.log(`SSE session created: ${sessionId} (active: ${sseTransports.size})`);

      res.on("close", () => {
        sseTransports.delete(sessionId);
        console.log(`SSE session closed: ${sessionId} (active: ${sseTransports.size})`);
      });

      await server.connect(transport);
    } catch (error) {
      console.error("Error creating SSE session:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to create SSE session" });
      }
    }
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string | undefined;

    if (!sessionId) {
      res.status(400).json({ error: "Missing sessionId query parameter" });
      return;
    }

    const transport = sseTransports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: "Session not found. It may have expired." });
      return;
    }

    try {
      await transport.handlePostMessage(req, res);
    } catch (error) {
      console.error(`Error handling message for session ${sessionId}:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to handle message" });
      }
    }
  });

  app.listen(port, () => {
    console.log(`Fetch Crawl MCP server running on http://localhost:${port}`);
    console.log(`Streamable HTTP: POST http://localhost:${port}/mcp`);
    console.log(`SSE endpoint:    GET  http://localhost:${port}/sse`);
    console.log(`SSE messages:    POST http://localhost:${port}/messages`);
    console.log(`Health check:    GET  http://localhost:${port}/health`);
  });
}

async function main() {
  if (isHttpMode) {
    await startHttp();
  } else {
    await startStdio();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
