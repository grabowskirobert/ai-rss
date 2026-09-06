import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../config.json' with { type: 'json' };

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const modelWithSearch = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash-lite',
  tools: [{ googleSearch: {} }],
});

const modelFallback = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

const SYNTHESIS_PROMPT = (title, description) => `
Jesteś neutralnym dziennikarzem piszącym syntezę dla poważnego dziennika newsowego. Piszesz po polsku.

Temat: ${title}
Oryginalne streszczenie: ${description}

Wyszukaj temat w co najmniej 3 niezależnych źródłach i napisz artykuł syntetyzujący w czystym HTML, dokładnie według tej struktury:

<h3>Sedno sprawy</h3>
<p>1–2 zdania opisujące istotę problemu.</p>

<h3>Kluczowe fakty</h3>
<ul>
  <li>Fakt 1 (liczby, daty, konkretne decyzje)</li>
  <li>Fakt 2</li>
  <li>Fakt 3</li>
</ul>

<h3>Kontekst i różne perspektywy</h3>
<p>Szerszy kontekst i ewentualne różnice w interpretacji między źródłami.</p>

Zasady:
- Pisz wyłącznie po polsku
- Zero języka emocjonalnego i politycznych skrzywień
- Tylko weryfikowalne fakty, żadnych spekulacji
- Jeśli temat okazał się nieistotny lub nie możesz go zweryfikować — odpowiedz słowem SKIP
- Wypisz tylko HTML (albo SKIP), bez markdown, bez wyjaśnień
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function synthesizeItems(items) {
  const synthesized = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (i > 0) await sleep(config.delayBetweenRequestsMs);

    console.log(`[synthesizer] (${i + 1}/${items.length}): ${item.title}`);

    let html = await tryWithSearch(item);
    if (html === null) html = await tryFallback(item);
    if (html === null) {
      console.log(`[synthesizer] Pomijam (błąd): ${item.title}`);
      continue;
    }

    if (html.trim().startsWith('SKIP')) {
      console.log(`[synthesizer] SKIP: ${item.title}`);
      continue;
    }

    synthesized.push({ ...item, html });
  }

  return synthesized;
}

async function tryWithSearch(item) {
  try {
    const result = await modelWithSearch.generateContent(
      SYNTHESIS_PROMPT(item.title, item.description)
    );
    return result.response.text().trim();
  } catch (err) {
    console.warn(`[synthesizer] Search grounding error dla "${item.title}": ${err.message}`);
    return null;
  }
}

async function tryFallback(item) {
  try {
    const result = await modelFallback.generateContent(
      SYNTHESIS_PROMPT(item.title, item.description)
    );
    return result.response.text().trim();
  } catch (err) {
    console.error(`[synthesizer] Fallback error dla "${item.title}": ${err.message}`);
    return null;
  }
}
