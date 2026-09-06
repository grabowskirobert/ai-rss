import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fetchAllItems } from './fetcher.js';
import { filterItems } from './filter.js';
import { synthesizeItems } from './synthesizer.js';
import { buildFeed } from './feed-builder.js';
import { log } from './logger.js';
import config from '../config.json' with { type: 'json' };

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = resolve(__dirname, '../history.json');

function loadHistory() {
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function saveHistory(history, newGuids) {
  const updated = [...history, ...newGuids];
  const trimmed = updated.slice(-config.maxHistorySize);
  writeFileSync(HISTORY_PATH, JSON.stringify(trimmed, null, 2), 'utf-8');
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    log.error('GEMINI_API_KEY nie jest ustawiony');
    process.exit(1);
  }

  log.phase('AI RSS Synthesizer — start');

  const history = loadHistory();
  log.info(`Historia: ${history.length} znanych GUIDów`);

  // Faza 1
  log.phase('Faza 1 — pobieranie RSS');
  const fetched = await fetchAllItems(history);
  log.ok(`Łącznie nowych artykułów: ${fetched.length}`);

  if (fetched.length === 0) {
    log.warn('Brak nowych artykułów — kończę');
    return;
  }

  // Faza 2
  log.phase('Faza 2 — filtrowanie (Gemini)');
  const filtered = await filterItems(fetched);

  if (filtered.length === 0) {
    log.warn('Żaden artykuł nie przeszedł filtra — kończę bez zapisu feed.xml');
    return;
  }

  // Faza 3
  log.phase('Faza 3 — synteza (Gemini + web search)');
  const synthesized = await synthesizeItems(filtered);
  log.ok(`Zsyntezowano ${synthesized.length} artykułów`);

  if (synthesized.length === 0) {
    log.warn('Brak zsyntezowanych artykułów — kończę bez zapisu feed.xml');
    return;
  }

  // Faza 4
  log.phase('Faza 4 — budowanie feed.xml');
  buildFeed(synthesized);

  const newGuids = fetched.map((item) => item.guid);
  saveHistory(history, newGuids);
  log.info(`Historia zaktualizowana o ${newGuids.length} GUIDów`);

  log.done('Gotowe');
}

main().catch((err) => {
  log.error(`Błąd krytyczny: ${err.message}`);
  process.exit(1);
});
