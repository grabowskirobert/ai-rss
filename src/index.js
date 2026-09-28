import { execFileSync } from 'child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fetchAllItems } from './fetcher.js';
import { clusterItems } from './cluster.js';
import { filterClusters } from './filter.js';
import { synthesizeClusters } from './synthesizer.js';
import { buildFeed, loadArchive, writePreview } from './feed-builder.js';
import { audioEntry, buildAudioDigest } from './audio.js';
import { log } from './logger.js';
import { reportCosts } from './costs.js';
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
const FORCE = hasFlag('--force');
// Odsłuch to najdroższy etap, więc w dry-runie jest domyślnie wyłączony —
// włączasz go świadomie flagą --audio.
const WITH_AUDIO = config.audio?.enabled !== false
  && !hasFlag('--no-audio')
  && (!DRY_RUN || hasFlag('--audio'));
// Odsłuch z tekstów, które już są w archiwum — przydaje się, gdy audycja
// nie powstała (awaria TTS) albo gdy dokładamy ją do wcześniejszego wydania.
const AUDIO_ONLY = hasFlag('--audio-only');
// Nagranie musi trafić na GitHub Pages: Releases serwuje pliki z nagłówkiem
// "content-disposition: attachment", przez co odtwarzacz w czytniku odmawia
// odtwarzania. Pages daje audio/mpeg i strumieniowanie. Historia gałęzi
// gh-pages nie puchnie, bo deploy idzie z force_orphan.
const AUDIO_DIR = flagValue('--audio-dir')
  || (DRY_RUN ? '/tmp/ai-rss-audio' : resolve(__dirname, '../public/audio'));
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

// Adres pliku w GitHub Releases — releases nie obciążają repozytorium,
// a URL jest stabilny, więc nadaje się do <enclosure>.
function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf-8' }).trim();
    return remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)?.[1] || null;
  } catch {
    return null;
  }
}

function audioUrl(fileName) {
  const base = config.audio?.baseUrl;
  if (base) return `${base.replace(/\/$/, '')}/${fileName}`;
  const repo = repoSlug();
  return repo ? `https://${repo.split('/')[0]}.github.io/${repo.split('/')[1]}/audio/${fileName}` : null;
}

function warsawDate(value = Date.now()) {
  return new Date(value).toLocaleDateString('en-CA', { timeZone: 'Europe/Warsaw' });
}

// GitHub potrafi opóźnić harmonogram o godziny, więc workflow odpala kilka prób
// w ciągu nocy. Pierwsza, która faktycznie wystartuje, buduje zestaw; kolejne
// wychodzą tutaj, zanim wydadzą choć jeden token.
function alreadyGeneratedToday() {
  const today = warsawDate();
  return loadArchive().some((entry) => warsawDate(entry.publishedAt) === today);
}

function recentTopics() {
  const cutoff = Date.now() - config.recentTopicsDays * 24 * 60 * 60 * 1000;
  return loadArchive()
    .filter((entry) => new Date(entry.publishedAt).getTime() >= cutoff)
    .map((entry) => entry.topic || entry.title);
}

async function buildAudio(articles) {
  const dateStamp = warsawDate();
  const digest = await buildAudioDigest(articles, { outputDir: AUDIO_DIR, dateStamp });
  if (!digest) return null;

  const url = audioUrl(digest.fileName);
  if (!url) log.warn('Brak adresu publikacji audio — wpis powstanie bez odtwarzacza');
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      `audio_path=${digest.filePath}\naudio_script=${digest.scriptPath}\n` +
      `audio_tag=${config.audio.releaseTagPrefix}${dateStamp}\n`);
  }
  return audioEntry(digest, { articles, dateStamp, url });
}

// Regeneracja odsłuchu z lokalnego archiwum ma sens tylko wtedy, gdy to
// archiwum jest aktualne — automat commituje własne wydania na origin.
function warnIfStale() {
  try {
    const behind = execFileSync('git', ['rev-list', '--count', 'HEAD..@{u}'], { encoding: 'utf-8' }).trim();
    if (Number(behind) > 0) {
      log.warn(`Lokalna gałąź jest ${behind} commitów za origin — archiwum może być nieaktualne. Zrób git pull.`);
    }
  } catch { /* brak remote albo upstreamu — nie ma o czym ostrzegać */ }
}

