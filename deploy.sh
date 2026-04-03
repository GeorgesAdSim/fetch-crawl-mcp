#!/bin/bash
set -e
echo "=== Fetch Crawl MCP v4.0.0 — Deploy ==="
echo "Step 1: Building TypeScript..."
npm run build
echo "Step 2: Building Docker image..."
docker build -t fetch-crawl-mcp:latest .
echo "Step 3: Stopping existing container..."
docker stop fetch-crawl-mcp 2>/dev/null || true
docker rm fetch-crawl-mcp 2>/dev/null || true
echo "Step 4: Starting new container..."
docker compose up -d
echo "Step 5: Waiting for health check..."
sleep 5
if curl -sf http://localhost:3001/health > /dev/null; then
  echo "✅ Health check OK"
  curl -s http://localhost:3001/health | python3 -m json.tool 2>/dev/null || curl -s http://localhost:3001/health
else
  echo "❌ Health check failed"
  docker logs fetch-crawl-mcp --tail 20
  exit 1
fi
echo ""
echo "=== Deploy complete ==="
echo "MCP endpoint: http://localhost:3001/mcp"
echo "Health check: http://localhost:3001/health"
echo ""
echo "Pour exposer en HTTPS, configurer un reverse proxy :"
echo "  Nginx: proxy_pass http://localhost:3001;"
echo "  Caddy: reverse_proxy localhost:3001"
