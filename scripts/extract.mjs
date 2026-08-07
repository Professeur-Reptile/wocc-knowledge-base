#!/usr/bin/env node
// -----------------------------------------------------------------------------
// World of ClaudeCraft — extraction pipeline
// -----------------------------------------------------------------------------
// Ce script :
//   1. Télécharge le code source du repo à un tag donné (via codeload.github.com,
//      qui contourne les limites de débit de l'API GitHub classique).
//   2. Bundle les modules de données du jeu (src/sim/data.ts, src/sim/world_boss.ts)
//      en CommonJS avec esbuild — le code "sim" du jeu n'a aucune dépendance DOM
//      (voir CLAUDE.md du repo), donc aucun stub n'est nécessaire.
//   3. Exécute ce bundle dans Node pour obtenir les vraies structures de données
//      du jeu (mobs, items, quêtes, donjons, etc.) — pas une recopie manuelle
//      potentiellement fausse, mais les données réelles telles qu'utilisées en jeu.
//   4. Écrit un JSON par catégorie dans le dossier de sortie.
//
// Usage :
//   node scripts/extract.mjs <tag> <outputDir>
//   node scripts/extract.mjs v0.21.0 ./data
//   node scripts/extract.mjs latest ./data   (résout automatiquement le dernier tag)
//   node scripts/extract.mjs v0.25.0 ./data --repo /chemin/vers/un/clone
//     (--repo : utilise un clone local du jeu au lieu de télécharger l'archive ;
//      le tag passé sert uniquement à renseigner _meta.json)
//
// Prérequis : Node 18+, et esbuild installé (npm install esbuild).
// -----------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);

const REPO = 'levy-street/world-of-claudecraft';

// Version du schéma d'extraction, recopiée dans _meta.json. Le workflow
// update-knowledge-base.yml relance une extraction quand ce numéro (lu dans
// package.json, champ "kbSchema") diffère de celui de _meta.json — sans ça,
// un enrichissement du pipeline n'était appliqué qu'à la MAJ suivante du jeu.
const SCHEMA_VERSION = require('../package.json').kbSchema;

const argv = process.argv.slice(2);
const repoFlag = argv.indexOf('--repo');
const localRepoPath = repoFlag !== -1 ? path.resolve(argv[repoFlag + 1]) : null;
if (repoFlag !== -1) argv.splice(repoFlag, 2);
const [tagArg = 'latest', outDirArg = './data'] = argv;
const outDir = path.resolve(outDirArg);

// ---------------------------------------------------------------------------
// Étape 0 — résoudre "latest" en un vrai nom de tag si besoin
// ---------------------------------------------------------------------------
// Le nom du tag vient d'un repo qu'on ne contrôle pas : on le valide avant
// tout usage (il finit dans une URL et des chemins de fichiers).
function assertSafeTag(tag) {
  if (!/^[A-Za-z0-9._+-]+$/.test(tag)) {
    throw new Error(`Nom de tag invalide ou suspect : ${JSON.stringify(tag)}`);
  }
  return tag;
}

async function resolveTag(tag) {
  if (tag !== 'latest') return assertSafeTag(tag);
  const res = await fetch(`https://api.github.com/repos/${REPO}/tags?per_page=1`, {
    headers: { 'User-Agent': 'wocc-knowledge-pipeline' },
  });
  if (!res.ok) throw new Error(`Impossible de lister les tags : HTTP ${res.status}`);
  const tags = await res.json();
  if (!tags.length) throw new Error('Aucun tag trouvé sur le repo.');
  return assertSafeTag(tags[0].name);
}

