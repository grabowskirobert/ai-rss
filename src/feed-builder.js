import { Feed } from 'feed';
import { writeFileSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.json' with { type: 'json' };
import { log } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCHIVE_PATH = resolve(__dirname, '../archive.json');

const STYLES = {
  img: 'max-width:100%;height:auto;border-radius:4px;margin:0 0 1em;display:block',
  h3: 'font-family:system-ui,sans-serif;font-size:0.85em;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#555;margin:1.2em 0 0.3em;border-left:3px solid #2a6496;padding-left:0.6em',
  p: 'font-family:Georgia,serif;font-size:1em;line-height:1.65;margin:0.4em 0 0.8em;color:#222',
  ul: 'font-family:Georgia,serif;font-size:1em;line-height:1.65;margin:0.4em 0 0.8em;padding-left:1.4em;color:#222',
  li: 'margin-bottom:0.3em',
};

function applyStyles(html, imageUrl) {
  const img = imageUrl
    ? `<img src="${imageUrl}" alt="" style="${STYLES.img}">`
    : '';

  return img + html
    .replace(/<h3>/g, `<h3 style="${STYLES.h3}">`)
    .replace(/<p>/g, `<p style="${STYLES.p}">`)
    .replace(/<ul>/g, `<ul style="${STYLES.ul}">`)
    .replace(/<li>/g, `<li style="${STYLES.li}">`);
}

export function loadArchive() {
  try {
    const parsed = JSON.parse(readFileSync(ARCHIVE_PATH, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mergeArchive(archive, items) {
  const publishedAt = new Date().toISOString();
  const fresh = items.map((item) => ({
    guid: item.guid,
    title: item.title,
    link: item.link,
    html: item.html,
    imageUrl: item.imageUrl || null,
    source: item.source,
    category: item.category || null,
    topic: item.topic || null,
    pubDate: item.pubDate,
    publishedAt,
  }));

  const byGuid = new Map();
  for (const entry of [...fresh, ...archive]) {
    if (!byGuid.has(entry.guid)) byGuid.set(entry.guid, entry);
  }

  return [...byGuid.values()]
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, config.maxFeedItems);
}

export function buildFeed(items, { dryRun = false, outputPath } = {}) {
  const archive = mergeArchive(loadArchive(), items);

  const feed = new Feed({
    title: 'AI RSS',
    description: 'Synteza newsów — Gemini AI',
    id: 'https://github.com/ai-rss',
    link: 'https://github.com/ai-rss',
    language: 'pl',
    updated: new Date(),
    generator: `AI RSS (${config.synthesisModel})`,
  });

  let withImages = 0;

  for (const entry of archive) {
    if (entry.imageUrl) withImages++;

    feed.addItem({
      title: entry.title,
      id: entry.guid,
      link: entry.link,
      content: applyStyles(entry.html, entry.imageUrl),
      // Data publikacji w NASZYM feedzie — nie oryginalna data źródła,
      // inaczej czytniki rozsypują dzienny zestaw po wcześniejszych dniach.
      date: new Date(entry.publishedAt),
      description: entry.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
    });
  }

  const feedPath = outputPath || resolve(__dirname, '../public/feed.xml');
  writeFileSync(feedPath, feed.rss2(), 'utf-8');
  if (!dryRun) writeFileSync(ARCHIVE_PATH, JSON.stringify(archive, null, 2) + '\n', 'utf-8');

  log.ok(
    `Zapisano feed: ${items.length} nowych + ${archive.length - items.length} archiwalnych ` +
    `(${withImages} ze zdjęciem) → ${feedPath}`
  );
  if (dryRun) log.skip('dry-run: archive.json nietknięty');

  return archive;
}
