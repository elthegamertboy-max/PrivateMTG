const fs = require('fs');
const readline = require('readline');
const zlib = require('zlib');
const https = require('https');

const formats = [
    { title: "commander", code: "EDH" },
    { title: "modern", code: "MD" },
    { title: "vintage", code: "VI" },
    { title: "standard", code: "ST" },
    { title: "pauper", code: "PA" },
    { title: "legacy", code: "LG" },
    { title: "pioneer", code: "PI" }
];

const FR_CARDS_PATH = './cardFr.json';

// Préfixe appliqué à tout id de print "sibling" (non-oracle_id) — élimine par construction
// tout risque de collision avec un oracle_id, qui reste toujours un UUID brut sans préfixe.
const PRINT_ID_PREFIX = 'p-';

// Renommages manuels d'id, à toi de maintenir : { "ancien_id": "nouvel_id" }.
// Toute carte déjà sauvegardée dans un deck sous "ancien_id" continuera à être résolue
// correctement, indéfiniment, sans jamais casser les decks existants.
const RENAMED_IDS = {
    // "vieil-id-carte-x": "nouvel-id-carte-x",
};

// Ajoute un alias pour chaque entrée de RENAMED_IDS, uniquement si la cible existe réellement.
function applyManualRenames(result) {
    Object.entries(RENAMED_IDS).forEach(([oldId, newId]) => {
        if (result[newId]) {
            setResultSafe(result, oldId, { id: oldId, aliasOf: newId }, 'RENAMED_IDS');
        } else {
            console.warn(`⚠️  RENAMED_IDS: cible "${newId}" introuvable pour l'ancien id "${oldId}" — alias non créé.`);
        }
    });
}

// Aplatit les chaînes d'alias (A->B->C devient A->C) pour que la résolution côté app
// reste un lookup direct à un seul niveau, même après plusieurs renommages successifs.
function flattenAliasChains(result) {
    Object.values(result).forEach((entry) => {
        if (!entry.aliasOf) return;
        let target = entry.aliasOf;
        let hops = 0;
        while (result[target] && result[target].aliasOf && hops < 10) {
            target = result[target].aliasOf;
            hops++;
        }
        entry.aliasOf = target;
    });
}


// --- Helpers pour gérer les cartes sans champs top-level (ex: reversible_card) ---

function getEffectiveTypeLine(c) {
    if (c.type_line) return c.type_line;
    if (c.card_faces) {
        return c.card_faces.map(f => f.type_line).filter(Boolean).join(' // ');
    }
    return '';
}

function getEffectiveOracleId(c) {
    if (c.oracle_id) return c.oracle_id;
    if (c.card_faces && c.card_faces[0] && c.card_faces[0].oracle_id) {
        return c.card_faces[0].oracle_id;
    }
    return undefined;
}

function getEffectiveCmc(c) {
    if (c.cmc !== undefined && c.cmc !== null) return c.cmc;
    if (c.card_faces && c.card_faces[0] && c.card_faces[0].cmc !== undefined) {
        return c.card_faces[0].cmc;
    }
    return 0;
}

function countCost(str) {
    if (!str) return 0;
    const matches = str.match(/\{([^}]+)\}/g);
    if (!matches) return 0;
    return matches.reduce((sum, token) => {
        const content = token.slice(1, -1);
        if (!isNaN(content)) return sum + parseInt(content, 10);
        if (content === 'X') return sum;
        return sum + 1;
    }, 0);
}

function getCardType(typeLine, setType, name) {
    const t = typeLine.toLowerCase();
    if (t.includes("battle")) return "Battle";
    if (t.includes("creature")) return "Creature";
    if (t.includes("land") && !t.includes("lander")) return "Land";
    if (t.includes("attraction")) return "Artifact - Attraction";
    if (t.includes("artifact")) return "Artifact";
    if (t.includes("enchantment — aura")) return "Enchantment - Aura";
    if (t.includes("enchantment")) return "Enchantment";
    if (t.includes("instant")) return "Instant";
    if (t.includes("sorcery")) return "Sorcery";
    if (t.includes("planeswalker")) return "Planeswalker";
    if (t.includes("emblem")) return "Emblem";
    if (t.includes("card") && !setType.includes("memorabilia") && !setType.includes("minigame") && !name.includes("Checklist")) return "Card";
    return "Other";
}

function getImages(c) {
    let colors = [], image = {};
    if (c.card_faces && c.card_faces[0].image_uris) {
        image.front = c.card_faces[0].image_uris.normal;
        image.back = (c.card_faces[1] && c.card_faces[1].image_uris) ? c.card_faces[1].image_uris.normal : undefined;
        colors = c.card_faces[0].colors ? [...c.card_faces[0].colors] : [];
        if (c.card_faces[1] && c.card_faces[1].colors) {
            c.card_faces[1].colors.forEach(color => {
                if (!colors.includes(color)) colors.push(color);
            });
        }
    } else if (c.image_uris) {
        image.front = c.image_uris.normal;
        colors = c.colors || [];
    }
    return { image, colors };
}

function getPowerToughness(value) {
    if (!value || /[+\-.*?∞]/.test(value)) return 0;
    return Math.trunc(value);
}

