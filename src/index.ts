#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

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

  const app = express();
  app.use(express.json());

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", name: "fetch-crawl-mcp", version: "4.0.0" });
  });

  // MCP endpoint
  app.post("/mcp", async (req, res) => {
    try {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // SSE not supported in stateless mode
  app.get("/mcp", (_req, res) => {
    res
      .status(405)
      .json({ error: "SSE not supported in stateless mode" });
  });

  // Session termination not supported in stateless mode
  app.delete("/mcp", (_req, res) => {
    res
      .status(405)
      .json({ error: "Session termination not supported in stateless mode" });
  });

  app.listen(port, () => {
    console.log(`Fetch Crawl MCP server running on http://localhost:${port}`);
    console.log(`MCP endpoint: http://localhost:${port}/mcp`);
    console.log(`Health check: http://localhost:${port}/health`);
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
