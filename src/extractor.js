import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import config from '../config.json' with { type: 'json' };
import { log } from './logger.js';

const OPTS = config.extractor;

// jsdom krzyczy o każdym CSS-ie i skrypcie na stronie — nieistotne, wyciszamy.
const virtualConsole = new VirtualConsole();

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPTS.timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': OPTS.userAgent,
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!type.includes('html')) throw new Error(`content-type ${type}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function readable(html, url) {
  const dom = new JSDOM(html, { url, virtualConsole });
  const article = new Readability(dom.window.document).parse();
  dom.window.close();
  if (!article?.textContent) return null;
  const text = article.textContent.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: text.slice(0, OPTS.maxChars), byline: article.byline || null };
}

// Zwraca null zamiast rzucać — brak pełnego tekstu to normalny przypadek
// (paywall, JS-only, blokada bota), nie błąd pipeline'u.
export async function extractArticle(item) {
  if (!item.link) return null;
  try {
    const html = await fetchHtml(item.link);
    const parsed = readable(html, item.link);
    if (!parsed) {
      log.skip(`Readability nic nie znalazł: ${item.link}`);
      return null;
    }
    if (parsed.text.length < OPTS.minChars) {
      log.skip(`Za krótki tekst (${parsed.text.length} zn., próg ${OPTS.minChars}): ${item.source}`);
      return null;
    }
    return { ...item, fullText: parsed.text, byline: parsed.byline };
  } catch (err) {
    log.skip(`Ekstrakcja nieudana (${err.message.slice(0, 60)}): ${item.link}`);
    return null;
  }
}

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

// Korpus klastra: pełne teksty maksymalnie N członków, każdy z innego wydawcy.
export async function buildCorpus(cluster) {
  const byPublisher = new Map();
  for (const member of cluster.members) {
    if (!byPublisher.has(member.source)) byPublisher.set(member.source, member);
  }
  const candidates = [...byPublisher.values()].slice(0, OPTS.maxArticlesPerCluster);

  const extracted = (await mapLimited(candidates, OPTS.concurrency, extractArticle))
    .filter(Boolean);

  const publishers = [...new Set(extracted.map((a) => a.source))];
  log.info(
    `Korpus "${cluster.topic || cluster.lead.title.slice(0, 50)}": ` +
    `${extracted.length}/${candidates.length} tekstów, ${publishers.length} wydawców, ` +
    `${extracted.reduce((sum, a) => sum + a.fullText.length, 0)} znaków`
  );

  return { articles: extracted, publishers };
}

// Budżet znaków dzielony po równo — długi esej z jednego serwisu nie może
// zjeść całego kontekstu i wypchnąć pozostałych wydawców.
export function renderCorpus(articles) {
  const perArticle = Math.floor(OPTS.maxCorpusChars / Math.max(articles.length, 1));
  return articles
    .map((a, i) =>
      `[Ź${i + 1}] ${a.source} — ${a.title}\nURL: ${a.link}\n\n${a.fullText.slice(0, perArticle)}`)
    .join('\n\n---\n\n');
}