// ---------------------------------------------------------------------------
// Étape 1 — télécharger et extraire l'archive du tag
// ---------------------------------------------------------------------------
function downloadAndExtract(tag, workDir) {
  assertSafeTag(tag);
  const url = `https://codeload.github.com/${REPO}/tar.gz/refs/tags/${tag}`;
  const archivePath = path.join(workDir, 'repo.tar.gz');
  console.log(`[1/4] Téléchargement de ${url}`);
  // execFileSync (sans shell) : les arguments ne sont jamais interprétés,
  // même si le nom du tag contenait des caractères spéciaux.
  execFileSync('curl', ['-sL', '-o', archivePath, url], { stdio: 'inherit' });

  const stat = fs.statSync(archivePath);
  if (stat.size < 10_000) {
    throw new Error(
      `Archive suspicieusement petite (${stat.size} octets) — le tag "${tag}" existe-t-il ?`,
    );
  }

  console.log(`[1/4] Extraction (${(stat.size / 1024 / 1024).toFixed(1)} Mo)`);
  execFileSync('tar', ['-xzf', archivePath, '-C', workDir], { stdio: 'inherit' });

  const extracted = fs.readdirSync(workDir).find((f) => f.startsWith('world-of-claudecraft-'));
  if (!extracted) throw new Error("Dossier extrait introuvable — le format de l'archive a changé ?");
  return path.join(workDir, extracted);
}

