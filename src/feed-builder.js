import { Feed } from 'feed';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

export function buildFeed(items) {
  const feed = new Feed({
    title: 'AI RSS',
    description: 'Synteza newsów — Gemini AI',
    id: 'https://github.com/ai-rss',
    link: 'https://github.com/ai-rss',
    language: 'pl',
    updated: new Date(),
    generator: 'AI RSS (Gemini 3.5 Flash Lite)',
  });

  let withImages = 0;

  for (const item of items) {
    const styledHtml = applyStyles(item.html, item.imageUrl);
    if (item.imageUrl) withImages++;

    feed.addItem({
      title: item.title,
      id: item.guid,
      link: item.link,
      content: styledHtml,
      date: new Date(item.pubDate),
      description: item.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
    });
  }

  const outputPath = resolve(__dirname, '../public/feed.xml');
  writeFileSync(outputPath, feed.rss2(), 'utf-8');
  log.ok(`Zapisano ${items.length} artykułów (${withImages} ze zdjęciem) → ${outputPath}`);
}