const setCustomLegality = (card, value, force) => {
    formats.forEach(f => {
        card._legal[f.code] = force || card._legal[f.code] === true ? value : false;
    });
};

const handleLegalityOveride = (newCard, oracle_id) => {
    if ([
        "47e191f7-6314-4875-b5ee-57e5daf089c4", // Dragon's approach
        "3c1619bd-db5e-4df6-a196-0a9d62374f6d", // Hare apparent
        "0e488c6c-aae2-450f-b969-7bb5a1b37a66", // Persistent petioner
        "ec77d23b-0165-450d-9aae-73b755163753", // Rat colony
        "104ea189-14cd-420f-afdc-57b0f827ab8e", // Relentless rats
        "595a15f0-77f3-4544-8acc-10630e12cc14", // Shadowborn apostle
        "b53597f4-1a0f-4fa8-9c17-29178cdc4d2b", // Slime against humanity
        "7423b3b9-56eb-4cf2-8ada-135918219c4b", // Tempest hawk
        "f9453fe2-fadf-4cd4-8d2c-0eaa0e2d78d6", // Templar knigh
        "87050537-99c9-4993-a770-4329b2e749e4"  // Cid, Timeless artificier
    ].includes(oracle_id)) {
        setCustomLegality(newCard, 200);
    }

    // Nazgul
    if (oracle_id === "48a62778-7c11-486f-a0e1-020c283a7ef9") {
        setCustomLegality(newCard, 9);
    }

    // Seven dwarf
    if (oracle_id === "526ca4a9-3f50-4f7a-8169-2bda95792401") {
        setCustomLegality(newCard, 7);
    }

    // Basic lands
    if ([
        "05d24b0c-904a-46b6-b42a-96a4d91a0dd4", // Wastes
        "56719f6a-1a6c-4c0a-8d21-18f7d7350b68", // Swamp
        "a3fb7228-e76b-4e96-a40e-20b5fed75685", // Mountain
        "b2c6aa39-2d2a-459c-a555-fb48ba993373", // Island
        "b34bb2dc-c1af-4d77-b0b3-a0fb342a5fc6", // Forest
        "bc71ebf6-2056-41f7-be35-b2e5c34afa99", // Plains

        "46a07b53-ff58-4bd6-80dd-ded2eb0e29a3", // Snow Wastes
        "d8239a86-7184-4005-ba1e-2dddcd756c47", // Snow Swamp
        "ca9f660b-e07d-4f42-a46e-abd0ca72510c", // Snow Mountain
        "5b2460a5-6ae5-4cad-ba94-1a9e98e6e4c0", // Snow Island
        "5f0d3be8-e63e-4ade-ae58-6b0c14f2ce6d", // Snow Forest
        "ac8cc74d-e43b-4118-bba0-dfa8b9c04d45", // Snow Plains

        "195287aa-cdb6-496f-b796-2bfdc7a6e0c9"  // Barry"s land
    ].includes(oracle_id)) {
        setCustomLegality(newCard, 99);
    }
};

// Construit recto/verso en anglais — pour oracle.json ET les impressions EN supplémentaires de all.json
// Le nom combiné "A // B" est toujours au niveau racine (c.name), même pour les reversible_card.
// Si les deux faces ont le même nom (reversible_card), on ne garde qu'un seul objet (front).
function buildFaceEn(c, image) {
    let front, back;

    if (c.card_faces && c.card_faces.length >= 1) {
        const faceFront = c.card_faces[0];
        const faceBack = c.card_faces[1];

        const rootNameParts = c.name ? c.name.split(' // ') : [];
        const nameFront = rootNameParts[0] || faceFront.name;
        const nameBack = rootNameParts[1] || (faceBack ? faceBack.name : undefined);

        const globalSplitType = c.type_line ? c.type_line.split(' // ') : [];
        const typeLineFront = faceFront.type_line || globalSplitType[0] || '';
        const typeFront = getCardType(typeLineFront, c.set_type, c.name);

        front = {
            name: { en: nameFront },
            type: typeFront,
            cost: Math.trunc(countCost(faceFront.mana_cost)),
            isHorizontal: typeFront == "Battle",
            image: { en: image.front }
        };

        if (faceBack && image.back) {
            const typeLineBack = faceBack.type_line || globalSplitType[1] || typeLineFront;
            const typeBack = getCardType(typeLineBack, c.set_type, c.name);
            back = {
                name: { en: nameBack },
                type: typeBack,
                cost: Math.trunc(countCost(faceBack.mana_cost)),
                isHorizontal: typeBack == "Battle",
                image: { en: image.back }
            };
        }

        if (c.layout == "split" || c.layout == "adventure") {
            front.isHorizontal = !((c.keywords || []).includes("Aftermath") || c.layout == "adventure");
        }
    } else {
        const typeLine = getEffectiveTypeLine(c);
        const type = getCardType(typeLine, c.set_type, c.name);
        front = {
            name: { en: c.name },
            type,
            cost: Math.trunc(getEffectiveCmc(c)),
            isHorizontal: c.layout == "split" || type == "Battle",
            image: { en: image.front }
        };
    }

    return back ? { front, back } : { front };
}

