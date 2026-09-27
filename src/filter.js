import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../config.json' with { type: 'json' };
import { log } from './logger.js';
import { record } from './costs.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const FILTER_MODEL = config.models.filter;
const FALLBACK_MODEL = config.models.fallback;

const filterThinking = config.thinkingBudget?.filter >= 0
  ? { thinkingConfig: { thinkingBudget: config.thinkingBudget.filter } }
  : {};

const model = genAI.getGenerativeModel({
  model: FILTER_MODEL,
  generationConfig: filterThinking,
});
const fallbackModel = genAI.getGenerativeModel({ model: FALLBACK_MODEL });

async function generate(prompt) {
  try {
    const result = await model.generateContent(prompt);
    record(FILTER_MODEL, result.response, 'filtr');
    return result.response.text();
  } catch (err) {
    log.warn(`Model ${FILTER_MODEL} zawiódł (${err.message.slice(0, 120)}) — fallback na ${FALLBACK_MODEL}`);
    const result = await fallbackModel.generateContent(prompt);
    record(FALLBACK_MODEL, result.response, 'filtr');
    return result.response.text();
  }
}

const CATEGORIES = [
  'polska-polityka',
  'polska-spoleczenstwo',
  'wojna-i-bezpieczenstwo',
  'geopolityka-i-dyplomacja',
  'gospodarka',
  'nauka-technologia-klimat',
  'kultura-i-idee',
  'swiat-reportaz',
];