// ---------------------------------------------------------------------------
// Étape 2 — bundler les modules de données avec esbuild
// ---------------------------------------------------------------------------
async function bundleModule(repoPath, entryRelPath, outFile) {
  await esbuild.build({
    entryPoints: [path.join(repoPath, entryRelPath)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: outFile,
    logLevel: 'warning',
    // Les modules d'interface (talent_i18n → i18n) lisent les variables de
    // build de Vite, absentes hors navigateur : on les fige côté extraction.
    define: {
      'import.meta.env.PROD': 'false',
      'import.meta.env.DEV': 'true',
      'import.meta.env.MODE': '"production"',
    },
  });
}

// ---------------------------------------------------------------------------
// Étape 3 — charger le bundle et dumper chaque registre en JSON
// ---------------------------------------------------------------------------
function dumpRegistries(bundlePath, registryNames, outDir) {
  const mod = require(bundlePath);

  for (const name of registryNames) {
    if (!(name in mod)) {
      console.warn(`  ⚠ Registre "${name}" introuvable dans le bundle — ignoré.`);
      continue;
    }
    const file = path.join(outDir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(mod[name], null, 2));
    const count = Array.isArray(mod[name]) ? mod[name].length : Object.keys(mod[name]).length;
    console.log(`  ✓ ${name} → ${file} (${count} entrées)`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const tag = localRepoPath ? assertSafeTag(tagArg) : await resolveTag(tagArg);
  console.log(`=== World of ClaudeCraft knowledge extraction — tag ${tag} ===`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wocc-'));
  fs.mkdirSync(outDir, { recursive: true });

  try {
    const repoPath = localRepoPath ?? downloadAndExtract(tag, workDir);
    if (localRepoPath) console.log(`[1/4] Clone local : ${localRepoPath}`);

    console.log('[2/4] Bundling des modules de données (esbuild)');
    const dataBundlePath = path.join(workDir, 'data.bundle.cjs');
    const worldBossBundlePath = path.join(workDir, 'worldboss.bundle.cjs');
    await bundleModule(repoPath, 'src/sim/data.ts', dataBundlePath);
    await bundleModule(repoPath, 'src/sim/world_boss.ts', worldBossBundlePath);

    console.log('[3/4] Extraction des registres en JSON');
    dumpRegistries(dataBundlePath, [
      'MOBS',
      'ITEMS',
      'ITEM_SETS',
      'NPCS',
      'QUESTS',
      'ZONES',
      'DUNGEONS',
      'DELVES',
      'GATHER_NODES',
      'FISHING_TABLES',
    ], outDir);
    dumpRegistries(worldBossBundlePath, ['WORLD_BOSSES'], outDir);

    // v0.34.0 : FISHING_TABLES n'est plus ré-exporté par data.ts (la pêche a
    // été refondue autour de fishing_zones.ts) mais vit toujours dans
    // content/items.ts — sans ce repli, data/FISHING_TABLES.json restait
    // silencieusement figé sur le tag précédent.
    if (!('FISHING_TABLES' in require(dataBundlePath))) {
      try {
        const itemsBundlePath = path.join(workDir, 'content_items.bundle.cjs');
        await bundleModule(repoPath, 'src/sim/content/items.ts', itemsBundlePath);
        dumpRegistries(itemsBundlePath, ['FISHING_TABLES'], outDir);
      } catch (err) {
        console.warn(`  ⚠ FISHING_TABLES non extrait via content/items.ts : ${err.message}`);
      }
    }

    // Butins des boss finaux en difficulté Héroïque : ils vivent dans un module
    // dédié (non ré-exporté par data.ts), introduit avec la v0.23.0 — toléré
    // absent pour les tags plus anciens.
    try {
      const heroicBundlePath = path.join(workDir, 'heroic.bundle.cjs');
      await bundleModule(repoPath, 'src/sim/content/heroic_loot.ts', heroicBundlePath);
      dumpRegistries(heroicBundlePath, ['HEROIC_BOSS_LOOT'], outDir);
    } catch (err) {
      console.warn(`  ⚠ Butin héroïque non extrait (tag antérieur à v0.23.0 ?) : ${err.message}`);
    }

    // Recettes de fabrication (ré-exportées par data.ts, donc déjà bundlées).
    dumpRegistries(dataBundlePath, ['ALL_RECIPES'], outDir);

    // Stock du quartier-maître héroïque (bijoux payés en Heroic Marks) et
    // boutiques de delve (pièces payées en Marks, avec leurs conditions de
    // déblocage) : les seules sources de plusieurs cous/anneaux épiques et des
    // pièces « reliquary »/« litany » — sans elles, le Codex affichait à tort
    // « aucune source » pour ces objets. Tolérés absents (tags plus anciens).
    try {
      const vendorBundlePath = path.join(workDir, 'heroic_vendor.bundle.cjs');
      await bundleModule(repoPath, 'src/sim/content/heroic_vendor.ts', vendorBundlePath);
      dumpRegistries(vendorBundlePath, ['HEROIC_VENDOR_STOCK'], outDir);
    } catch (err) {
      console.warn(`  ⚠ Stock du quartier-maître héroïque non extrait : ${err.message}`);
    }
    try {
      const delveShopBundlePath = path.join(workDir, 'delve_shop.bundle.cjs');
      await bundleModule(repoPath, 'src/sim/content/delves/shop.ts', delveShopBundlePath);
      dumpRegistries(delveShopBundlePath, ['DELVE_SHOPS'], outDir);
    } catch (err) {
      console.warn(`  ⚠ Boutiques de delve non extraites : ${err.message}`);
    }

    // Compagnons de delve : DELVES référence companion_tessa/companion_edda,
    // dont le gabarit de monstre vit sous un autre id (mobTemplateId) dans ce
    // registre — sans lui, la fiche « Compagnon » du Codex restait vide.
    try {
      const companionsPath = path.join(workDir, 'delve_companions.bundle.cjs');
      await bundleModule(repoPath, 'src/sim/content/delves/companions.ts', companionsPath);
      dumpRegistries(companionsPath, ['DELVE_COMPANIONS'], outDir);
    } catch (err) {
      console.warn(`  ⚠ Compagnons de delve non extraits : ${err.message}`);
    }

    // Sorts de classes : registre ABILITIES de classes.ts — et CLASSES (specs,
    // équipement de départ startWeapon/startChest, la source des objets
    // « recruit_tunic » et compagnie).
    try {
      const classesBundlePath = path.join(workDir, 'classes.bundle.cjs');
      await bundleModule(repoPath, 'src/sim/content/classes.ts', classesBundlePath);
      dumpRegistries(classesBundlePath, ['ABILITIES', 'CLASSES'], outDir);
    } catch (err) {
      console.warn(`  ⚠ Sorts non extraits : ${err.message}`);
    }

    // Talents : un registre par classe (talents_classic.ts + talents_warrior.ts),
    // fusionnés en un seul TALENTS.json { classe: [nœuds...] }.
    try {
      const classicPath = path.join(workDir, 'talents_classic.bundle.cjs');
      const warriorPath = path.join(workDir, 'talents_warrior.bundle.cjs');
      await bundleModule(repoPath, 'src/sim/content/talents_classic.ts', classicPath);
      await bundleModule(repoPath, 'src/sim/content/talents_warrior.ts', warriorPath);
      const classic = require(classicPath);
      const warrior = require(warriorPath);
      const TALENTS = {};
      for (const [cls, key] of [
        ['druid','DRUID_TALENTS'], ['hunter','HUNTER_TALENTS'], ['mage','MAGE_TALENTS'],
        ['paladin','PALADIN_TALENTS'], ['priest','PRIEST_TALENTS'], ['rogue','ROGUE_TALENTS'],
        ['shaman','SHAMAN_TALENTS'], ['warlock','WARLOCK_TALENTS'],
      ]) {
        if (key in classic) TALENTS[cls] = classic[key];
        else console.warn(`  ⚠ Registre "${key}" introuvable dans talents_classic.`);
      }
      if ('WARRIOR_TALENTS' in warrior) TALENTS.warrior = warrior.WARRIOR_TALENTS;

      // Talents 2.0 (v0.27.0) : les rangées de choix ne vivent plus dans les
      // registres *_TALENTS (réduits aux spés + maîtrises) mais dans
      // talent_rows.ts (ROW_TREES, agrégé par classe). Sans cette étape,
      // TALENTS.json perdait toutes les rangées — et les fiches « talent »
      // du site (codex-popup) ne trouvaient plus rien.
      try {
        const rowsPath = path.join(workDir, 'talent_rows.bundle.cjs');
        await bundleModule(repoPath, 'src/sim/content/talent_rows.ts', rowsPath);
        const rowsMod = require(rowsPath);
        const trees = rowsMod.ROW_TREES || {};
        let rowCount = 0;
        for (const [cls, rows] of Object.entries(trees)) {
          if (!TALENTS[cls]) TALENTS[cls] = { class: cls, specs: [] };
          TALENTS[cls].rows = rows;
          rowCount += (rows || []).length;
        }
        console.log(`  ✓ Rangées de talents fusionnées (${rowCount} rangées)`);
      } catch (err) {
        console.warn(`  ⚠ Rangées de talents non extraites (tag antérieur à v0.27.0 ?) : ${err.message}`);
      }

      fs.writeFileSync(path.join(outDir, 'TALENTS.json'), JSON.stringify(TALENTS, null, 2));
      console.log(`  ✓ TALENTS → TALENTS.json (${Object.keys(TALENTS).length} classes)`);
    } catch (err) {
      console.warn(`  ⚠ Talents non extraits : ${err.message}`);
    }

    // Enchantements : depuis les Métiers 2.0 (v0.27.0), les recettes vivent
    // dans un vrai registre (src/sim/content/enchants.ts) — extractible comme
    // le reste. Le guide Enchantement du site reste éditorial, mais ces
    // données permettent de le vérifier (et de l'automatiser un jour).
    try {
      const enchantsPath = path.join(workDir, 'enchants.bundle.cjs');
      await bundleModule(repoPath, 'src/sim/content/enchants.ts', enchantsPath);
      dumpRegistries(enchantsPath, ['ENCHANTS'], outDir);
    } catch (err) {
      console.warn(`  ⚠ Enchantements non extraits (tag antérieur à v0.27.0 ?) : ${err.message}`);
    }

    // Butin des Failles (v0.32.0) : les récompenses de victoire (épiques
    // garantis, légendaires S, rênes de monture, essence/gemmes) sont
    // attribuées PAR LE CODE (rift/progression.ts, addRiftClearGearLoot) au
    // moment de la victoire — jamais par une table de butin statique. Sans ce
    // bloc, le Codex et le BiS du site voyaient ces objets « sans source ».
    // On assemble un RIFT_LOOT.json : quelles pièces viennent de quel rang,
    // avec les taux réels du jeu. Toléré absent (tags antérieurs à v0.32.0).
    try {
      const riftItemsPath = path.join(workDir, 'rift_items.bundle.cjs');
      await bundleModule(repoPath, 'src/sim/content/rift/items.ts', riftItemsPath);
      const riftItems = require(riftItemsPath);
      const riftProgPath = path.join(workDir, 'rift_progression.bundle.cjs');
      await bundleModule(repoPath, 'src/sim/rift/progression.ts', riftProgPath);
      const riftProg = require(riftProgPath);
      const RIFT_LOOT = {
        // Le pool de l'épique de victoire garanti (rang B et au-dessus).
        epicIds: riftItems.RIFT_EPIC_ITEM_IDS ?? [],
        // Les deux légendaires exclusifs du rang S, tirés indépendamment.
        legendaryIds: riftItems.RIFT_LEGENDARY_ITEM_IDS ?? [],
        legendaryChanceS: riftProg.RIFT_LEGENDARY_CHANCE_S ?? null,
        // Les rares « world-drop » des ambiances (trash + boss d'ambiance).
        rareIds: riftItems.RIFT_RARE_ITEM_IDS ?? [],
        // L'équipement personnel du first-clear (anneaux riftbound) + la forge.
        gearIds: riftItems.RIFT_GEAR_ITEM_IDS ?? [],
        gemIds: riftItems.RIFT_GEM_IDS ?? [],
        essenceItemId: riftItems.RIFT_ESSENCE_ITEM_ID ?? null,
        // Rênes de monture par rang (chaque rang ne tire que son palier).
        mounts: {
          B: { reins: riftProg.RIFT_GREEN_MOUNT_REINS ?? [], chance: riftProg.RIFT_GREEN_MOUNT_CHANCE ?? null },
          A: { reins: riftProg.RIFT_BLUE_MOUNT_REINS ?? [], chance: riftProg.RIFT_BLUE_MOUNT_CHANCE ?? null },
          S: { reins: riftProg.RIFT_EPIC_MOUNT_REINS ?? [], chance: riftProg.RIFT_EPIC_MOUNT_CHANCE ?? null },
        },
        coinBonus: {
          C: riftProg.RIFT_COIN_BONUS_C ?? null,
          B: riftProg.RIFT_COIN_BONUS_B ?? null,
          A: riftProg.RIFT_COIN_BONUS_A ?? null,
          S: riftProg.RIFT_COIN_BONUS_S ?? null,
        },
      };
      fs.writeFileSync(path.join(outDir, 'RIFT_LOOT.json'), JSON.stringify(RIFT_LOOT, null, 2));
      console.log(`  ✓ RIFT_LOOT → RIFT_LOOT.json (${RIFT_LOOT.epicIds.length} épiques, ${RIFT_LOOT.legendaryIds.length} légendaires, ${RIFT_LOOT.rareIds.length} rares)`);
    } catch (err) {
      console.warn(`  ⚠ Butin des Failles non extrait (tag antérieur à v0.32.0 ?) : ${err.message}`);
    }

    // Noms officiels FRANÇAIS des entités (v0.34.0 : les 21 locales du jeu
    // sont complètes). Source : le catalogue résolu fr_FR du client
    // (src/ui/i18n.resolved.generated/fr_FR.ts), la vérité de ce que le
    // joueur voit dans un client en français. On n'extrait QUE les noms —
    // les descriptions du site sont traduites éditorialement côté
    // La-Clauderie (assets/codex-fr.json), la traduction du jeu ayant été
    // jugée trop inégale pour être affichée telle quelle. Clés par TYPE DU
    // CODEX (ability/item/mob/…) pour être consommé tel quel par
    // codex-popup.js. Les talents n'y sont pas : le client FR garde
    // volontairement leurs noms anglais (talent_i18n.row_title_overrides.ts,
    // « fantasy names as proper names »). Toléré absent (tags < v0.34.0).
    try {
      const frPath = path.join(workDir, 'i18n_fr.bundle.cjs');
      await bundleModule(repoPath, 'src/ui/i18n.resolved.generated/fr_FR.ts', frPath);
      const ent = (require(frPath).fr_FR || {}).entities || {};
      const CAT_TO_TYPE = {
        abilities: 'ability', items: 'item', mobs: 'mob', npcs: 'npc',
        quests: 'quest', zones: 'zone', dungeons: 'dungeon', delves: 'delve',
        itemSets: 'set',
      };
      // Les pages du site référencent les entités tantôt par id, tantôt par
      // nom anglais (data-codex="item|Reins of the Valorsteed") : chaque map
      // porte donc DEUX clés par entité — l'id, et le nom anglais « replié »
      // (même normalisation que fold() de codex-popup.js : accents ôtés,
      // apostrophes droites, minuscules). Les deux pointent le même nom FR.
      const foldName = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[’‘]/g, "'").toLowerCase().trim();
      const asList = (reg) => Array.isArray(reg) ? reg : Object.values(reg || {});
      const enNames = {};   // type -> { id -> nom anglais }
      const EN_SOURCES = {
        item: 'ITEMS', mob: 'MOBS', npc: 'NPCS', quest: 'QUESTS', zone: 'ZONES',
        dungeon: 'DUNGEONS', delve: 'DELVES', set: 'ITEM_SETS',
      };
      const dataMod = require(dataBundlePath);
      for (const [type, reg] of Object.entries(EN_SOURCES)) {
        enNames[type] = {};
        for (const e of asList(dataMod[reg])) if (e && e.id) enNames[type][e.id] = e.name || e.title;
      }
      try {
        const classesMod = require(path.join(workDir, 'classes.bundle.cjs'));
        enNames.ability = {};
        for (const e of asList(classesMod.ABILITIES)) if (e && e.id) enNames.ability[e.id] = e.name;
      } catch { /* sorts non bundlés (tag ancien) : clés par id seulement */ }

      const I18N_FR = {};
      let n = 0, ambiguous = 0;
      for (const [cat, type] of Object.entries(CAT_TO_TYPE)) {
        const src = ent[cat] || {};
        const out = {};
        // Le jeu réutilise des noms d'affichage anglais pour des entités
        // DIFFÉRENTES (deux sorts mage « Aether Surge », des dizaines d'objets
        // normal/héroïque homonymes…). Une clé par nom replié ne peut donc
        // être émise que si toutes les entités qui la partagent portent le
        // MÊME nom français — sinon on affichait le nom d'une autre entité
        // (incident du 4 août 2026 : « Aether Surge (Pouvoir des Arcanes) »
        // alors que le site parlait d'arcane_surge, « Déferlante d'Aether »).
        // Les clés par id, elles, restent toujours exactes.
        const byFolded = new Map();
        for (const [id, e] of Object.entries(src)) {
          const name = e && (e.name || e.title);
          if (typeof name !== 'string' || !name) continue;
          out[id] = name; n++;
          const en = enNames[type] && enNames[type][id];
          if (!en) continue;
          const k = foldName(en);
          if (!byFolded.has(k)) byFolded.set(k, new Set());
          byFolded.get(k).add(name);
        }
        for (const [k, names] of byFolded) {
          if (names.size === 1) out[k] ??= [...names][0];
          else ambiguous++;
        }
        // Les entités dupliquées par le contenu (variantes « heroic_… » d'un
        // objet, qui portent le MÊME nom affiché) n'ont pas leur propre entrée
        // dans le catalogue du client : on leur recopie le nom français de
        // l'entité homonyme, sinon le site laissait ces objets sans nom FR
        // alors que le jeu, lui, les nomme comme leur version normale.
        for (const [id, en] of Object.entries(enNames[type] || {})) {
          if (out[id] || !en) continue;
          const shared = out[foldName(en)];
          if (shared) out[id] = shared;
        }
        if (Object.keys(out).length) I18N_FR[type] = out;
      }
      // Noms de TALENTS : ils ne vivent pas dans le catalogue d'entités mais
      // dans une cascade propre au client (src/ui/talent_i18n.ts) — nom du
      // sort accordé, puis titres délibérément gardés en anglais, puis
      // traductions dédiées. On appelle SA fonction, `localizeTalentTitle`,
      // plutôt que de réimplémenter la règle : « Second Wind » → « Second
      // souffle », « Typhoon » → « Typhon », et les noms que le jeu laisse
      // volontairement en anglais restent en anglais (ils ne sont alors pas
      // écrits ici, donc le site n'affiche rien à côté — comme en jeu).
      try {
        const talentI18nPath = path.join(workDir, 'talent_i18n.bundle.cjs');
        await bundleModule(repoPath, 'src/ui/talent_i18n.ts', talentI18nPath);
        const { localizeTalentTitle } = require(talentI18nPath);
        const talentsMod = require(path.join(workDir, 'talents_classic.bundle.cjs'));
        const rowsMod = require(path.join(workDir, 'talent_rows.bundle.cjs'));
        const titles = new Set();
        for (const rows of Object.values(rowsMod.ROW_TREES || {}))
          for (const row of rows || [])
            for (const opt of row.options || []) if (opt?.name) titles.add(opt.name);
        for (const key of Object.keys(talentsMod)) {
          const tree = talentsMod[key];
          for (const node of (tree && tree.nodes) || []) {
            if (node?.name) titles.add(node.name);
            for (const ch of node.choices || []) if (ch?.name) titles.add(ch.name);
          }
        }
        const out = {};
        let translated = 0;
        for (const title of titles) {
          const fr = localizeTalentTitle(title, 'fr_FR');
          // Un titre que le jeu laisse en anglais n'est pas écrit : le site
          // n'affichera donc rien, exactement comme le client français.
          if (fr && fr !== title) { out[foldName(title)] = fr; translated++; }
        }
        if (translated) I18N_FR.talent = out;
        console.log(`  ✓ Talents : ${translated} titres français sur ${titles.size} (le reste reste en anglais en jeu)`);
      } catch (err) {
        console.warn(`  ⚠ Titres de talents non localisés : ${err.message}`);
      }

      fs.writeFileSync(path.join(outDir, 'I18N_FR.json'), JSON.stringify(I18N_FR, null, 2));
      console.log(`  ✓ I18N_FR → I18N_FR.json (${n} noms français, ${ambiguous} nom(s) anglais ambigu(s) écarté(s))`);
    } catch (err) {
      console.warn(`  ⚠ Noms français non extraits (tag antérieur à v0.34.0 ?) : ${err.message}`);
    }

    // Correspondances d'ICÔNES. Deux cas que le nommage « <id>.webp » ne couvre
    // pas, et qui laissaient des cases vides sur le site :
    //   - les ARMES n'ont pas d'art par id : le jeu leur rend une vignette
    //     partagée par modèle 3D (public/ui/weapons/<modèle>.jpg), via la table
    //     ITEM_WEAPON_VARIANTS ;
    //   - les SORTS ont des icônes peintes pour une partie d'entre eux
    //     (public/ui/skills/<classe>/<id>.webp), listés par ABILITY_IMAGE_IDS ;
    //     les autres sont dessinés proceduralement par le client, donc sans
    //     fichier — le site ne doit alors rien afficher plutôt qu'une image au
    //     hasard.
    try {
      const variantsPath = path.join(workDir, 'weapon_variants.bundle.cjs');
      await bundleModule(repoPath, 'src/ui/weapon_variants.ts', variantsPath);
      const weapons = require(variantsPath).ITEM_WEAPON_VARIANTS || {};
      const iconsPath = path.join(workDir, 'icons.bundle.cjs');
      await bundleModule(repoPath, 'src/ui/icons.ts', iconsPath);
      const iconsMod = require(iconsPath);
      const abilityIcons = [...(iconsMod.ABILITY_IMAGE_IDS || [])];
      const ICONS = { weapons, abilityIcons };
      fs.writeFileSync(path.join(outDir, 'ICONS.json'), JSON.stringify(ICONS, null, 2));
      console.log(`  ✓ ICONS → ICONS.json (${Object.keys(weapons).length} armes, ${abilityIcons.length} icônes de sorts)`);
    } catch (err) {
      console.warn(`  ⚠ Correspondances d'icônes non extraites : ${err.message}`);
    }

    // Un petit fichier de métadonnées pour tracer d'où vient l'extraction.
    fs.writeFileSync(
      path.join(outDir, '_meta.json'),
      JSON.stringify(
        // sha : le commit du tag, fourni par le workflow (GAME_TAG_SHA) pour
        // détecter les re-tags — un tag re-poussé garde son nom mais change
        // de commit, et l'archive codeload suit toujours le commit courant.
        {
          tag,
          sha: process.env.GAME_TAG_SHA || null,
          schema: SCHEMA_VERSION,
          extractedAt: new Date().toISOString(),
          repo: REPO,
        },
        null,
        2,
      ),
    );

    console.log(`[4/4] Terminé. Données écrites dans ${outDir}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Échec de l\'extraction :', err.message);
  process.exit(1);
});
