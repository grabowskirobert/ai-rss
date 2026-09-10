import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../config.json' with { type: 'json' };
import { log } from './logger.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: config.filterModel });
const fallbackModel = genAI.getGenerativeModel({ model: config.synthesisModel });

async function generate(prompt) {
  try {
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    log.warn(`Model ${config.filterModel} zawiódł (${err.message.slice(0, 120)}) — fallback na ${config.synthesisModel}`);
    const result = await fallbackModel.generateContent(prompt);
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

export async function filterItems(items, recentTopics = []) {
  if (items.length === 0) return [];

  log.info(`Wysyłam ${items.length} artykułów do Gemini (filtr, model: ${config.filterModel})...`);
  if (recentTopics.length > 0) {
    log.info(`Unikam ${recentTopics.length} tematów opublikowanych w ostatnich dniach`);
  }

  const numbered = items.map((item, idx) =>
    `[${idx}] (${item.source}) ${item.title}\n${(item.description || '').slice(0, 400)}`
  );

  const recentBlock = recentTopics.length > 0
    ? `JUŻ OPUBLIKOWANE w ostatnich dniach — NIE wybieraj kolejnego artykułu o tym samym wątku, chyba że nastąpił istotny, nowy zwrot (a wtedy powiedz to w polu "temat"):
${recentTopics.map((t) => `- ${t}`).join('\n')}
`
    : '';

  const prompt = `Jesteś redaktorem prowadzącym dzienny przegląd typu "slow news" — dla czytelnika, który czyta RAZ dziennie ${config.maxItemsPerRun} tekstów i chce po nich rozumieć świat, a nie być zasypanym nagłówkami.

Wybierz dokładnie ${config.maxItemsPerRun} artykułów z listy poniżej.

NAJWAŻNIEJSZA ZASADA — RÓŻNORODNOŚĆ:
- Każdy z wybranych artykułów musi dotyczyć INNEGO wydarzenia i INNEGO wątku tematycznego.
- Maksymalnie 2 artykuły z jednego dużego wątku (np. wojna Rosja–Ukraina, niemiecka polityka wewnętrzna, Bliski Wschód). Nigdy 3 i więcej.
- Docelowo co najmniej 4 różne kategorie w zestawie.
- Zestaw pięciu tekstów o tej samej wojnie to porażka, nawet jeśli każdy z nich osobno jest ważny.

PROPORCJE:
- 2 artykuły dotyczące Polski
- 2–3 artykuły dotyczące świata
- Jeśli w materiale nie ma 2 sensownych polskich tematów, weź tyle, ile jest — nie dobieraj śmieci na siłę.

CO WARTO WYBIERAĆ:
- Konkretne decyzje i zdarzenia o realnych konsekwencjach: rządy, sądy, banki centralne, konflikty, dyplomacja.
- Gospodarka: inflacja, stopy, duże bankructwa, zmiany systemowe, rynek pracy, mieszkania, energia.
- Nauka, technologia, AI, klimat, zdrowie publiczne — przełomy i zmiany reguł gry.
- Sprawy społeczne: edukacja, migracja, wymiar sprawiedliwości, prawa obywatelskie.
- Ciekawe, dobrze udokumentowane historie o innych krajach i społeczeństwach — nawet bez bezpośredniego wpływu na Polskę. Tekst może być po prostu wartościowy poznawczo: jak coś działa, dlaczego jakieś państwo podjęło nietypową decyzję, jak zmienia się jakieś zjawisko. Takie teksty są pożądane, nie są "mniej poważne".
- Kultura i idee, jeśli chodzi o coś więcej niż premiera lub plotka.

CO ODRZUCAĆ:
- Clickbait i sensacja bez treści; nagłówki bez faktu w środku.
- Lifestyle, dieta, moda, horoskopy, quizy, rankingi, loterie.
- Plotki i życie celebrytów.
- Wypadki drogowe i lokalna kryminalka bez znaczenia ogólniejszego.
- Sport, poza poważnym skandalem systemowym.
- Pyskówki polityków, przepychanki słowne, "X odpowiedział Y" — bez konkretnego zdarzenia lub decyzji.
- Relacje "na żywo" i migawki bez zamkniętej treści.

DEDUPLIKACJA W OBRĘBIE LISTY: kilka artykułów o tym samym wydarzeniu — nawet w różnych językach (polski, angielski, niemiecki) — to jeden temat. Wybierz jeden, z najlepszego źródła.

${recentBlock}
Dostępne kategorie: ${CATEGORIES.join(', ')}

Artykuły:
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
      if (typeof idx !== 'number' || idx < 0 || idx >= items.length) continue;
      if (seen.has(idx)) continue;
      seen.add(idx);
      selected.push({
        ...items[idx],
        category: entry?.kategoria || 'nieokreslona',
        topic: entry?.temat || items[idx].title,
      });
      if (selected.length >= config.maxItemsPerRun) break;
    }

    log.ok(`Filtr wybrał ${selected.length} artykułów:`);
    selected.forEach((item, i) =>
      log.info(`  ${i + 1}. [${item.category}] ${item.title}  ← ${item.topic}`)
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
