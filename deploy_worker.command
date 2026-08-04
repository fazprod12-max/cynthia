#!/bin/bash
cd /Users/fazprod/Desktop/Cynth.IA/refonte_deepseek/worker
echo "=== Déploiement du Worker Cloudflare ==="
npx wrangler deploy
echo ""
echo "✅ Déploiement terminé. Cette fenêtre peut être fermée."
