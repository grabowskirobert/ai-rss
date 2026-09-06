import Parser from 'rss-parser';
import config from '../config.json' with { type: 'json' };

const parser = new Parser({ timeout: 10000 });

export async function fetchAllItems(history) {
  const historySet = new Set(history);
  const cutoff = Date.now() - config.maxAgeHours * 60 * 60 * 1000;
  const items = [];

  for (const url of config.sources) {
    try {
      const feed = await parser.parseURL(url);
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
          source: feed.title || url,
        });
      }
    } catch (err) {
      console.error(`[fetcher] Failed to fetch ${url}: ${err.message}`);
    }
  }

  return items;
}