export async function filterClusters(clusters, recentTopics = []) {
  if (clusters.length === 0) return [];

  const candidates = clusters.slice(0, config.cluster.maxClustersToFilter);
  log.info(`Wysyłam ${candidates.length} wątków do Gemini (filtr, model: ${FILTER_MODEL})...`);
  if (recentTopics.length > 0) {
    log.info(`Unikam ${recentTopics.length} tematów opublikowanych w ostatnich dniach`);
  }

  const numbered = candidates.map((cluster, idx) => {
    const lead = cluster.members[0];
    const publishers = cluster.publishers.join(', ');
    return `[${idx}] (${cluster.publisherCount} wydawc${cluster.publisherCount === 1 ? 'a' : 'ów'}: ${publishers})\n` +
      `${lead.title}\n${(lead.description || '').slice(0, config.cluster.filterDescriptionChars)}`;
  });

  const recentBlock = recentTopics.length > 0
    ? `JUŻ OPUBLIKOWANE w ostatnich dniach — NIE wybieraj kolejnego artykułu o tym samym wątku, chyba że nastąpił istotny, nowy zwrot (a wtedy powiedz to w polu "temat"):
${recentTopics.map((t) => `- ${t}`).join('\n')}
`
    : '';

  const prompt = `Jesteś redaktorem prowadzącym dzienny przegląd typu "slow news" — dla czytelnika, który czyta RAZ dziennie ${config.maxItemsPerRun} tekstów i chce po nich rozumieć świat, a nie być zasypanym nagłówkami.

Lista poniżej to WĄTKI, nie pojedyncze artykuły. Jeden wątek = jedno wydarzenie opisane przez jednego lub kilku wydawców; deduplikacja została już zrobiona. Przy każdym wątku podana jest liczba niezależnych wydawców, którzy go opisali.

Wybierz dokładnie ${config.maxItemsPerRun} wątków.

NAJWAŻNIEJSZA ZASADA — RÓŻNORODNOŚĆ:
- Każdy wybrany wątek musi dotyczyć INNEGO wydarzenia i INNEGO obszaru tematycznego.
- Maksymalnie 2 wątki z jednego dużego tematu (np. wojna Rosja–Ukraina, Bliski Wschód, polityka USA). Nigdy 3 i więcej.
- Docelowo co najmniej 4 różne kategorie w zestawie.
- Zestaw pięciu tekstów o tej samej wojnie to porażka, nawet jeśli każdy osobno jest ważny.

PROPORCJE:
- 2 wątki dotyczące Polski
- 2–3 wątki dotyczące świata
- Jeśli nie ma 2 sensownych polskich tematów, weź tyle, ile jest — nie dobieraj śmieci na siłę.

LICZBA WYDAWCÓW — jak ją czytać:
- 3+ wydawców: temat potwierdzony niezależnie. Bezpieczny wybór.
- 1 wydawca to NIE jest wada sama w sobie. Materiał własny (śledztwo, reportaż, esej, analiza naukowa) z natury ma jednego wydawcę i bywa najcenniejszym tekstem dnia — wybieraj go śmiało.
- 1 wydawca PRZY zwykłej, bieżącej informacji politycznej lub sensacyjnej, którą inne redakcje powinny były podchwycić, a nie podchwyciły — traktuj podejrzliwie i raczej pomiń.

CO WARTO WYBIERAĆ:
- Konkretne decyzje i zdarzenia o realnych konsekwencjach: rządy, sądy, banki centralne, konflikty, dyplomacja.
- Gospodarka: inflacja, stopy, duże bankructwa, zmiany systemowe, rynek pracy, mieszkania, energia.
- Nauka, technologia, AI, klimat, zdrowie publiczne — przełomy i zmiany reguł gry.
- Sprawy społeczne: edukacja, migracja, wymiar sprawiedliwości, prawa obywatelskie.
- Śledztwa dziennikarskie i dobrze udokumentowane reportaże o innych krajach — nawet bez bezpośredniego wpływu na Polskę. Tekst może być wartościowy poznawczo: jak coś działa, dlaczego jakieś państwo podjęło nietypową decyzję.
- Kultura i idee, jeśli chodzi o coś więcej niż premiera lub plotka.

CO ODRZUCAĆ:
- Clickbait i sensacja bez treści; nagłówki bez faktu w środku.
- Lifestyle, dieta, moda, horoskopy, quizy, rankingi, loterie.
- Plotki i życie celebrytów.
- Wypadki drogowe i lokalna kryminalka bez znaczenia ogólniejszego.
- Sport, poza poważnym skandalem systemowym.
- Pyskówki polityków, "X odpowiedział Y" — bez konkretnego zdarzenia lub decyzji.
- Relacje "na żywo" i migawki bez zamkniętej treści.

${recentBlock}
Dostępne kategorie: ${CATEGORIES.join(', ')}

Wątki:
${numbered.join('\n\n')}

Odpowiedz WYŁĄCZNIE tablicą JSON, uporządkowaną od najważniejszego, w formacie:
[{"index": 3, "kategoria": "gospodarka", "temat": "krótki opis wątku w 3-8 słowach"}]

Pole "temat" opisuje wątek, nie nagłówek — posłuży do unikania powtórek w kolejnych dniach.
Bez markdown, bez wyjaśnień, tylko JSON.`;

  try {
    const text = (await generate(prompt)).trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];

    const seen = new Set();
    const selected = [];

    for (const entry of parsed) {
      const idx = typeof entry === 'number' ? entry : entry?.index;
      if (typeof idx !== 'number' || idx < 0 || idx >= candidates.length) continue;
      if (seen.has(idx)) continue;
      seen.add(idx);
      selected.push({
        ...candidates[idx],
        category: entry?.kategoria || 'nieokreslona',
        topic: entry?.temat || candidates[idx].members[0].title,
      });
      if (selected.length >= config.maxItemsPerRun) break;
    }

    log.ok(`Filtr wybrał ${selected.length} wątków:`);
    selected.forEach((cluster, i) =>
      log.info(`  ${i + 1}. [${cluster.category}] ${cluster.publisherCount}× ${cluster.members[0].title}  ← ${cluster.topic}`)
    );

    const categories = new Set(selected.map((s) => s.category));
    if (selected.length >= 4 && categories.size < 3) {
      log.warn(`Mała różnorodność: tylko ${categories.size} kategorie (${[...categories].join(', ')})`);
    }

    return selected;
  } catch (err) {
    log.error(`Filtr nie powiódł się: ${err.message}`);
    return [];
  }
}