// Greffe name/image d'une langue sur une carte déjà connue (retrouvée via set+collector_number)
function graftTranslation(existingCard, c, lang) {
    if (!existingCard || !existingCard.face || !existingCard.face.front) return;

    const { image } = getImages(c);
    const hasUsableImage = c.image_status === 'lowres' || c.image_status === 'highres_scan';

    // Nom racine (même logique d'aplatissement "A // A" -> "A" que côté anglais)
    if (existingCard.name && typeof existingCard.name === 'object') {
        const rootLocalizedForName = c.printed_name || c.name;
        existingCard.name[lang] = collapseSameSidesName(rootLocalizedForName);
    }

    if (c.card_faces && c.card_faces.length >= 1) {
        const faceFront = c.card_faces[0];
        const faceBack = c.card_faces[1];

        const rootLocalized = c.printed_name || c.name;
        const rootParts = rootLocalized ? rootLocalized.split(' // ') : [];
        const nameFront = rootParts[0] || faceFront.printed_name || faceFront.name;
        const nameBack = rootParts[1] || (faceBack ? (faceBack.printed_name || faceBack.name) : undefined);

        existingCard.face.front.name[lang] = nameFront;
        if (hasUsableImage && image.front) existingCard.face.front.image[lang] = image.front;

        // Ne renseigne le verso que si existingCard en a un (pas collapsé lors de l'étape EN)
        if (existingCard.face.back && faceBack) {
            existingCard.face.back.name[lang] = nameBack;
            if (hasUsableImage && image.back) existingCard.face.back.image[lang] = image.back;
        }
    } else {
        existingCard.face.front.name[lang] = c.printed_name || c.name;
        if (hasUsableImage && image.front) existingCard.face.front.image[lang] = image.front;
    }
}

function shouldIncludeCard(c, type) {
    const typeLine = getEffectiveTypeLine(c);
    if (type != "Other" && c.layout != "art_series" && !c.name.includes(" // Wanted!")) return true;
    if (typeLine.includes("Dungeon")) return true;
    return false;
}

// Objet carte "de base" en anglais, id assigné par l'appelant (oracle_id ou id propre)
// Aplatit un nom "A // A" en "A" quand les deux moitiés sont identiques
// (cas des reversible_card comme Jinnie Fay) ; laisse "A // B" intact sinon.
// Réutilisé pour le nom anglais ET pour chaque traduction greffée.
// Détecte les tokens/émblèmes/cartes spéciales (utilisé pour le flag isToken ET pour exclure
// les réimpressions de tokens du scan de all.json, où elles n'apportent aucune valeur : oracle.json
// fournit déjà une entrée par oracle_id, seule nécessaire pour la résolution des `tokens: [...]`).
function isTokenLikeCard(typeLine, c, type) {
    return typeLine.includes("oken") || c.set_type === "token" || type === "Emblem" || type === "Card";
}

function collapseSameSidesName(fullName) {
    if (!fullName) return fullName;
    const parts = fullName.split(' // ');
    if (parts.length === 2 && parts[0] === parts[1]) {
        return parts[0];
    }
    return fullName;
}

function buildCardObject(c, image, colors, type, allCards) {
    const oracleId = getEffectiveOracleId(c);
    const cmc = getEffectiveCmc(c);
    const typeLine = getEffectiveTypeLine(c);

    const newCard = {
        id: null,
        name: { en: collapseSameSidesName(c.name) },
        type,
        face: buildFaceEn(c, image),
        Colors: colors,
        "Card type": typeLine,
        "Color identity": c.color_identity,
        set: c.set,
        collector_number: c.collector_number,
        isHorizontal: c.layout == "split" || type == "Battle",
        cost: Math.trunc(cmc),
        _legal: {}
    };

    formats.forEach(f => {
        newCard._legal[f.code] = c.legalities[f.title] === "legal";
    });

    if (c.power) newCard.power = getPowerToughness(c.power);
    if (c.toughness) newCard.toughness = getPowerToughness(c.toughness);

    handleLegalityOveride(newCard, oracleId);

    if (isTokenLikeCard(typeLine, c, type)) {
        newCard.isToken = true;
        setCustomLegality(newCard, true, true);
    }

    if (c.all_parts) {
        const tokens = c.all_parts
            .filter(p => (p.component === "token" || p.type_line.includes("Dungeon")) && allCards[p.id])
            .map(p => allCards[p.id]);
        if (tokens.length) newCard.tokens = tokens;
    }

    return newCard;
}

const printKey = (c) => `${c.set}|${c.collector_number}`;

// Garde-fou : détecte toute collision de clé accidentelle (oracle_id vs id de print, par exemple)
// avant qu'une entrée n'en écrase silencieusement une autre. Le risque réel est astronomiquement
// faible (UUID v4 tirés du même espace, ~10^-26 avec le volume de cartes actuel), mais autant
// être avertis plutôt que de perdre une carte sans le savoir si ça arrivait un jour.
function setResultSafe(result, key, value, sourceLabel) {
    const existing = result[key];
    if (existing !== undefined && existing !== value) {
        console.warn(`⚠️  Collision d'id détectée sur la clé "${key}" (source: ${sourceLabel}) — une entrée différente est écrasée. Ceci ne devrait jamais arriver.`);
    }
    result[key] = value;
}

