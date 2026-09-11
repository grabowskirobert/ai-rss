import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../config.json' with { type: 'json' };
import { log } from './logger.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const modelWithSearch = genAI.getGenerativeModel({
  model: config.synthesisModel,
  tools: [{ googleSearch: {} }],
});

const modelFallback = genAI.getGenerativeModel({ model: config.synthesisModel });
const titleModel = genAI.getGenerativeModel({ model: config.filterModel });

const SYNTHESIS_PROMPT = (title, description) => `
Jesteś dziennikarzem piszącym po polsku dla wydawnictwa typu "slow news" (w duchu Delayed Gratification albo Long Reads). Twój czytelnik czyta raz dziennie, nie śledził tej sprawy wcześniej i nie ma czasu na trzecią aktualizację tego samego wątku. Chce ZROZUMIEĆ, nie być na bieżąco.

Temat: ${title}
Oryginalne streszczenie: ${description}

Pierwsza linia odpowiedzi musi być tytułem artykułu ZAWSZE po polsku — przetłumacz, jeśli oryginał jest w innym języku; sprawdź poprawność gramatyczną i odmianę. Format:
TITLE: Tutaj tytuł po polsku

Następnie wyszukaj temat w co najmniej 3 niezależnych źródłach i napisz tekst w czystym HTML, dokładnie według tej struktury:

<h3>Sedno sprawy</h3>
<p>2–3 zdania: co się stało i dlaczego to ma znaczenie. Pisz tak, jakby czytelnik nie znał tej sprawy w ogóle — bez odsyłania do "wczorajszych doniesień".</p>

<h3>Kluczowe fakty</h3>
<ul>
  <li>Fakt z konkretną liczbą, datą, nazwiskiem lub instytucją</li>
</ul>
(4–6 bulletów — tylko twarde, weryfikowalne fakty, żadnych ogólników)

<h3>Jak do tego doszło</h3>
<p>1–2 akapity tła: co doprowadziło do tej sytuacji. Cofnij się na tyle, żeby wydarzenie stało się zrozumiałe samo z siebie — miesiące lub lata, nie ostatnie 24 godziny.</p>

<h3>Różne perspektywy</h3>
<p>Jak strony i źródła interpretują sprawę: gdzie się rozchodzą, kto ma jaki interes, które twierdzenia są sporne.</p>

<h3>Dlaczego to ma znaczenie</h3>
<p>Konsekwencje i kolejne kroki: co realnie się zmieni, dla kogo, w jakim horyzoncie czasowym. Jeśli temat dotyczy innego kraju i nie wpływa bezpośrednio na Polskę, wyjaśnij, co ciekawego mówi o tym, jak działa świat — to pełnoprawna odpowiedź, nie brak odpowiedzi.</p>

<h3>Czego jeszcze nie wiemy</h3>
<p>1–3 zdania: co pozostaje niepotwierdzone, jakie liczby są szacunkami, jakie rozstrzygnięcia dopiero przed nami. Jeśli wszystko jest jasne, pomiń całą tę sekcję.</p>

Zasady:
- Pisz wyłącznie po polsku, poprawną polszczyzną; sprawdź odmianę nazw własnych.
- Zero języka emocjonalnego, zero politycznych skrzywień, zero trybu "breaking news" — bez "właśnie", "przed chwilą", "dramatyczny zwrot".
- Wyjaśniaj skróty, instytucje i nazwiska przy pierwszym użyciu.
- Tylko fakty potwierdzone w co najmniej 2–3 źródłach. Czego nie możesz potwierdzić, nie piszesz — albo mówisz wprost, że jest niepotwierdzone.
- Docelowa długość: 3000–5000 znaków. Nie rozciągaj sztucznie — brak wypełniaczy jest ważniejszy niż długość.
- Jeśli temat okazał się nieistotny lub niemożliwy do zweryfikowania — odpowiedz słowem SKIP.
- Wypisz tylko HTML (albo SKIP), bez markdown, bez wyjaśnień.
`;

const TITLE_PROMPT = (draftTitle, body) => `
Napisz tytuł polskiego artykułu prasowego typu slow news na podstawie tekstu poniżej.

Wymagania:
- Poprawna, naturalna polszczyzna: sprawdź odmianę, składnię i zgodność rodzajów. Nazwy własne i obce terminy zapisz poprawnie po polsku.
- Konkret zamiast zapowiedzi: kto, co i gdzie. Najlepiej rzeczownikowo lub jednym zdaniem oznajmującym.
- ZAKAZANE: publicystyczne metafory i idiomy prasowe ("szykuje bat", "wbija szpilę", "twarde stanowisko", "w ogniu", "przełom"), wykrzykniki, wielkie litery dla emfazy, słowa "szok", "pilne", "właśnie", "sensacja", pytania retoryczne, dwukropek dzielący tytuł na hasło i wyjaśnienie.
- Bez ocen i emocji — czytelnik ma poznać fakt, nie nastrój.
- Maksymalnie 90 znaków.

Roboczy tytuł (może być tabloidowy — nie kopiuj jego tonu): ${draftTitle}

Tekst artykułu:
${body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 2500)}

Odpowiedz WYŁĄCZNIE samym tytułem, w jednej linii, bez cudzysłowów i bez żadnych prefiksów.
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

    let result = await tryWithSearch(item);
    if (result === null) {
      log.warn(`Search grounding niedostępny, używam fallback dla: ${item.title}`);
      result = await tryFallback(item);
    }

    const html = result?.text ?? null;
    const sources = result?.sources ?? [];

    if (html === null) {
      log.error(`Oba modele zawiodły, pomijam: ${item.title}`);
      continue;
    }

    if (html.trim().startsWith('SKIP')) {
      log.skip(`SKIP od modelu: ${item.title}`);
      continue;
    }

    const { title, body } = extractTitle(html, item.title);
    const finalTitle = await refineTitle(title, body);
    if (finalTitle !== title) log.info(`  tytuł poprawiony: "${title}" → "${finalTitle}"`);
    log.ok(`Zsyntezowano: ${finalTitle}${sources.length ? ` (${sources.length} źródeł)` : ' (bez źródeł!)'}`);
    synthesized.push({ ...item, title: finalTitle, html: body, sources });
  }

  return synthesized;
}

function extractSources(response) {
  const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const seen = new Set();
  const sources = [];

  for (const chunk of chunks) {
    const uri = chunk?.web?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ title: chunk.web.title || uri, uri });
  }

  return sources;
}

async function tryWithSearch(item) {
  try {
    const result = await modelWithSearch.generateContent(
      SYNTHESIS_PROMPT(item.title, item.description)
    );
    return {
      text: result.response.text().trim(),
      sources: extractSources(result.response),
    };
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
    return { text: result.response.text().trim(), sources: [] };
  } catch (err) {
    log.error(`Fallback error: ${err.message.slice(0, 120)}`);
    return null;
  }
}

async function refineTitle(draftTitle, body) {
  try {
    const result = await titleModel.generateContent(TITLE_PROMPT(draftTitle, body));
    const title = result.response.text().trim().split('\n')[0].replace(/^["'„]|["'"]$/g, '').trim();
    if (!title || title.length > 140) return draftTitle;
    return title;
  } catch (err) {
    log.warn(`Poprawa tytułu nie udała się (${err.message.slice(0, 80)}) — zostawiam oryginał`);
    return draftTitle;
  }
}
