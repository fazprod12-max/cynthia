#!/bin/bash
cd /Users/fazprod/Desktop/cynthia
rm -f .git/HEAD.lock
git add cynthia_v2.html
git commit -m "fix(critical): presélection métiers pertinents anti-hallucination (fini le toujours dev-web/UX/data-analyst par défaut) + détection provider:fallback (fini la dégradation silencieuse invisible) + compteur de pannes IA"
git push origin main
echo ""
echo "✅ Push terminé. Cette fenêtre peut être fermée."