// Étape 0 : indexation légère (regex) id -> oracle_id, pour la résolution des tokens
function buildAllCardsIndex(allCardsPath) {
    return new Promise((resolve, reject) => {
        console.log("Étape 0 : indexation id -> oracle_id sur all.json...");
        const allCards = {};
        const idRegex = /"id"\s*:\s*"([^"]+)"/;
        const oracleIdRegex = /"oracle_id"\s*:\s*"([^"]+)"/;
        let currentId = null;

        const rl = readline.createInterface({ input: fs.createReadStream(allCardsPath), crlfDelay: Infinity });

        rl.on('line', (line) => {
            const idMatch = line.match(idRegex);
            if (idMatch) currentId = idMatch[1];

            const oracleMatch = line.match(oracleIdRegex);
            if (oracleMatch && currentId) {
                allCards[currentId] = oracleMatch[1];
                currentId = null;
            }
        });

        rl.on('close', () => resolve(allCards));
        rl.on('error', reject);
    });
}

// Étape 1 : oracle.json — une carte par oracle_id, anglais, version la plus récente
function processOracleFile(inputFilePath, allCards, result, savedPrints) {
    return new Promise((resolve, reject) => {
        console.log("Étape 1 : traitement de oracle.json...");
        const rl = readline.createInterface({ input: fs.createReadStream(inputFilePath), crlfDelay: Infinity });

        rl.on('line', (line) => {
            if (!line.trim()) return;
            let c;
            try { c = JSON.parse(line); } catch (e) {
                console.error('Erreur parsing ligne oracle:', e.message);
                return;
            }

            const { image, colors } = getImages(c);
            const type = getCardType(getEffectiveTypeLine(c), c.set_type, c.name);
            if (!shouldIncludeCard(c, type)) return;

            const newCard = buildCardObject(c, image, colors, type, allCards);
            const oracleId = getEffectiveOracleId(c);
            // L'entrée par défaut reste keyée sur l'oracle_id (comportement actuel, inchangé) :
            // ça reprend toujours automatiquement la dernière version sortie à chaque régénération.
            newCard.id = oracleId;

            setResultSafe(result, oracleId, newCard, 'oracle.json');
            savedPrints.set(printKey(c), newCard);

            // Alias : préserve l'id scryfall PROPRE du print actuellement choisi comme représentant.
            // Si ce print redevient un simple sibling à une régénération future (remplacé par un
            // autre choix), il retrouvera son entrée complète habituelle via l'étape 2a — donc sa
            // clé propre n'a jamais disparu, ni pendant qu'il est représentant ni après. Un deck qui
            // avait sauvegardé cet id précis (via le sélecteur de variantes) le retrouve toujours.
            if (c.id && c.id !== oracleId) {
                const printId = PRINT_ID_PREFIX + c.id;
                setResultSafe(result, printId, { id: printId, aliasOf: oracleId }, 'oracle.json (alias)');
            }
        });

        rl.on('close', resolve);
        rl.on('error', reject);
    });
}

// Étape 2a : all.json, passage anglais — ajoute les impressions EN pas déjà connues, via leur propre id
function processAllCardsEnglish(allCardsPath, allCards, result, savedPrints) {
    return new Promise((resolve, reject) => {
        console.log("Étape 2a : all.json, passage anglais...");
        const rl = readline.createInterface({ input: fs.createReadStream(allCardsPath), crlfDelay: Infinity });

        rl.on('line', (line) => {
            if (!line.trim()) return;
            let c;
            try { c = JSON.parse(line); } catch (e) { return; }
            if (c.lang !== 'en') return;

            const key = printKey(c);
            if (savedPrints.has(key)) return; // déjà ajoutée via oracle.json

            const { image, colors } = getImages(c);
            const type = getCardType(getEffectiveTypeLine(c), c.set_type, c.name);
            if (!shouldIncludeCard(c, type)) return;

            // Ne jamais ajouter les réimpressions de tokens comme siblings : oracle.json fournit
            // déjà une entrée par oracle_id pour chaque token, seule nécessaire à la résolution
            // des `tokens: [...]`. Les autres réimpressions (dizaines par set) ne servent à rien
            // ici et gonflent le fichier pour un jeton qu'on ne propose jamais en variant-picker.
            if (isTokenLikeCard(getEffectiveTypeLine(c), c, type)) return;

            const newCard = buildCardObject(c, image, colors, type, allCards);
            const printId = PRINT_ID_PREFIX + c.id;
            newCard.id = printId;

            setResultSafe(result, printId, newCard, 'all.json (sibling EN)');
            savedPrints.set(key, newCard);
        });

        rl.on('close', resolve);
        rl.on('error', reject);
    });
}

