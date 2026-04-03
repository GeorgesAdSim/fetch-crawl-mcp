#!/bin/bash
set -e

echo "=== Fetch Crawl MCP — Deploy ==="

# Build TypeScript locally
echo "Building TypeScript..."
npm run build

# Build Docker image
echo "Building Docker image..."
docker build -t fetch-crawl-mcp:latest .

# Stop existing container if running
echo "Stopping existing container..."
docker stop fetch-crawl-mcp 2>/dev/null || true
docker rm fetch-crawl-mcp 2>/dev/null || true

# Start new container
echo "Starting new container..."
docker compose up -d

# Wait for health check
echo "Waiting for health check..."
sleep 5
curl -s http://localhost:3001/health | jq .

echo "=== Deploy complete ==="
echo "MCP endpoint: http://localhost:3001/mcp"
echo "Health check: http://localhost:3001/health"
