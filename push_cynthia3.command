#!/bin/bash
cd /Users/fazprod/Desktop/cynthia
rm -f .git/HEAD.lock
git add cynthia_v2.html
git commit -m "fix(critical): dreamJob lisait window.CYNTH_CONTEXT (inexistant) au lieu de quizAnswers.metierReve; masque la demo-bar en prod (evite reset accidentel du questionnaire)"
git push origin main
echo ""
echo "✅ Push terminé. Cette fenêtre peut être fermée."