async function audioOnlyRun() {
  log.phase('Tryb --audio-only — odsłuch z tekstów w archiwum');

  warnIfStale();

  // Bierzemy wyłącznie teksty z NAJNOWSZEGO wydania — inaczej przy niepełnym
  // zestawie audycja dobrałaby artykuły z poprzedniego dnia i przeczytała je
  // drugi raz pod dzisiejszą datą.
  const count = Number(flagValue('--audio-only')) || config.maxItemsPerRun;
  const texts = loadArchive().filter((entry) => entry.kind !== 'audio');
  const newest = texts[0] && warsawDate(texts[0].publishedAt);
  const articles = texts.filter((e) => warsawDate(e.publishedAt) === newest).slice(0, count);

  if (articles.length === 0) {
    log.error('Archiwum nie zawiera tekstów — nie ma z czego zrobić odsłuchu');
    return;
  }

  log.info(`Biorę ${articles.length} najnowszych tekstów:`);
  articles.forEach((a, i) => log.info(`  ${i + 1}. ${a.title}`));

  // --no-audio (i dry-run bez --audio) = pokaż dobór tekstów, nie wydawaj na TTS.
  if (!WITH_AUDIO) {
    log.skip('Synteza mowy pominięta — to był tylko podgląd doboru tekstów');
    return;
  }

  const entry = await buildAudio(articles);
  if (!entry) {
    log.error('Odsłuch nie powstał');
    return;
  }

  const archive = buildFeed([entry], { dryRun: DRY_RUN, outputPath: FEED_OUT });
  if (PREVIEW_OUT) writePreview(archive, [entry.guid], PREVIEW_OUT);
  reportCosts(articles.length);
  log.done(DRY_RUN ? 'Gotowe (dry run)' : 'Gotowe');
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    log.error('GEMINI_API_KEY nie jest ustawiony');
    process.exit(1);
  }

  log.phase('AI RSS Synthesizer — start');
  if (DRY_RUN) log.warn('DRY RUN — history.json i archive.json nie zostaną zmienione');

  if (AUDIO_ONLY) {
    await audioOnlyRun();
    return;
  }

  if (!DRY_RUN && !FORCE && alreadyGeneratedToday()) {
    log.done(`Zestaw na ${warsawDate()} już istnieje — kończę bez kosztów (--force wymusza)`);
    // Sygnał dla workflow, żeby pusty przebieg nie publikował feeda po raz drugi.
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, 'skipped=true\n');
    }
    return;
  }

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
  log.phase('Faza 2 — grupowanie w wątki');
  const clusters = await clusterItems(fetched);

  // Faza 3
  log.phase('Faza 3 — filtrowanie (Gemini)');
  const filtered = await filterClusters(clusters, recentTopics());

  if (filtered.length === 0) {
    log.warn('Żaden wątek nie przeszedł filtra — kończę bez zapisu feed.xml');
    return;
  }

  if (SKIP_SYNTHESIS) {
    log.skip('--skip-synthesis: kończę po filtrze');
    return;
  }


  // Faza 4
  log.phase('Faza 4 — synteza (pełne teksty → fakty → tło)');
  const toSynthesize = LIMIT ? filtered.slice(0, LIMIT) : filtered;
  if (LIMIT) log.warn(`--limit ${LIMIT}: syntezuję tylko ${toSynthesize.length} z ${filtered.length}`);
  const synthesized = await synthesizeClusters(toSynthesize);
  log.ok(`Zsyntezowano ${synthesized.length} artykułów`);

  if (synthesized.length === 0) {
    log.warn('Brak zsyntezowanych artykułów — kończę bez zapisu feed.xml');
    return;
  }

  // Faza 5
  const toPublish = [...synthesized];

  if (WITH_AUDIO) {
    log.phase('Faza 5 — odsłuch (scenariusz + TTS)');
    try {
      const entry = await buildAudio(synthesized);
      if (entry) toPublish.push(entry);
    } catch (err) {
      log.error(`Odsłuch nie powstał: ${err.message.slice(0, 120)} — publikuję same teksty`);
    }
  } else {
    log.skip('Odsłuch pominięty (--no-audio, wyłączony w config albo dry-run bez --audio)');
  }

  // Faza 6
  log.phase('Faza 6 — budowanie feed.xml');
  const archive = buildFeed(toPublish, { dryRun: DRY_RUN, outputPath: FEED_OUT });

  if (PREVIEW_OUT) {
    writePreview(archive, toPublish.map((item) => item.guid), PREVIEW_OUT);
  }

  if (DRY_RUN) {
    reportCosts(synthesized.length);
    log.done('Gotowe (dry run)');
    return;
  }

  const newGuids = fetched.map((item) => item.guid);
  saveHistory(history, newGuids);
  log.info(`Historia zaktualizowana o ${newGuids.length} GUIDów`);

  reportCosts(synthesized.length);
  log.done('Gotowe');
}

main().catch((err) => {
  log.error(`Błąd krytyczny: ${err.message}`);
  process.exit(1);
});
