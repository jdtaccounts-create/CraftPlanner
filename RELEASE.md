# Publication CraftPlanner

## Identité

- Dépôt local : `D:\GitHub\CraftPlanner`
- Dépôt GitHub : `jdtaccounts-create/CraftPlanner`
- Identifiant Tauri : `fr.moufle.craftplanner`
- Clé privée locale : `C:\Users\Moufle\.tauri\updater-keys\craftplanner.key`
- Clé publique locale : `C:\Users\Moufle\.tauri\updater-keys\craftplanner.key.pub`

Le contenu de la clé privée ne doit jamais être affiché ni commité.

## Procédure

1. Mettre à jour la version dans `package.json`, `package-lock.json`, `src-tauri/Cargo.toml` et `src-tauri/tauri.conf.json`.
2. Exécuter `npm test`, `npm run smoke`, `npm run verify:images` et `npm run build`.
3. Charger la clé privée locale dans `TAURI_SIGNING_PRIVATE_KEY` uniquement pour la durée du build.
4. Exécuter `npx tauri build --bundles nsis`.
5. Exécuter `npm run release:latest`.
6. Publier l'installateur NSIS, sa signature et `latest.json` dans la release GitHub correspondant à la version.

La clé publique seule est inscrite dans `src-tauri/tauri.conf.json`.
