import Parser from 'rss-parser';
import config from '../config.json' with { type: 'json' };
import { log } from './logger.js';

const parser = new Parser({
  timeout: config.fetchTimeoutMs,
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: false }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
    ],
  },
});

function extractImage(item) {
  if (item.mediaContent?.['$']?.url) return item.mediaContent['$'].url;
  if (item.mediaThumbnail?.['$']?.url) return item.mediaThumbnail['$'].url;
  if (item.enclosure?.url && item.enclosure.type?.startsWith('image/')) return item.enclosure.url;
  return null;
}

async function parseWithRetry(url) {
  try {
    return await parser.parseURL(url);
  } catch (err) {
    log.warn(`Pobieranie ${url} nie udało się (${err.message}) — ponawiam`);
    return await parser.parseURL(url);
  }
}

export async function fetchAllItems(history) {
  const historySet = new Set(history);
  const cutoff = Date.now() - config.maxAgeHours * 60 * 60 * 1000;
  const items = [];

  for (const url of config.sources) {
    try {
      log.info(`Fetching: ${url}`);
      const feed = await parseWithRetry(url);
      let added = 0;

      for (const item of feed.items) {
        const guid = item.guid || item.link;
        if (!guid) continue;
        if (historySet.has(guid)) continue;

        const pubDate = item.pubDate ? new Date(item.pubDate).getTime() : Date.now();
        if (pubDate < cutoff) continue;

        items.push({
          guid,
          title: item.title || '',
          description: item.contentSnippet || item.content || item.summary || '',
          link: item.link || '',
          pubDate: new Date(pubDate).toISOString(),
          source: (feed.title || url).replace(/\s+/g, ' ').trim(),
          imageUrl: extractImage(item),
        });
        added++;
      }

      log.ok(`${(feed.title || url).replace(/\s+/g, ' ').trim()} → ${added} nowych artykułów`);
    } catch (err) {
      log.error(`Błąd pobierania ${url}: ${err.message}`);
    }
  }

  return items;
}
