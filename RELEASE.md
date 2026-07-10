# Publication CraftPlanner

## Identité

- Dépôt local : `D:\GitHub\CraftPlanner`
- Dépôt GitHub : `jdtaccounts-create/CraftPlanner`
- Identifiant Tauri : `fr.moufle.craftplanner`
- Clé privée updater locale : `C:\Users\Moufle\.tauri\updater-keys\craftplanner.key`
- Clé publique updater locale : `C:\Users\Moufle\.tauri\updater-keys\craftplanner.key.pub`

Le contenu de la clé privée ne doit jamais être affiché ni commité.

## Checklist

1. Fermer toute instance lancée de l'application.
2. Mettre à jour la version dans `package.json`, `package-lock.json`, `src-tauri/Cargo.toml` et `src-tauri/tauri.conf.json`.
3. Vérifier que `src-tauri/tauri.conf.json` contient la clé publique updater.
4. Exécuter les tests et le build frontend.
5. Charger la clé privée dans `TAURI_SIGNING_PRIVATE_KEY` uniquement pour la durée du build Tauri.
6. Générer les bundles Windows et les artefacts updater.
7. Générer ou vérifier `latest.json`.
8. Publier l'installateur NSIS, le MSI, les signatures et `latest.json` dans la release GitHub correspondant au tag.

## Commandes

```powershell
npm install
npm test
npm run smoke
npm run build

$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "C:\Users\Moufle\.tauri\updater-keys\craftplanner.key"
npm run tauri -- build
Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY

npm run release:latest
```

## Données locales

L'application utilise `%LOCALAPPDATA%\DofusCompanionData` pour la base DofusDB commune et les images utiles. Ce dossier n'est pas supprimé par l'installeur ou le désinstalleur afin d'éviter d'effacer des données encore utilisées par d'autres outils locaux.

Pour tester une réinstallation silencieuse locale, utiliser l'installateur NSIS avec `/S /currentuser`. Le flag `/currentuser` force la restauration correcte des clés Windows de désinstallation pour l'installation utilisateur. L'auto-update Tauri transmet aussi ce flag via `plugins.updater.windows.installerArgs`.

Les mises à jour automatiques utilisent le verrou commun `%LOCALAPPDATA%\DofusCompanionData\sync.lock` avec la phase `app-update`. Cela évite que plusieurs apps installent une mise à jour en même temps ou qu'une mise à jour se superpose à une synchronisation de données.

Après une synchronisation réussie, l'application nettoie les images partagées devenues obsolètes.
