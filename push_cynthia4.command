#!/bin/bash
cd /Users/fazprod/Desktop/cynthia
rm -f .git/HEAD.lock
git add cynthia_v2.html
git commit -m "fix(critical): rapport IA generateOrientationReport() - JSON Object Mode Groq + system/user prompt split (0% succes -> fix structurel)"
git push origin main
echo ""
echo "✅ Push HTML terminé. Cette fenêtre peut être fermée."
