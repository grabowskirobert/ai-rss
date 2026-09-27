import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../config.json' with { type: 'json' };
import { log } from './logger.js';
import { record } from './costs.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const OPTS = config.cluster;

const EMBEDDING_MODEL = config.models.embedding;

function textOf(item) {
  return `${item.title}\n${(item.description || '').slice(0, OPTS.embeddingTextChars)}`;
}

async function embedAll(items) {
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  const vectors = [];

  for (let i = 0; i < items.length; i += 100) {
    const batch = items.slice(i, i + 100);
    const res = await model.batchEmbedContents({
      requests: batch.map((item) => ({
        content: { role: 'user', parts: [{ text: textOf(item) }] },
        taskType: 'SEMANTIC_SIMILARITY',
      })),
    });
    vectors.push(...res.embeddings.map((e) => e.values));
  }

  // Embeddingi nie raportują usageMetadata — szacujemy po znakach (~4 zn./token).
  const chars = items.reduce((sum, item) => sum + textOf(item).length, 0);
  record(EMBEDDING_MODEL, {
    usageMetadata: { promptTokenCount: Math.round(chars / 4), candidatesTokenCount: 0 },
  }, 'embeddingi');

  return vectors;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'to', 'for', 'and', 'is', 'are', 'was', 'with',
  'w', 'we', 'z', 'ze', 'na', 'do', 'i', 'o', 'po', 'za', 'od', 'nie', 'to', 'sie',
  'jest', 'ma', 'przez', 'przy', 'the', 'as', 'by', 'at', 'from', 'that',
]);

function tokens(item) {
  return new Set(
    item.title.toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 3 && !STOPWORDS.has(word))
  );
}

function jaccard(a, b) {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared || 1);
}

function withinWindow(a, b) {
  const diff = Math.abs(new Date(a.pubDate) - new Date(b.pubDate));
  return diff <= OPTS.windowHours * 60 * 60 * 1000;
}

// Zachłanne łączenie: każdy artykuł dołącza do pierwszego klastra, z którego
// liderem jest wystarczająco podobny. Wystarczające przy ~2000 itemów na dobę.
function group(items, similarity) {
  const clusters = [];

  items.forEach((item, idx) => {
    for (const cluster of clusters) {
      if (cluster.members.length >= OPTS.maxMembers) continue;
      if (!withinWindow(cluster.lead, item)) continue;
      if (similarity(cluster.leadIdx, idx) < OPTS.similarityThreshold) continue;
      cluster.members.push(item);
      return;
    }
    clusters.push({ lead: item, leadIdx: idx, members: [item] });
  });

  return clusters;
}

function finalize(clusters) {
  return clusters
    .map((cluster, i) => {
      const publishers = [...new Set(cluster.members.map((m) => m.source))];
      return {
        id: i,
        lead: cluster.lead,
        // Lider klastra powinien być z wydawcy, który dał najdłuższy opis —
        // to zwykle ten z realną treścią, nie z samym nagłówkiem.
        members: [...cluster.members].sort(
          (a, b) => (b.description || '').length - (a.description || '').length
        ),
        publishers,
        publisherCount: publishers.length,
      };
    })
    .sort((a, b) => b.publisherCount - a.publisherCount);
}

export async function clusterItems(items) {
  log.info(`Grupuję ${items.length} artykułów w wątki...`);

  try {
    const vectors = await embedAll(items);
    const clusters = finalize(group(items, (i, j) => cosine(vectors[i], vectors[j])));
    logSummary(clusters, 'embeddingi');
    return clusters;
  } catch (err) {
    log.warn(`Embeddingi zawiodły (${err.message.slice(0, 100)}) — grupuję leksykalnie`);
    const sets = items.map(tokens);
    // Jaccard na tytułach jest znacznie ostrzejszy niż cosine na embeddingach.
    const threshold = 0.34;
    const clusters = finalize(
      group(items, (i, j) => (jaccard(sets[i], sets[j]) >= threshold ? 1 : 0))
    );
    logSummary(clusters, 'leksykalnie');
    return clusters;
  }
}

function logSummary(clusters, method) {
  const multi = clusters.filter((c) => c.publisherCount > 1).length;
  log.ok(
    `${clusters.length} wątków (${method}) — ${multi} z więcej niż jednym wydawcą, ` +
    `${clusters.length - multi} jednoźródłowych`
  );
  clusters.slice(0, 5).forEach((c) =>
    log.info(`  ${c.publisherCount}× ${c.lead.title.slice(0, 70)}`)
  );
}
