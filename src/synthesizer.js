import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../config.json' with { type: 'json' };
import { log } from './logger.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const modelWithSearch = genAI.getGenerativeModel({
  model: 'gemini-3.5-flash-lite',
  tools: [{ googleSearch: {} }],
});

const modelFallback = genAI.getGenerativeModel({ model: 'gemini-3.5-flash-lite' });

const SYNTHESIS_PROMPT = (title, description) => `
Jesteś neutralnym dziennikarzem piszącym syntezę dla poważnego dziennika newsowego. Piszesz po polsku.

Temat: ${title}
Oryginalne streszczenie: ${description}

Pierwsza linia odpowiedzi musi być tytułem artykułu ZAWSZE po polsku — przetłumacz jeśli oryginał jest w innym języku (angielskim, niemieckim, itd.), zachowaj tylko jeśli już po polsku. Tytuł musi być zwięzły i informacyjny. Format:
TITLE: Tutaj tytuł po polsku

Następnie wyszukaj temat w co najmniej 3 niezależnych źródłach i napisz artykuł syntetyzujący w czystym HTML, dokładnie według tej struktury:

<h3>Sedno sprawy</h3>
<p>2–3 zdania opisujące istotę problemu — co się stało, kto jest zaangażowany i dlaczego to ważne.</p>

<h3>Kluczowe fakty</h3>
<ul>
  <li>Fakt z konkretną liczbą, datą lub nazwiskiem</li>
  <li>Fakt z konkretną liczbą, datą lub nazwiskiem</li>
  <li>Fakt z konkretną liczbą, datą lub nazwiskiem</li>
  <li>Fakt z konkretną liczbą, datą lub nazwiskiem</li>
</ul>
(4–6 bulletów — tylko twarde fakty, żadnych ogólników)

<h3>Kontekst i różne perspektywy</h3>
<p>Akapit 1: tło historyczne lub geopolityczne — co doprowadziło do tej sytuacji.</p>
<p>Akapit 2: jak różne strony lub źródła interpretują to wydarzenie — rozbieżności, spory, różne narracje.</p>
<p>Akapit 3 (jeśli materiał na to pozwala): możliwe konsekwencje lub kolejne kroki.</p>

Zasady:
- Pisz wyłącznie po polsku
- Zero języka emocjonalnego i politycznych skrzywień
- Tylko weryfikowalne fakty z co najmniej 3 źródeł — jeśli czegoś nie możesz potwierdzić, nie pisz
- Docelowa długość: 2000–4000 znaków, ale nie rozciągaj sztucznie — jeśli materiał jest prosty, krótszy artykuł jest lepszy niż wypełniacz
- Jeśli temat okazał się nieistotny lub nie możesz go zweryfikować — odpowiedz słowem SKIP
- Wypisz tylko HTML (albo SKIP), bez markdown, bez wyjaśnień
`;

function extractTitle(html, fallback) {
  const match = html.match(/^TITLE:\s*(.+)/m);
  if (!match) return { title: fallback, body: html };
  const title = match[1].trim();
  const body = html.replace(/^TITLE:\s*.+\n?/m, '').trim();
  return { title, body };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function synthesizeItems(items) {
  const synthesized = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (i > 0) {
      log.info(`Czekam ${config.delayBetweenRequestsMs}ms przed kolejnym zapytaniem...`);
      await sleep(config.delayBetweenRequestsMs);
    }

    log.info(`Synteza (${i + 1}/${items.length}): ${item.title}`);

    let html = await tryWithSearch(item);
    if (html === null) {
      log.warn(`Search grounding niedostępny, używam fallback dla: ${item.title}`);
      html = await tryFallback(item);
    }

    if (html === null) {
      log.error(`Oba modele zawiodły, pomijam: ${item.title}`);
      continue;
    }

    if (html.trim().startsWith('SKIP')) {
      log.skip(`SKIP od modelu: ${item.title}`);
      continue;
    }

    const { title, body } = extractTitle(html, item.title);
    log.ok(`Zsyntezowano: ${title}`);
    synthesized.push({ ...item, title, html: body });
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
    log.warn(`Search grounding error: ${err.message.slice(0, 120)}`);
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
    log.error(`Fallback error: ${err.message.slice(0, 120)}`);
    return null;
  }
}
