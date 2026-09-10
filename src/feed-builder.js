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

export function writePreview(archive, newGuids, path) {
  const isNew = new Set(newGuids);
  const items = archive.map((entry, i) => `
    <article${isNew.has(entry.guid) ? ' class="new"' : ''}>
      <div class="meta">
        ${isNew.has(entry.guid) ? '<span class="badge">NOWY</span>' : ''}
        <span>#${i + 1}</span>
        <span>${entry.category || '—'}</span>
        <span>${entry.source || '—'}</span>
        <span>wątek: ${entry.topic || '—'}</span>
        <span>${new Date(entry.publishedAt).toLocaleString('pl-PL')}</span>
        <span>${entry.html.replace(/<[^>]+>/g, '').length} znaków</span>
      </div>
      <h2>${entry.title}</h2>
      ${applyStyles(entry.html, entry.imageUrl)}
      <p class="src"><a href="${entry.link}">źródło</a></p>
    </article>`).join('\n');

  const categories = [...new Set(archive.filter((e) => isNew.has(e.guid)).map((e) => e.category))];

  const html = `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><title>AI RSS — podgląd</title>
<style>
  body{max-width:44em;margin:2em auto;padding:0 1.2em;font-family:system-ui,sans-serif;background:#fafafa}
  article{background:#fff;border:1px solid #e0e0e0;border-radius:6px;padding:1.2em 1.5em;margin-bottom:1.5em}
  article.new{border-color:#2a6496;border-width:2px}
  h2{font-family:Georgia,serif;font-size:1.35em;line-height:1.3;margin:.2em 0 .8em}
  .meta{display:flex;flex-wrap:wrap;gap:.6em;font-size:.75em;color:#666;text-transform:uppercase;letter-spacing:.04em;margin-bottom:.4em}
  .badge{background:#2a6496;color:#fff;padding:0 .4em;border-radius:3px}
  .src{font-size:.8em;color:#888;margin-top:1em}
  .summary{background:#fff;border:1px solid #e0e0e0;border-radius:6px;padding:1em 1.5em;margin-bottom:2em;font-size:.9em}
</style></head><body>
<div class="summary">
  <strong>Podgląd dry-run</strong><br>
  Nowe artykuły: ${newGuids.length} · w archiwum łącznie: ${archive.length}<br>
  Kategorie nowych: ${categories.join(', ') || '—'} (${categories.length} różnych)
</div>
${items}
</body></html>`;

  writeFileSync(path, html, 'utf-8');
  log.ok(`Podgląd HTML → ${path}`);
}
