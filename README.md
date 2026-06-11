# CraftPlanner

CraftPlanner est une application desktop communautaire, gratuite et non officielle pour planifier n'importe quelle liste d'items et de crafts DOFUS.

![Icône CraftPlanner](assets/app-icon.png)

## Présentation

CraftPlanner transforme une liste libre d'objets DOFUS en plan de collecte et de fabrication exploitable. L'application reconnaît les items, additionne les doublons, ajoute les panoplies complètes et décompose récursivement les recettes pour distinguer ce qui doit être crafté de ce qui doit être directement obtenu.

Elle fonctionne à partir d'un catalogue local complet afin que la recherche, les calculs et les images restent rapides et disponibles hors ligne. Au lancement, CraftPlanner vérifie discrètement les données DofusDB et répare automatiquement les éléments manquants lorsqu'une connexion est disponible.

## Fonctionnalités

- Recherche locale parmi les équipements, consommables, ressources et panoplies.
- Collage de listes avec compréhension des quantités, fautes légères, commentaires entre parenthèses et choix avec `ou`.
- Ajout d'une panoplie complète sous forme d'items individuels.
- Agrégation exacte des doublons et classement automatique par catégorie.
- Quantités possédées ajustables précisément au clavier ou à la molette, avec coches synchronisées.
- Plan de craft récursif : bases à craft, sous-crafts, ingrédients et items non craftables.
- Agrégation correcte des ressources communes et état cohérent lorsqu'un item est à la fois craft principal et sous-craft.
- Liens directs vers les fiches DofusDB.
- Modes clair et sombre.
- Données et images dédupliquées embarquées pour rester utilisable hors ligne.
- Synchronisation automatique des données et réparation des images manquantes.
- Mises à jour automatiques signées avec redémarrage de l'application.

## Utilisation

1. Rechercher un item ou une panoplie, ou coller directement une liste complète.
2. Ajuster les quantités requises dans la liste sélectionnée.
3. Indiquer progressivement les quantités déjà possédées.
4. Ouvrir le plan de craft pour suivre les crafts principaux, sous-crafts et ingrédients agrégés.

Les items terminés descendent automatiquement en bas de leur colonne. Les quantités et coches sont conservées entre les lancements.

## Télécharger

La dernière version Windows et ses notes sont disponibles dans les [releases GitHub](https://github.com/jdtaccounts-create/CraftPlanner/releases/latest).

## Développement local

```powershell
npm install
npm test
npm run verify:images
npm run dev
```

Ouvrir ensuite `http://127.0.0.1:5175`.

## Vérifications

```powershell
npm test
npm run smoke
npm run verify:images
npm run build
```

## Données

- `public/data/generated` contient les données automatiquement synchronisables.
- `public/data/curated` contient les corrections manuelles qui ne doivent jamais être écrasées.
- `public/cache/images` contient les images embarquées utilisables hors ligne.
- `npm run verify:images` vérifie avant publication que chaque image locale référencée est bien embarquée.

Les données proviennent de DofusDB. Utilisation soumise à la LPNC-IA 1.0.

## Crédits et droits

CraftPlanner n'est affilié ni à Ankama ni à DofusDB. Les crédits détaillés, conditions d'utilisation des données et mentions de droits figurent dans [NOTICE.md](NOTICE.md).