// Étape 2b : fichier de langue traduite — greffe name/image sur les cartes déjà connues.
// Les cartes du fichier qui ne trouvent pas d'hôte (aucun print EN avec le même set+collector_number)
// sont ignorées : ça arrive pour des sets exclusifs à une langue (ex: fbb, 4bb, psal), pas de bug.
function processTranslationFile(filePath, lang, savedPrints) {
    return new Promise((resolve, reject) => {
        console.log(`Étape 2b : ${filePath}, passage ${lang}...`);
        let seen = 0;
        let grafted = 0;
        let imageMissingCount = 0; // diagnostic: image_status utilisable mais aucune image greffée

        const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });

        rl.on('line', (line) => {
            if (!line.trim()) return;
            let c;
            try { c = JSON.parse(line); } catch (e) { return; }
            if (c.lang !== lang) return;
            seen++;

            const existingCard = savedPrints.get(printKey(c));
            if (!existingCard) return; // aucune impression EN connue pour ce set+collector_number

            const imageBefore = existingCard.face.front.image ? existingCard.face.front.image[lang] : undefined;
            graftTranslation(existingCard, c, lang);
            grafted++;

            const imageAfter = existingCard.face.front.image ? existingCard.face.front.image[lang] : undefined;
            const isUsable = c.image_status === 'lowres' || c.image_status === 'highres_scan';
            if (isUsable && !imageBefore && !imageAfter) {
                imageMissingCount++;
                if (imageMissingCount <= 5) {
                    console.warn(`  ⚠️  image_status="${c.image_status}" mais image ${lang} non greffée: ${c.set}|${c.collector_number} (${c.name})`);
                }
            }
        });

        rl.on('close', () => {
            console.log(`  -> ${lang}: ${seen} impressions dans ${filePath}, ${grafted} greffées, ${seen - grafted} sans hôte (ignorées)`);
            if (imageMissingCount > 0) {
                console.warn(`  ⚠️  ${imageMissingCount} cas highres sans image greffée au total (voir avertissements ci-dessus pour les 5 premiers)`);
            }
            resolve();
        });
        rl.on('error', reject);
    });
}

// --- Mise à jour de cardFr.json (upsert par id), inline pour ne pas dépendre de fetch-fr-cards.js ---
// fetch-fr-cards.js reste disponible tel quel comme script indépendant, à lancer à la main si besoin.

const FR_SEARCH_URL = 'https://api.scryfall.com/cards/search?order=released&q=lang%3Afr';
const FR_FETCH_DELAY_MS = 550; // marge sous le rate limit de 2 req/s de Scryfall

