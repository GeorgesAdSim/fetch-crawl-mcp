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
# Construire via compose : c'est l'image que compose démarre ensuite
# (un `docker build -t ...` séparé produirait une image que compose n'utilise pas).
docker compose build
echo "Step 3+4: Recreating container..."
docker compose up -d --force-recreate
echo "Step 5: Waiting for health check..."
# Le conteneur doit être "healthy" pour que Traefik le route (sinon 404 public).
for i in $(seq 1 18); do
  [ "$(docker inspect -f {{.State.Health.Status}} fetch-crawl-mcp)" = "healthy" ] && break
  sleep 5
done
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
