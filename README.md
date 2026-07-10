# CraftPlanner

CraftPlanner est une application desktop communautaire, gratuite et non officielle pour planifier n'importe quelle liste d'items et de crafts DOFUS.

![Icône CraftPlanner](assets/app-icon.png)

## Présentation

CraftPlanner transforme une liste libre d'objets DOFUS en plan de collecte et de fabrication exploitable. L'application reconnaît les items, additionne les doublons, ajoute les panoplies complètes et décompose récursivement les recettes pour distinguer ce qui doit être crafté de ce qui doit être directement obtenu.

La recherche, les calculs et les images utilisent une base locale commune stockée dans le profil Windows de l'utilisateur. Au lancement, l'application vérifie les données DofusDB, complète ce qui manque et reste utilisable hors ligne une fois la synchronisation terminée.

## Fonctionnalités

- Recherche locale parmi les équipements, consommables, ressources et panoplies.
- Collage de listes avec quantités, fautes légères, commentaires entre parenthèses et choix avec `ou`.
- Ajout d'une panoplie complète sous forme d'items individuels.
- Agrégation exacte des doublons et classement automatique par catégorie.
- Quantités possédées ajustables au clavier ou à la molette au survol.
- Cases à cocher synchronisées avec les quantités, sans double comptage.
- Plan de craft récursif : base à craft, sous-crafts, ingrédients et items non craftables.
- Verrouillage logique des crafts déjà validés pour éviter les incohérences de calcul.
- Tri enrichi des ressources par récoltables, origines de monstres, familles, types et ordre alphabétique.
- Liens directs vers les fiches DofusDB.
- Modes clair et sombre.
- Synchronisation automatique des données, recettes, panoplies et images utiles.
- Mises à jour automatiques signées.

## Utilisation

1. Rechercher un item ou une panoplie, ou coller directement une liste complète.
2. Ajuster les quantités requises dans la liste sélectionnée.
3. Indiquer progressivement les quantités déjà possédées.
4. Ouvrir le plan de craft pour suivre les crafts principaux, sous-crafts et ingrédients agrégés.

Les items terminés descendent automatiquement en bas de leur colonne. Les quantités et coches sont conservées entre les lancements.

## Données hors ligne

La base locale commune est stockée dans :

```text
%LOCALAPPDATA%\DofusCompanionData
```

Elle contient le catalogue DofusDB synchronisé, les recettes, les panoplies, les images utiles et les échecs d'images déjà connus. Les images inutiles ou devenues obsolètes sont nettoyées après une synchronisation réussie.

Les données manuelles propres au fonctionnement de l'application restent séparées des données automatiquement synchronisables afin qu'une mise à jour ne les écrase pas.

## Télécharger

La dernière version Windows et ses notes sont disponibles dans les [releases GitHub](https://github.com/jdtaccounts-create/CraftPlanner/releases/latest).

Fichier recommandé :

- `CraftPlanner_x.x.x_x64-setup.exe` pour l'installation classique Windows.

## Désinstallation

La désinstallation Windows retire l'application installée. Le dossier `%LOCALAPPDATA%\DofusCompanionData` n'est pas supprimé automatiquement, car il peut être partagé par plusieurs outils locaux utilisant les mêmes données DOFUS.

Pour tout supprimer après avoir désinstallé les outils concernés, supprimer manuellement :

```text
%LOCALAPPDATA%\DofusCompanionData
```

## Développement local

```powershell
npm install
npm test
npm run smoke
npm run build
npm run dev
```

Ouvrir ensuite `http://127.0.0.1:5175`.

## Publication

La procédure de build signé et de release est décrite dans [RELEASE.md](RELEASE.md). La clé privée de signature ne doit jamais être affichée ni commitée.

## Crédits et droits

CraftPlanner n'est affilié ni à Ankama ni à DofusDB. Les crédits détaillés, conditions d'utilisation des données et mentions de droits figurent dans [NOTICE.md](NOTICE.md).
