import Parser from 'rss-parser';
import config from '../config.json' with { type: 'json' };
import { log } from './logger.js';
import { sourceUrl } from './trust.js';

const FEED_CONCURRENCY = 8;

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

  // 70+ feedów sekwencyjnie to kilka minut — pobieramy równolegle.
  const queue = [...config.sources];
  const workers = Array.from({ length: FEED_CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const entry = queue.shift();
      const url = sourceUrl(entry);
      try {
        const feed = await parseWithRetry(url);
        const name = (feed.title || url).replace(/\s+/g, ' ').trim();
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
            source: name,
            imageUrl: extractImage(item),
            axis: entry.axis || null,
            paywall: entry.paywall === true,
          });
          added++;
        }

        log.ok(`${name} → ${added} nowych`);
      } catch (err) {
        log.error(`Błąd pobierania ${url}: ${err.message.slice(0, 80)}`);
      }
    }
  });

  await Promise.all(workers);
  return items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
}
