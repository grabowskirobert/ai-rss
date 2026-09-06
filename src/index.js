import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fetchAllItems } from './fetcher.js';
import { filterItems } from './filter.js';
import { synthesizeItems } from './synthesizer.js';
import { buildFeed } from './feed-builder.js';
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
    console.error('[index] GEMINI_API_KEY is not set');
    process.exit(1);
  }

  console.log('[index] Starting AI RSS Synthesizer');

  const history = loadHistory();
  console.log(`[index] History contains ${history.length} seen GUIDs`);

  // Phase 1: Fetch
  console.log('[index] Phase 1: Fetching RSS feeds');
  const fetched = await fetchAllItems(history);
  console.log(`[index] Fetched ${fetched.length} new items`);

  if (fetched.length === 0) {
    console.log('[index] No new items found, exiting');
    return;
  }

  // Phase 2: Filter
  console.log('[index] Phase 2: First-pass filtering via Gemini');
  const filtered = await filterItems(fetched);
  console.log(`[index] ${filtered.length} items passed the filter`);

  if (filtered.length === 0) {
    console.log('[index] No items passed the filter, exiting without writing feed');
    return;
  }

  // Phase 3: Synthesize
  console.log('[index] Phase 3: Synthesizing articles with Gemini + web search');
  const synthesized = await synthesizeItems(filtered);
  console.log(`[index] ${synthesized.length} articles synthesized`);

  if (synthesized.length === 0) {
    console.log('[index] No synthesized articles, exiting without writing feed');
    return;
  }

  // Phase 4: Build feed
  console.log('[index] Phase 4: Building feed.xml');
  buildFeed(synthesized);

  // Update history with all fetched GUIDs (not just synthesized — prevents re-fetching rejected items)
  const newGuids = fetched.map((item) => item.guid);
  saveHistory(history, newGuids);
  console.log(`[index] History updated with ${newGuids.length} new GUIDs`);

  console.log('[index] Done');
}

main().catch((err) => {
  console.error('[index] Fatal error:', err);
  process.exit(1);
});
