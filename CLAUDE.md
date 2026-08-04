# WoCC Knowledge Base

> **Style de réponse** : l'utilisateur veut des réponses COURTES. Aller à
> l'essentiel, pas de longs exposés ni de listes exhaustives.

- Repo 100 % automatisé : `data/*.json` est généré par `scripts/extract.mjs`
  (workflow `update-knowledge-base.yml`, cron 5 min) — **ne jamais éditer
  `data/` à la main**.
- `data/I18N_FR.json` : noms officiels FRANÇAIS des entités, extraits du
  catalogue fr_FR du client (le jeu est traduit depuis la v0.34.0). Chaque
  entrée a deux clés — l'id du jeu et le nom anglais replié — vers le même
  nom FR. Consommé par `assets/codex-popup.js` côté La-Clauderie (noms
  discrets sur les pages FR + sous-titres des fiches). Noms seulement : les
  DESCRIPTIONS françaises sont éditoriales, côté site
  (`assets/codex-fr.json`, charte dans `scripts/check_codex_fr.py`).
- La barre de navigation de `site/index.html` est chargée depuis
  `https://laclauderie.fr/assets/nav.js` (source unique côté La-Clauderie).
- Le hook `.claude/hooks/session-start.sh` clone le code du jeu en lecture
  seule dans `../world-of-claudecraft`. En session multi-repos il ne se
  déclenche pas tout seul : si le clone est absent, le lancer à la main
  (`bash .claude/hooks/session-start.sh`).
- Runbook complet de l'écosystème : `La-Clauderie/CLAUDE.md`.