function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function frHttpGetJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: {
                'User-Agent': 'TCGArena-FrCardFetcher/1.0',
                'Accept': 'application/json'
            }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(frHttpGetJson(res.headers.location));
            }

            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode} sur ${url} — ${raw.slice(0, 300)}`));
                }
                try {
                    resolve(JSON.parse(raw));
                } catch (e) {
                    reject(new Error(`JSON invalide depuis ${url}: ${e.message}`));
                }
            });
        }).on('error', reject);
    });
}

// Ne garde que les champs réellement lus par graftTranslation/processTranslationFile :
// tout le reste (URIs, légalités par format, prix, artiste, texte des règles...) est mort
// poids dans cardFr.json — cette version allégée garde le fichier petit indéfiniment,
// même après des dizaines de mises à jour incrémentales successives.
function slimFrCard(c) {
    const slim = {
        id: c.id,
        lang: c.lang,
        set: c.set,
        collector_number: c.collector_number,
        name: c.name,
        image_status: c.image_status
    };

    if (c.printed_name) slim.printed_name = c.printed_name;

    if (c.card_faces && c.card_faces.length >= 1) {
        slim.card_faces = c.card_faces.map((f) => {
            const face = { name: f.name };
            if (f.printed_name) face.printed_name = f.printed_name;
            if (f.image_uris && f.image_uris.normal) {
                face.image_uris = { normal: f.image_uris.normal };
            }
            return face;
        });
    } else if (c.image_uris && c.image_uris.normal) {
        slim.image_uris = { normal: c.image_uris.normal };
    }

    return slim;
}

function loadExistingFrCards(filePath) {
    const map = new Map();
    if (!fs.existsSync(filePath)) return map;

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const card = JSON.parse(line);
            if (card && card.id) map.set(card.id, card);
        } catch (e) {
            // ligne corrompue, ignorée silencieusement
        }
    }

    return map;
}

function writeFrCardsMap(filePath, map) {
    return new Promise((resolve, reject) => {
        const outStream = fs.createWriteStream(filePath, { flags: 'w' });
        for (const card of map.values()) {
            outStream.write(JSON.stringify(card) + '\n');
        }
        outStream.end((err) => (err ? reject(err) : resolve()));
    });
}

// Récupère les cartes FR les plus récentes depuis l'API (URL de départ + 3 next_page,
// soit 4 pages au total) et les fusionne (ajout/remplacement par id) dans le fichier existant.
// Le tri order=released garantit que toute nouveauté apparaît dans ces premières pages —
// jamais plus de ~600 cartes d'un coup, donc pas besoin de reparcourir tout l'historique.
async function updateFrCardsFileInline(filePath) {
    const existing = loadExistingFrCards(filePath);
    const startingCount = existing.size;

    const MAX_PAGES = 4; // URL de départ + 3 next_page
    let url = FR_SEARCH_URL;
    let page = 1;
    let fetchedThisRun = 0;

    while (url && page <= MAX_PAGES) {
        console.log(`  Page ${page}/${MAX_PAGES}... (${fetchedThisRun} cartes récupérées cette passe)`);

        let json;
        try {
            json = await frHttpGetJson(url);
        } catch (err) {
            console.error(`  Erreur sur la page ${page}: ${err.message}`);
            console.error('  Arrêt — les cartes déjà fusionnées sont conservées.');
            break;
        }

        if (Array.isArray(json.data)) {
            for (const card of json.data) {
                existing.set(card.id, slimFrCard(card));
                fetchedThisRun++;
            }
        }

        if (json.has_more && json.next_page && page < MAX_PAGES) {
            url = json.next_page;
            page++;
            await sleepMs(FR_FETCH_DELAY_MS);
        } else {
            url = null;
        }
    }

    await writeFrCardsMap(filePath, existing);

    console.log(`  -> ${fetchedThisRun} cartes reçues, ${existing.size} cartes au total dans ${filePath} (avant: ${startingCount})`);
    return existing.size;
}

async function modifyJsonFile(inputFilePath, outputFilePath, allCardsPath) {
    const result = {};
    const savedPrints = new Map();

    const allCards = await buildAllCardsIndex(allCardsPath);
    await processOracleFile(inputFilePath, allCards, result, savedPrints);
    await processAllCardsEnglish(allCardsPath, allCards, result, savedPrints);

    // Mise à jour du fichier FR : 3 passages pour fiabiliser la récupération réseau
    // (upsert par id à chaque passage, rien n'est perdu si une page échoue en route)
    console.log(`Mise à jour de ${FR_CARDS_PATH} (dernières nouveautés)...`);
    await updateFrCardsFileInline(FR_CARDS_PATH);

    // Greffage FR depuis cardFr.json uniquement — all.json ne contient pas de FR,
    // et une carte non-FR dans un futur fichier de langue ne se grefferait de toute façon jamais.
    await processTranslationFile(FR_CARDS_PATH, 'fr', savedPrints);

    addTreacheryCards(result);

    // Renommages manuels d'id (voir RENAMED_IDS en haut du fichier) — ajoute un alias pour
    // chaque ancien id vers son nouvel id, puis aplatit les chaînes éventuelles (A->B->C
    // devient A->C directement) pour que la résolution côté app reste un lookup simple.
    applyManualRenames(result);
    flattenAliasChains(result);

    const jsonString = JSON.stringify(result);
    const gzipped = zlib.gzipSync(jsonString);

    fs.writeFile(outputFilePath, gzipped, (err) => {
        if (err) console.error('Erreur écriture output JSON:', err);
        else {
            console.log(`Fichier sauvegardé (gzip): ${outputFilePath}, total cartes: ${Object.keys(result).length}, taille: ${(gzipped.length / 1024 / 1024).toFixed(2)} Mo`);
            increaseGameVersion();
        }
    });
}

function increaseGameVersion() {
    const gameJsonPath = './Game_MTG.json';

    try {
        const data = fs.readFileSync(gameJsonPath, 'utf8');
        const gameConfig = JSON.parse(data);

        if (gameConfig.cards) {
            const oldVersion = gameConfig.cards.version || 0;
            gameConfig.cards.version = oldVersion + 1;

            fs.writeFileSync(gameJsonPath, JSON.stringify(gameConfig, null, 2), 'utf8');
            console.log(`✅ Game json mis à jour : v${oldVersion} -> v${gameConfig.cards.version}`);
            return gameConfig.cards.version;
        } else {
            console.error("❌ Erreur : La clé 'cards' n'existe pas dans Game.json");
        }
    } catch (err) {
        console.error('❌ Erreur lors de la mise à jour de Game.json:', err.message);
    }
}

// Utilisation
//modifyJsonFile('oracle.json', 'MTGCards-Test.json', 'all.json');
module.exports = modifyJsonFile;


function addTreacheryCards(cardList) {
    for (const [subtype, cards] of Object.entries(treacheryData)) {

        for (const card of cards) {
            const cardId = "treachery-" + card.id;
            const c = {
                id: cardId,
                face: {
                    front: {
                        name: card.name,
                        image: card.image,
                        type: "Emblem",
                        "isHorizontal": false,
                        cost: card.cmc
                    }
                },
                name: card.name,
                type: "Emblem",
                isToken: true,
                cost: card.cmc,
                Colors: [],
                "Card type": "Identity",
                "Color identity": [],
                set: "Treachery",
                isHorizontal: false,
                power: 0,
                toughness: 0,
                _legal: {}
            };
            setCustomLegality(c, false);
            c._legal.EDH = true;
            setResultSafe(cardList, cardId, c, 'treachery');
        }
    }
}


const treacheryData = {
    "Guardian": [
        { "id": 1, "name": "The Ætherist", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/001%20-%20Guardian%20-%20The%20Ætherist.jpg" },
        { "id": 2, "name": "The Augur", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/002%20-%20Guardian%20-%20The%20Augur.jpg" },
        { "id": 3, "name": "The Bodyguard", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/003%20-%20Guardian%20-%20The%20Bodyguard.jpg" },
        { "id": 4, "name": "The Cathar", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/004%20-%20Guardian%20-%20The%20Cathar.jpg" },
        { "id": 5, "name": "The Cryomancer", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/005%20-%20Guardian%20-%20The%20Cryomancer.jpg" },
        { "id": 6, "name": "The Flickering Mage", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/006%20-%20Guardian%20-%20The%20Flickering%20Mage.jpg" },
        { "id": 7, "name": "The Golem", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/007%20-%20Guardian%20-%20The%20Golem.jpg" },
        { "id": 8, "name": "The Great Martyr", "cmc": 0, "rarity": "M", "image": "https://mtgtreachery.net/images/cards/en/trd/008%20-%20Guardian%20-%20The%20Great%20Martyr.jpg" },
        { "id": 9, "name": "The Immortal", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/009%20-%20Guardian%20-%20The%20Immortal.jpg" },
        { "id": 10, "name": "The Inquisitor", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/010%20-%20Guardian%20-%20The%20Inquisitor.jpg" },
        { "id": 11, "name": "The Marshal", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/011%20-%20Guardian%20-%20The%20Marshal.jpg" },
        { "id": 12, "name": "The Mirror Maestra", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/012%20-%20Guardian%20-%20The%20Mirror%20Maestra.jpg" },
        { "id": 13, "name": "The Oracle", "cmc": 0, "rarity": "M", "image": "https://mtgtreachery.net/images/cards/en/trd/013%20-%20Guardian%20-%20The%20Oracle.jpg" },
        { "id": 14, "name": "The Quellmaster", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/014%20-%20Guardian%20-%20The%20Quellmaster.jpg" },
        { "id": 15, "name": "The Spellsnatcher", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/015%20-%20Guardian%20-%20The%20Spellsnatcher.jpg" },
        { "id": 16, "name": "The Summoner", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/016%20-%20Guardian%20-%20The%20Summoner.jpg" },
        { "id": 17, "name": "The Supplier", "cmc": 0, "rarity": "M", "image": "https://mtgtreachery.net/images/cards/en/trd/017%20-%20Guardian%20-%20The%20Supplier.jpg" },
        { "id": 18, "name": "The Warlock", "cmc": 0, "rarity": "M", "image": "https://mtgtreachery.net/images/cards/en/trd/018%20-%20Guardian%20-%20The%20Warlock.jpg" }
    ],
    "Traitor": [
        { "id": 19, "name": "The Banisher", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/019%20-%20Traitor%20-%20The%20Banisher.jpg" },
        { "id": 20, "name": "The Cleaner", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/020%20-%20Traitor%20-%20The%20Cleaner.jpg" },
        { "id": 21, "name": "The Ferryman", "cmc": 0, "rarity": "M", "image": "https://mtgtreachery.net/images/cards/en/trd/021%20-%20Traitor%20-%20The%20Ferryman.jpg" },
        { "id": 22, "name": "The Gatekeeper", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/022%20-%20Traitor%20-%20The%20Gatekeeper.jpg" },
        { "id": 23, "name": "The Grenadier", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/023%20-%20Traitor%20-%20The%20Grenadier.jpg" },
        { "id": 24, "name": "He Who Comes To Save The Day", "cmc": 0, "rarity": "M", "image": "https://mtgtreachery.net/images/cards/en/trd/024%20-%20Traitor%20-%20He%20Who%20Comes%20To%20Save%20The%20Day.jpg" },
        { "id": 25, "name": "The Metamorph", "cmc": 0, "rarity": "S", "image": "https://mtgtreachery.net/images/cards/en/trd/025%20-%20Traitor%20-%20The%20Metamorph.jpg" },
        { "id": 26, "name": "The Oneiromancer", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/026%20-%20Traitor%20-%20The%20Oneiromancer.jpg" },
        { "id": 27, "name": "The Puppet Master", "cmc": 0, "rarity": "S", "image": "https://mtgtreachery.net/images/cards/en/trd/027%20-%20Traitor%20-%20The%20Puppet%20Master.jpg" },
        { "id": 28, "name": "The Reflector", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/028%20-%20Traitor%20-%20The%20Reflector.jpg" },
        { "id": 29, "name": "The Time Bender", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/029%20-%20Traitor%20-%20The%20Time%20Bender.jpg" },
        { "id": 30, "name": "The Treacherous Masochist", "cmc": 0, "rarity": "S", "image": "https://mtgtreachery.net/images/cards/en/trd/030%20-%20Traitor%20-%20The%20Treacherous%20Masochist.jpg" },
        { "id": 31, "name": "The Wearer of Masks", "cmc": 0, "rarity": "S", "image": "https://mtgtreachery.net/images/cards/en/trd/031%20-%20Traitor%20-%20The%20Wearer%20of%20Masks.jpg" }
    ],
    "Assassin": [
        { "id": 32, "name": "The Ambitious Queen", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/032%20-%20Assassin%20-%20The%20Ambitious%20Queen.jpg" },
        { "id": 33, "name": "The Beastmaster", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/033%20-%20Assassin%20-%20The%20Beastmaster.jpg" },
        { "id": 34, "name": "The Bio-Engineer", "cmc": 0, "rarity": "M", "image": "https://mtgtreachery.net/images/cards/en/trd/034%20-%20Assassin%20-%20The%20Bio-Engineer.jpg" },
        { "id": 35, "name": "The Chaos Wielder", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/035%20-%20Assassin%20-%20The%20Chaos%20Wielder.jpg" },
        { "id": 36, "name": "The Corpse Snatcher", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/036%20-%20Assassin%20-%20The%20Corpse%20Snatcher.jpg" },
        { "id": 37, "name": "The Demon", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/037%20-%20Assassin%20-%20The%20Demon.jpg" },
        { "id": 38, "name": "The Depths Caller", "cmc": 0, "rarity": "M", "image": "https://mtgtreachery.net/images/cards/en/trd/038%20-%20Assassin%20-%20The%20Depths%20Caller.jpg" },
        { "id": 39, "name": "The Madwoman", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/039%20-%20Assassin%20-%20The%20Madwoman.jpg" },
        { "id": 40, "name": "The Necromancer", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/040%20-%20Assassin%20-%20The%20Necromancer.jpg" },
        { "id": 41, "name": "The Physician", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/041%20-%20Assassin%20-%20The%20Physician.jpg" },
        { "id": 42, "name": "The Pyromancer", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/042%20-%20Assassin%20-%20The%20Pyromancer.jpg" },
        { "id": 43, "name": "The Rebel General", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/043%20-%20Assassin%20-%20The%20Rebel%20General.jpg" },
        { "id": 44, "name": "The Seer", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/044%20-%20Assassin%20-%20The%20Seer.jpg" },
        { "id": 45, "name": "The Shapeshifting Slayer", "cmc": 0, "rarity": "M", "image": "https://mtgtreachery.net/images/cards/en/trd/045%20-%20Assassin%20-%20The%20Shapeshifting%20Slayer.jpg" },
        { "id": 46, "name": "The Sigil Mage", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/046%20-%20Assassin%20-%20The%20Sigil%20Mage.jpg" },
        { "id": 47, "name": "The Sorceress", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/047%20-%20Assassin%20-%20The%20Sorceress.jpg" },
        { "id": 48, "name": "The Villain", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/048%20-%20Assassin%20-%20The%20Villain.jpg" },
        { "id": 49, "name": "The War Shaman", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/049%20-%20Assassin%20-%20The%20War%20Shaman.jpg" }
    ],
    "Leader": [
        { "id": 50, "name": "The Blood Empress", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/050%20-%20Leader%20-%20The%20Blood%20Empress.jpg" },
        { "id": 51, "name": "The Chaos Bringer", "cmc": 0, "rarity": "M", "image": "https://mtgtreachery.net/images/cards/en/trd/051%20-%20Leader%20-%20The%20Chaos%20Bringer.jpg" },
        { "id": 52, "name": "The Corrupted Regent", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/052%20-%20Leader%20-%20The%20Corrupted%20Regent.jpg" },
        { "id": 53, "name": "The Debt Collector", "cmc": 0, "rarity": "M", "image": "https://mtgtreachery.net/images/cards/en/trd/053%20-%20Leader%20-%20The%20Debt%20Collector.jpg" },
        { "id": 54, "name": "The Gathering", "cmc": 0, "rarity": "M", "image": "https://mtgtreachery.net/images/cards/en/trd/054%20-%20Leader%20-%20The%20Gathering.jpg" },
        { "id": 55, "name": "Her Seedborn Highness", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/055%20-%20Leader%20-%20Her%20Seedborn%20Highness.jpg" },
        { "id": 56, "name": "His Beloved Majesty", "cmc": 0, "rarity": "M", "image": "https://mtgtreachery.net/images/cards/en/trd/056%20-%20Leader%20-%20His%20Beloved%20Majesty.jpg" },
        { "id": 57, "name": "The King over the Scrapyard", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/057%20-%20Leader%20-%20The%20King%20over%20the%20Scrapyard.jpg" },
        { "id": 58, "name": "The Lich Queen", "cmc": 0, "rarity": "M", "image": "https://mtgtreachery.net/images/cards/en/trd/058%20-%20Leader%20-%20The%20Lich%20Queen.jpg" },
        { "id": 59, "name": "The Old Ruler", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/059%20-%20Leader%20-%20The%20Old%20Ruler.jpg" },
        { "id": 60, "name": "The Queen of Light", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/060%20-%20Leader%20-%20The%20Queen%20of%20Light.jpg" },
        { "id": 61, "name": "The Twin Princesses", "cmc": 0, "rarity": "R", "image": "https://mtgtreachery.net/images/cards/en/trd/061%20-%20Leader%20-%20The%20Twin%20Princesses.jpg" },
        { "id": 62, "name": "The Void Tyrant", "cmc": 0, "rarity": "U", "image": "https://mtgtreachery.net/images/cards/en/trd/062%20-%20Leader%20-%20The%20Void%20Tyrant.jpg" }
    ]
};