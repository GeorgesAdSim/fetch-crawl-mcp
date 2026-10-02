#!/bin/bash
set -e
echo "=== Fetch Crawl MCP — Deploy ==="
if [ -z "${FETCH_CRAWL_TOKENS:-}" ] && ! grep -qs '^FETCH_CRAWL_TOKENS=.\+' .env; then
  echo "❌ FETCH_CRAWL_TOKENS manquant (variable ou fichier .env) : le serveur refuserait de démarrer."
  exit 1
fi
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
# Le port n'est pas publié sur l'hôte (Traefik uniquement) : on vérifie dans le conteneur.
if docker exec fetch-crawl-mcp curl -sf http://localhost:3001/health > /dev/null; then
  echo "✅ Health check OK"
  docker exec fetch-crawl-mcp curl -s http://localhost:3001/health
  echo ""
else
  echo "❌ Health check failed"
  docker logs fetch-crawl-mcp --tail 20
  exit 1
fi
echo ""
echo "=== Deploy complete ==="
echo "MCP endpoint: https://fetch.mcp.adsim.be/mcp (jeton requis)"
echo "Health check: https://fetch.mcp.adsim.be/health"
