import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fetchAllItems } from './fetcher.js';
import { filterItems } from './filter.js';
import { synthesizeItems } from './synthesizer.js';
import { buildFeed, loadArchive, writePreview } from './feed-builder.js';
import { log } from './logger.js';
import config from '../config.json' with { type: 'json' };

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = resolve(__dirname, '../history.json');

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const flagValue = (name) => {
  const idx = args.indexOf(name);
  return idx === -1 ? null : args[idx + 1];
};

const DRY_RUN = hasFlag('--dry-run');
const SKIP_SYNTHESIS = hasFlag('--skip-synthesis');
const LIMIT = Number(flagValue('--limit')) || null;
const FEED_OUT = flagValue('--out') || (hasFlag('--dry-run') ? '/tmp/feed-dry.xml' : null);
const PREVIEW_OUT = flagValue('--preview') || (hasFlag('--dry-run') ? '/tmp/preview.html' : null);

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

function recentTopics() {
  const cutoff = Date.now() - config.recentTopicsDays * 24 * 60 * 60 * 1000;
  return loadArchive()
    .filter((entry) => new Date(entry.publishedAt).getTime() >= cutoff)
    .map((entry) => entry.topic || entry.title);
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    log.error('GEMINI_API_KEY nie jest ustawiony');
    process.exit(1);
  }

  log.phase('AI RSS Synthesizer — start');
  if (DRY_RUN) log.warn('DRY RUN — history.json i archive.json nie zostaną zmienione');

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
  const filtered = await filterItems(fetched, recentTopics());

  if (filtered.length === 0) {
    log.warn('Żaden artykuł nie przeszedł filtra — kończę bez zapisu feed.xml');
    return;
  }

  if (SKIP_SYNTHESIS) {
    log.skip('--skip-synthesis: kończę po filtrze');
    return;
  }

  // Faza 3
  log.phase('Faza 3 — synteza (Gemini + web search)');
  const toSynthesize = LIMIT ? filtered.slice(0, LIMIT) : filtered;
  if (LIMIT) log.warn(`--limit ${LIMIT}: syntezuję tylko ${toSynthesize.length} z ${filtered.length}`);
  const synthesized = await synthesizeItems(toSynthesize);
  log.ok(`Zsyntezowano ${synthesized.length} artykułów`);

  if (synthesized.length === 0) {
    log.warn('Brak zsyntezowanych artykułów — kończę bez zapisu feed.xml');
    return;
  }

  // Faza 4
  log.phase('Faza 4 — budowanie feed.xml');
  const archive = buildFeed(synthesized, { dryRun: DRY_RUN, outputPath: FEED_OUT });

  if (PREVIEW_OUT) {
    writePreview(archive, synthesized.map((item) => item.guid), PREVIEW_OUT);
  }

  if (DRY_RUN) {
    log.done('Gotowe (dry run)');
    return;
  }

  const newGuids = fetched.map((item) => item.guid);
  saveHistory(history, newGuids);
  log.info(`Historia zaktualizowana o ${newGuids.length} GUIDów`);

  log.done('Gotowe');
}

main().catch((err) => {
  log.error(`Błąd krytyczny: ${err.message}`);
  process.exit(1);
});
