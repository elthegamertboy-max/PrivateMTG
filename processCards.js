const fs = require('fs');
const https = require('https');
const zlib = require('zlib');
const path = require('path');
const { pipeline } = require('stream');
const { promisify } = require('util');
const modifyJsonFile = require('./Script_MTG.js');

const pipelineAsync = promisify(pipeline);

const HEADERS = {
  'User-Agent': 'TCG-Arena-MTG/1.0 (GitHub Action)',
  'Accept': 'application/json',
};

async function fetchScryfallData() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.scryfall.com',
      path: '/bulk-data',
      headers: HEADERS
    };

    https.get(options, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Erreur HTTP ${res.statusCode} en accédant à l'API Scryfall`));
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);

          if (!json || !Array.isArray(json.data)) {
            console.log("🔍 Données brutes:", data);
            return reject(new Error("La réponse de Scryfall n'est pas valide"));
          }

          const oracle = json.data.find(d => d.type === 'oracle_cards');
          const defaultCards = json.data.find(d => d.type === 'default_cards');

          if (!oracle || !defaultCards) {
            return reject(new Error("oracle_cards ou default_cards non trouvés dans la réponse Scryfall"));
          }

          resolve({
            oracleURL: oracle.download_uri || oracle.jsonl_download_uri,
            defaultURL: defaultCards.download_uri || defaultCards.jsonl_download_uri,
          });
        } catch (e) {
          reject(new Error(`Erreur JSON.parse: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function downloadAndExtractJSON(url, destPath) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: HEADERS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Échec du téléchargement depuis ${url} - HTTP ${res.statusCode}`));
      }

      const isGzip = url.endsWith('.gz') || res.headers['content-encoding'] === 'gzip' || res.headers['content-type'] === 'application/gzip';
      const file = fs.createWriteStream(destPath);

      const source = isGzip ? res.pipe(zlib.createGunzip()) : res;

      pipelineAsync(source, file)
        .then(() => {
          console.log(`✅ Fichier téléchargé et extrait : ${destPath}`);
          resolve();
        })
        .catch(reject);
    }).on('error', (err) => {
      reject(new Error(`Erreur réseau : ${err.message}`));
    });
  });
}

async function main() {
  try {
    console.log('📡 Récupération des URLs depuis Scryfall...');
    const { oracleURL, defaultURL } = await fetchScryfallData();

    console.log('⬇️ Téléchargement des fichiers :');
    console.log(`- oracle.json: ${oracleURL}`);
    console.log(`- all.json: ${defaultURL}`);

    await downloadAndExtractJSON(oracleURL, 'oracle.json');
    await downloadAndExtractJSON(defaultURL, 'all.json');

    if (!fs.existsSync('oracle.json') || !fs.existsSync('all.json')) {
      throw new Error('❌ Les fichiers oracle.json ou all.json sont manquants après extraction.');
    }

    console.log('⚙️ Traitement avec modifyJsonFile...');
    modifyJsonFile('oracle.json', 'MTGCards.json', 'all.json');
  } catch (err) {
    console.error('❌ Erreur dans le processus:', err.message);
    process.exit(1);
  }
}

main();