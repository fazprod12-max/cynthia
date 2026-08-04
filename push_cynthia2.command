#!/bin/bash
cd /Users/fazprod/Desktop/cynthia
rm -f .git/HEAD.lock
git add cynthia_v2.html
git commit -m "fix(critical): retry synthèse perdait tout le contexte profil — hallucination métiers hors-sujet"
git push origin main
echo ""
echo "✅ Push terminé. Cette fenêtre peut être fermée."
