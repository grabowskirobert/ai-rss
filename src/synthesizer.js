import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../config.json' with { type: 'json' };
import { log } from './logger.js';
import { record } from './costs.js';
import { buildCorpus, renderCorpus } from './extractor.js';
import { hostOf, resolveUrl, tierOf, trustLevel } from './trust.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function thinkingFor(key) {
  return config.thinkingBudget?.[key] >= 0
    ? { thinkingConfig: { thinkingBudget: config.thinkingBudget[key] } }
    : {};
}

// Przebieg A i B2 piszą tekst — bez narzędzi, żeby model fizycznie nie mógł
// sięgnąć poza podany kontekst. Tylko B1 ma wyszukiwarkę i NIE pisze tekstu.
const MODELS = config.models;

const factsModel = genAI.getGenerativeModel({
  model: MODELS.facts,
  generationConfig: thinkingFor('facts'),
});

const backgroundModel = genAI.getGenerativeModel({
  model: MODELS.background,
  generationConfig: thinkingFor('background'),
});

const claimsModel = genAI.getGenerativeModel({
  model: MODELS.claims,
  tools: [{ googleSearch: {} }],
  generationConfig: thinkingFor('claims'),
});

// Redakcja tylko wskazuje zdania do skreślenia — nie pisze ani słowa, więc
// nie może wprowadzić nowej treści. Odpowiedź w JSON, żeby dało się ją
// zastosować mechanicznie.
const editorModel = genAI.getGenerativeModel({
  model: MODELS.editor || MODELS.fallback,
  generationConfig: { ...thinkingFor('editor'), responseMimeType: 'application/json' },
});

const fallbackWriter = genAI.getGenerativeModel({
  model: MODELS.fallback,
  generationConfig: thinkingFor('facts'),
});

const TITLE_RULES = `Pierwsza linia odpowiedzi musi być tytułem artykułu ZAWSZE po polsku — przetłumacz, jeśli oryginał jest w innym języku. Format:
TITLE: Tutaj tytuł po polsku

Zasady tytułu:
- Poprawna, naturalna polszczyzna: sprawdź odmianę, składnię i zgodność rodzajów; nazwy własne i terminy obce zapisz poprawnie po polsku.
- Konkret zamiast zapowiedzi: kto, co i gdzie — rzeczownikowo lub jednym zdaniem oznajmującym.
- ZAKAZANE: publicystyczne metafory i idiomy prasowe ("szykuje bat", "wbija szpilę", "w ogniu", "przełom"), wykrzykniki, wielkie litery dla emfazy, słowa "szok", "pilne", "właśnie", "sensacja", pytania retoryczne, dwukropek dzielący tytuł na hasło i wyjaśnienie.
- Bez ocen i emocji, maksymalnie 90 znaków.
- Nie kopiuj tonu tytułu źródłowego — bywa tabloidowy.`;

// Wydanie jest dziś praktycznie wyłącznie słuchane — lektor czyta tekst
// dosłownie, więc zasady piszemy pod ucho, nie pod oko.
const LISTENING_RULES = `- Ten tekst jest przede wszystkim SŁUCHANY: lektor czyta go dosłownie, od tytułu do ostatniego zdania. Słuchacz nie może wrócić wzrokiem, więc każda informacja pada DOKŁADNIE RAZ, w jednym miejscu. Nie wracaj do tego, co już padło — ani innymi słowami, ani jako przypomnienie, ani jako podsumowanie lub zapowiedź.
- Jedna sprawa = jedno miejsce w tekście. Nie rozbijaj tego samego wątku na kilka punktów ani sekcji.
- Daty: dzień i miesiąc bez roku, gdy chodzi o bieżący rok ("30 października", nie "30 października 2026 r."). Rok podaj tylko wtedy, gdy wydarzenie dotyczy innego roku niż bieżący. Unikaj nawiasów i skrótów, których nie da się naturalnie przeczytać na głos.`;

// ── Przebieg A: fakty. Kontekst zamknięty, zero wyszukiwarki. ────────────────

const FACTS_PROMPT = (topic, corpus, publishers, recent) => `
Jesteś dziennikarzem piszącym po polsku dla wydawnictwa typu "slow news". Twój czytelnik czyta raz dziennie, nie śledził tej sprawy wcześniej i chce ZROZUMIEĆ, nie być na bieżąco.

Temat: ${topic}
${recent.length === 0 ? '' : `
UWAGA — TE TEMATY OPISYWALIŚMY JUŻ W OSTATNICH DNIACH:
${recent.map((t) => `- ${t}`).join('\n')}

Jeśli dzisiejszy temat jest kontynuacją któregoś z nich, to jest w porządku — ale MUSI to być widać:
- Tytuł ma nazywać NOWY element (rozstrzygnięcie, kolejny krok, reakcję), nie punkt wyjścia opisany wcześniej.
- Pierwszy punkt "Kluczowych faktów" mówi, co się zmieniło od poprzedniego opisu.
- Nie przepisuj poprzedniego tekstu. Fakty znane wcześniej streść skrótowo, miejsce oddaj nowym ustaleniom.
`}
Poniżej pełne teksty ${publishers.length === 1 ? 'publikacji' : `${publishers.length} niezależnych publikacji`} o tym wydarzeniu. To JEDYNE dopuszczalne źródło faktów. Nie wolno ci dodać żadnej informacji spoza tych tekstów — ani z pamięci, ani z domysłu. Jeśli czegoś w nich nie ma, po prostu tego nie piszesz.

=== KORPUS ŹRÓDŁOWY ===
${corpus}
=== KONIEC KORPUSU ===

${TITLE_RULES}

Następnie napisz w czystym HTML dokładnie te dwie sekcje — bez wstępu i bez podsumowania:

<h3>Kluczowe fakty</h3>
<ul>
  <li>Fakt z konkretną liczbą, datą, nazwiskiem lub instytucją</li>
</ul>
(${config.article.bulletsMin}–${config.article.bulletsMax} bulletów — tylko twarde fakty obecne w korpusie, żadnych ogólników. Pierwszy bullet mówi, co się stało. Każda liczba, nazwa i fakt pada w tekście DOKŁADNIE RAZ — tytuł się nie liczy, ale nie powtarzaj w bulletach zdania tytułu.)

<h3>Czego jeszcze nie wiemy</h3>
<p>1–3 zdania: co pozostaje niepotwierdzone, które liczby są szacunkami, jakie rozstrzygnięcia dopiero przed nami. Jeśli źródła się różnią co do jakiejś liczby lub faktu — napisz o tej rozbieżności zamiast wybierać jedną wersję albo uśredniać.</p>

Zasady:
- Pisz wyłącznie po polsku, poprawną polszczyzną; sprawdź odmianę nazw własnych i form mnogich (np. "Szwajcarzy", nie "Szwajcari").
- Obie sekcje mają łącznie ${config.article.factsCharsMin}–${config.article.factsCharsMax} znaków. Korpus jest zwykle kilka razy dłuższy niż tekst, który piszesz — to znaczy, że masz z czego wybierać, a nie że masz streszczać do minimum. Każdy fakt istotny dla zrozumienia sprawy ma trafić do tekstu: konkretne liczby, nazwiska, stanowiska stron, wcześniejsze incydenty, mechanizmy prawne, koszty, terminy.
- Nie zostawiaj na boku faktów tylko dlatego, że tekst już wygląda na kompletny. Pomijasz wyłącznie lokalny szum i powtórzenia.
${LISTENING_RULES}
- Dłuższy tekst jest pożądany, o ile każde zdanie wnosi nowy fakt albo coś wyjaśnia: mechanizm, przyczynę, kontekst instytucji, znaczenie liczby. Gdy materiał się kończy, kończysz — nie dopisuj zdań bez treści.
- Zero języka emocjonalnego, zero skrzywień politycznych, zero trybu "breaking news".
- Wyjaśniaj skróty, instytucje i nazwiska przy pierwszym użyciu.
- Twierdzenie relacjonowane ZACHOWUJE atrybucję. Jeśli źródło pisze "według portalu X" albo "rzecznik twierdzi", nigdy nie zamieniaj tego w goły fakt.
- SKIP jest ostatecznością. Odpowiedz samym słowem SKIP WYŁĄCZNIE wtedy, gdy korpus w ogóle nie dotyczy podanego tematu albo nie zawiera żadnej treści dziennikarskiej (strona błędu, sama zajawka, lista linków). Jeśli korpus zawiera choćby kilkaset znaków treści na temat — napisz tekst, choćby krótki. Trudny albo niepełny materiał to nie powód do SKIP-a, tylko powód, żeby napisać krócej i wprost zaznaczyć, czego brakuje.
- Wypisz tylko HTML (albo SKIP), bez markdown, bez wyjaśnień.
`;

// ── Przebieg B1: zbieranie twierdzeń z internetu. Nie pisze tekstu. ──────────

const CLAIMS_PROMPT = (topic, factsText) => `
Jesteś researcherem. NIE piszesz artykułu — zbierasz surowy materiał i zwracasz go jako JSON.

Temat: ${topic}

Ustalone fakty (traktuj jako prawdę, nie weryfikuj ich i nie powtarzaj):
${factsText}

Wyszukaj w internecie i zbierz maksymalnie ${config.background.maxClaims} pozycji trzech rodzajów:

1. "tlo" — kontekst historyczny: co doprowadziło do tej sytuacji, decyzje i wydarzenia sprzed miesięcy lub lat, dane historyczne, wcześniejsze etapy sprawy.
2. "perspektywa" — stanowisko konkretnego, NAZWANEGO aktora wobec sprawy: rząd, ministerstwo, partia, firma, organizacja, sąd, imiennie wskazany ekspert lub polityk. Stanowisko bez nazwanego właściciela ("krytycy", "eksperci", "komentatorzy", "internauci", "część mediów") jest bezwartościowe — nie zwracaj takich.
3. "potwierdzenie" — niezależna publikacja opisująca to samo wydarzenie, co ustalone fakty powyżej.

Dla każdej pozycji podaj PEŁNE adresy URL stron, na których faktycznie ją znalazłeś.

Odpowiedz WYŁĄCZNIE tablicą JSON, bez markdown:
[{"rodzaj": "tlo", "aktor": null, "twierdzenie": "jedno zdanie po polsku", "urls": ["https://..."]}]

Dla rodzaju "perspektywa" pole "aktor" jest obowiązkowe i musi zawierać nazwę własną.
Nie zmyślaj URL-i. Jeśli nie znalazłeś nic sensownego, zwróć [].
`;

// ── Przebieg B2: pisanie tła. Znów bez wyszukiwarki. ────────────────────────

const BACKGROUND_PROMPT = (topic, factsText, claimsBlock, maxChars) => `
Jesteś dziennikarzem piszącym po polsku dla wydawnictwa typu "slow news".

Temat: ${topic}

Ustalone fakty (nienaruszalna baza — nie wolno im zaprzeczyć ani ich powtarzać):
${factsText}

Zweryfikowany materiał uzupełniający — wyłącznie z niego wolno ci korzystać:
${claimsBlock}

Napisz w czystym HTML dokładnie te dwie sekcje — bez wstępu i bez podsumowania:

<h3>Jak do tego doszło</h3>
<p>1–2 akapity tła: co doprowadziło do tej sytuacji. Cofnij się na tyle, żeby wydarzenie stało się zrozumiałe samo z siebie — miesiące lub lata, nie ostatnie 24 godziny.</p>

<h3>Różne perspektywy</h3>
<p>Jak poszczególne strony interpretują sprawę: gdzie się rozchodzą, kto ma jaki interes, które twierdzenia są sporne. Każde stanowisko przypisz nazwanemu aktorowi — "Komisja Europejska uważa", a nie "krytycy twierdzą".</p>

Zasady:
- Obie sekcje mają łącznie NAJWYŻEJ ${maxChars} znaków. To górna granica, nie cel: wykorzystaj materiał uzupełniający, a gdy się skończy — kończ, nawet jeśli tekst wyjdzie krótki.
- Słuchacz usłyszał już ustalone fakty — NIE wolno ci powtórzyć żadnego z nich, nawet innymi słowami ani jako "stanowiska" strony. Jeśli twierdzenie z materiału uzupełniającego mówi to samo co ustalone fakty (np. że ktoś coś poparł, przerwał, ogłosił), POMIŃ je. Dokładasz wyłącznie nowy kontekst.
- ZAKAZANE zdania-wypełniacze bez faktu: "serwis X zwraca uwagę na uwarunkowania", "sytuacja dzieli ośrodki władzy", "co stanowi istotne tło", "media szczegółowo odnotowują". Każde zdanie musi zawierać konkretną informację.
${LISTENING_RULES}
- Ostatnie zdanie nie podsumowuje sprawy ani nie ocenia jej znaczenia. Gdy skończy się materiał, kończysz tekst.
- Poprawna polszczyzna: sprawdź odmianę nazw własnych i form mnogich.
- NIE WOLNO ci wprowadzić żadnej nowej liczby, daty, nazwiska ani instytucji, których nie ma w materiale powyżej.
- NIE WOLNO ci zaprzeczyć ustalonym faktom. Jeśli materiał uzupełniający jest z nimi sprzeczny — napisz wprost, że źródła się rozchodzą.
- Twierdzenie relacjonowane zachowuje atrybucję.
- Jeśli na którąś sekcję brakuje materiału, pomiń ją w całości — lepiej krócej niż na wyrost.
- Pisz wyłącznie po polsku, bez języka emocjonalnego.
- Wypisz tylko HTML, bez markdown, bez wyjaśnień.
`;

// Sekcje spoza listy (np. "Sedno sprawy" dopisane mimo promptu) wypadają
// przy składaniu — streszczenia powtarzały te same liczby w odsłuchu.
const SECTION_ORDER = [
  'Kluczowe fakty',
  'Jak do tego doszło',
  'Różne perspektywy',
  'Czego jeszcze nie wiemy',
];

function splitSections(html) {
  const sections = new Map();
  const parts = html.split(/<h3>/i).slice(1);
  for (const part of parts) {
    const end = part.indexOf('</h3>');
    if (end === -1) continue;
    sections.set(part.slice(0, end).trim(), part.slice(end + 5).trim());
  }
  return sections;
}

function assemble(...sectionMaps) {
  const merged = new Map();
  for (const map of sectionMaps) {
    for (const [name, body] of map) if (body) merged.set(name, body);
  }
  return SECTION_ORDER
    .filter((name) => merged.has(name))
    .map((name) => `<h3>${name}</h3>\n${merged.get(name)}`)
    .join('\n');
}

function extractTitle(html, fallback) {
  const match = html.match(/^TITLE:\s*(.+)/m);
  if (!match) return { title: fallback, body: html };
  return { title: match[1].trim(), body: html.replace(/^TITLE:\s*.+\n?/m, '').trim() };
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseJsonArray(text) {
  const cleaned = text.trim().replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  return Array.isArray(parsed) ? parsed : [];
}

const GENERIC_ACTORS = [
  'krytycy', 'eksperci', 'analitycy', 'komentatorzy', 'obserwatorzy', 'internauci',
  'media', 'media społecznościowe', 'opinia publiczna', 'niektórzy', 'część',
  'źródła', 'anonimowe źródła', 'użytkownicy',
];

function isNamedActor(actor) {
  if (!actor || typeof actor !== 'string') return false;
  const normalized = actor.trim().toLowerCase();
  if (normalized.length < 3) return false;
  return !GENERIC_ACTORS.some((generic) => normalized === generic || normalized.startsWith(`${generic} `));
}

// Tu odsiewa się slop: twierdzenie żyjące wyłącznie na T3 nie wchodzi do tekstu,
// a udział takich twierdzeń jest sygnałem o samym temacie.
async function vetClaims(rawClaims) {
  const stats = { total: 0, t3: 0, accepted: 0, rejectedThin: 0 };
  const accepted = [];
  const backgroundSources = new Map();

  for (const claim of rawClaims) {
    if (!claim?.twierdzenie || !Array.isArray(claim.urls) || claim.urls.length === 0) continue;
    stats.total++;

    const resolved = await Promise.all(claim.urls.slice(0, 5).map((url) => resolveUrl(url)));
    const trusted = resolved.filter((url) => tierOf(url) <= 2);
    const hosts = [...new Set(trusted.map(hostOf))];

    if (hosts.length === 0) {
      stats.t3++;
      continue;
    }

    const rodzaj = claim.rodzaj === 'perspektywa' || claim.rodzaj === 'potwierdzenie'
      ? claim.rodzaj
      : 'tlo';

    if (rodzaj === 'tlo' && hosts.length < config.background.minTier2DomainsPerBackgroundClaim) {
      stats.rejectedThin++;
      continue;
    }
    if (rodzaj === 'perspektywa' && !isNamedActor(claim.aktor)) {
      stats.rejectedThin++;
      continue;
    }

    stats.accepted++;
    accepted.push({ ...claim, rodzaj, hosts, urls: trusted });
    for (const url of trusted) {
      const host = hostOf(url);
      if (!backgroundSources.has(host)) backgroundSources.set(host, { title: host, uri: url });
    }
  }

  return { accepted, stats, backgroundSources: [...backgroundSources.values()] };
}

function renderClaims(claims) {
  const byKind = {
    tlo: claims.filter((c) => c.rodzaj === 'tlo'),
    perspektywa: claims.filter((c) => c.rodzaj === 'perspektywa'),
  };
  const block = (label, list) => list.length === 0
    ? ''
    : `${label}:\n${list.map((c) =>
        `- ${c.rodzaj === 'perspektywa' ? `[${c.aktor}] ` : ''}${c.twierdzenie} (${c.hosts.join(', ')})`
      ).join('\n')}\n`;

  return `${block('TŁO HISTORYCZNE', byKind.tlo)}\n${block('STANOWISKA', byKind.perspektywa)}`.trim()
    || '(brak zweryfikowanego materiału uzupełniającego)';
}

// Słowa porównujemy po pierwszych pięciu literach — odmiana nie ukrywa wtedy
// powtórzeń (ta sama miara co w odsłuchu).
function stems(text) {
  const words = text.toLowerCase().match(/[\p{L}\d]+/gu) ?? [];
  return new Set(words.filter((w) => w.length > 3).map((w) => w.slice(0, 5)));
}

// Model wyszukujący często zwraca jako "stanowisko" to, co już jest
// w faktach (np. "premier poparł…"). Pisarz tła przepisuje to potem
// rozwlekle i w odsłuchu ta sama informacja pada dwa razy — odsiewamy
// takie twierdzenia, zanim trafią do B2.
function dropClaimsRepeatingFacts(claims, factsText) {
  const facts = factsText.split(/(?<=[.!?…])\s+/).map(stems).filter((s) => s.size > 0);
  const threshold = config.background.claimFactOverlap ?? 0.5;
  return claims.filter((claim) => {
    const words = [...stems(claim.twierdzenie)];
    if (words.length < 4) return true;
    return !facts.some((f) => words.filter((w) => f.has(w)).length / words.length >= threshold);
  });
}

// ── Redakcja: skreślanie powtórzeń i wypełniaczy ────────────────────────────
// Przebiegi A i B2 piszą niezależnie, więc mimo zakazów tło potrafi
// opowiedzieć fakt drugi raz innymi słowami — porównanie słów tego nie łapie.
// Model dostaje ponumerowane zdania i zwraca wyłącznie numery do skreślenia;
// nic nie przepisuje, więc nie może dodać treści.

const SENTENCE_SPLIT = /(?<=[.!?…])\s+(?=[\p{Lu}„"])/u;
const BLOCK = /(<(li|p)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi;

// Zdanie to jednostka skreślenia; blok z wewnętrznymi znacznikami (np. <em>
// przez granicę zdań) traktujemy jako jedną jednostkę, żeby nie rozbić HTML.
function blockUnits(inner) {
  if (inner.includes('<')) return [inner.trim()];
  return inner.trim().split(SENTENCE_SPLIT).filter(Boolean);
}

export function listUnits(html) {
  const units = [];
  for (const part of html.split(/(?=<h3>)/i)) {
    const section = stripHtml(part.match(/<h3>([\s\S]*?)<\/h3>/i)?.[1] ?? '');
    for (const m of part.matchAll(BLOCK)) {
      for (const text of blockUnits(m[3])) units.push({ section, text: stripHtml(text) });
    }
  }
  return units;
}

export function removeUnits(html, drop) {
  let n = 0;
  const out = html.replace(BLOCK, (all, open, _tag, inner, close) => {
    const kept = blockUnits(inner).filter(() => !drop.has(n++));
    return kept.length === 0 ? '' : `${open}${kept.join(' ')}${close}`;
  });
  // Puste listy i sekcje, z których wszystko wypadło, znikają w całości.
  return out
    .replace(/<ul>\s*<\/ul>/gi, '')
    .replace(/<h3>[^<]*<\/h3>\s*(?=<h3>|$)/gi, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

const EDITOR_PROMPT = (title, units, earlier) => `
Jesteś redaktorem audycji informacyjnej czytanej przez lektora. Słuchacz słyszy każde zdanie po kolei i nie może wrócić wzrokiem, więc każda informacja ma paść DOKŁADNIE RAZ.
${earlier ? `
Przed tym tekstem w tej samej audycji słuchacz usłyszał już:
=== WCZEŚNIEJ W AUDYCJI ===
${earlier}
=== KONIEC ===
` : ''}
Tytuł (czytany jako pierwszy): ${title}

Zdania tekstu, w kolejności czytania:
${units.map((u, i) => `[${i}] (${u.section}) ${u.text}`).join('\n')}

Wskaż zdania do SKREŚLENIA. Skreśl zdanie, jeśli:
1. Powtarza informację, która padła już wcześniej — w tytule, w zdaniu o niższym numerze${earlier ? ' albo wcześniej w audycji' : ''} — nawet innymi słowami, z innej perspektywy albo z atrybucją do innego źródła ("według rmf24.pl prezydent przerwał podróż", gdy wcześniej padło, że przerwał podróż).
2. Jest wypełniaczem bez żadnego konkretu: zapowiada, podsumowuje, ocenia znaczenie sprawy albo mówi, że ktoś "zwraca uwagę na uwarunkowania", nie mówiąc jakie.

NIE skreślaj zdania, które obok powtórzenia wnosi nowy konkret (liczbę, nazwisko, datę, przyczynę, mechanizm) — wtedy zostaje. Nie skreślaj zdania [0]. W razie wątpliwości zostaw.

Odpowiedz wyłącznie JSON-em: {"skresl": [numery zdań]}
`;

async function editOut(title, html, earlier) {
  if (config.editor?.enabled === false) return html;
  const units = listUnits(html);
  if (units.length < 3) return html;

  let drop;
  try {
    const result = await editorModel.generateContent(EDITOR_PROMPT(title, units, earlier));
    record(MODELS.editor || MODELS.fallback, result.response, 'redakcja');
    const parsed = JSON.parse(result.response.text().replace(/```json|```/g, '').trim());
    drop = new Set((parsed.skresl || []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < units.length));
  } catch (err) {
    log.warn(`Redakcja nie powiodła się (${err.message.slice(0, 90)}) — tekst bez zmian`);
    return html;
  }

  // Bezpiecznik: model, który chce skreślić pół tekstu, źle zrozumiał zadanie.
  const maxShare = config.editor?.maxDropShare ?? 0.35;
  if (drop.size > units.length * maxShare) {
    log.warn(`Redakcja chciała skreślić ${drop.size}/${units.length} zdań — ignoruję`);
    return html;
  }
  if (drop.size === 0) return html;

  log.info(`Redakcja: skreślono ${drop.size}/${units.length} zdań (powtórzenia, wypełniacze)`);
  for (const n of [...drop].sort((a, b) => a - b)) log.info(`  ✂ [${units[n].section}] ${units[n].text.slice(0, 110)}`);
  return removeUnits(html, drop);
}

async function runWriter(model, modelName, prompt, stage) {
  try {
    const result = await model.generateContent(prompt);
    record(modelName, result.response, stage);
    return result.response.text().trim();
  } catch (err) {
    log.warn(`${stage}: ${modelName} zawiódł (${err.message.slice(0, 90)}) — fallback`);
    try {
      const result = await fallbackWriter.generateContent(prompt);
      record(MODELS.fallback, result.response, stage);
      return result.response.text().trim();
    } catch (fallbackErr) {
      log.error(`${stage}: fallback też zawiódł (${fallbackErr.message.slice(0, 90)})`);
      return null;
    }
  }
}

async function gatherClaims(topic, factsText) {
  if (!config.background.enabled) return null;
  try {
    const result = await claimsModel.generateContent(CLAIMS_PROMPT(topic, factsText));
    record(MODELS.claims, result.response, 'twierdzenia');
    return parseJsonArray(result.response.text());
  } catch (err) {
    log.warn(`Zbieranie tła nie powiodło się (${err.message.slice(0, 90)})`);
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function synthesizeCluster(cluster, recentTopics, earlier) {
  const topic = cluster.topic || cluster.members[0].title;
  const { articles, publishers } = await buildCorpus(cluster);

  if (articles.length === 0) {
    log.warn(`Brak pełnych tekstów dla "${topic}" — pomijam (paywall lub blokada)`);
    return null;
  }

  // A — fakty
  const factsRaw = await runWriter(
    factsModel, MODELS.facts,
    FACTS_PROMPT(topic, renderCorpus(articles), publishers, recentTopics),
    'fakty'
  );
  if (!factsRaw) return null;
  if (factsRaw.startsWith('SKIP')) {
    log.skip(`SKIP od modelu (fakty): ${topic}`);
    return null;
  }

  const { title, body: factsHtml } = extractTitle(factsRaw, cluster.members[0].title);
  const factsSections = splitSections(factsHtml);
  const factsText = stripHtml(factsHtml).slice(0, 5000);

  // B1 — zbieranie twierdzeń z internetu + odsiew po poziomach zaufania
  const rawClaims = await gatherClaims(topic, factsText);
  const vetted = rawClaims ? await vetClaims(rawClaims) : null;

  if (vetted) {
    const { total, t3, accepted, rejectedThin } = vetted.stats;
    log.info(`Tło: ${total} twierdzeń → ${accepted} przyjętych, ${t3} odrzuconych jako T3, ${rejectedThin} zbyt słabych`);

    // Wskaźnik T3 mówi o jakości WYSZUKIWANIA tła, nie o temacie. Jeśli korpus
    // stoi na kilku redakcjach, temat jest w porządku — rezygnujemy wtedy
    // z tła, a nie z tekstu. Odrzucamy tylko temat słabo udokumentowany
    // u źródła i dodatkowo powielany głównie przez serwisy bez redakcji.
    const t3Ratio = total > 0 ? t3 / total : 0;
    const mostlyJunk = total >= config.background.t3MinClaimsForSkip
      && t3Ratio >= config.background.t3RatioSkipThreshold;

    if (mostlyJunk && publishers.length < 2) {
      log.warn(
        `🚩 "${topic}": jeden wydawca w korpusie i ${Math.round(t3Ratio * 100)}% tła z serwisów bez redakcji — pomijam temat`
      );
      return null;
    }
    if (mostlyJunk) {
      log.warn(
        `"${topic}": ${Math.round(t3Ratio * 100)}% tła z serwisów bez redakcji — piszę bez sekcji tła ` +
        `(korpus: ${publishers.length} wydawców, więc same fakty są w porządku)`
      );
      vetted.accepted = [];
    }
  }

  // B2 — pisanie tła wyłącznie z przefiltrowanego materiału
  let backgroundSections = new Map();
  const usable = vetted ? dropClaimsRepeatingFacts(vetted.accepted, factsText) : [];
  if (vetted && usable.length < vetted.accepted.length) {
    log.info(`Tło: ${vetted.accepted.length - usable.length} twierdzeń powtarza fakty — pomijam je`);
  }
  const forWriter = usable.filter((c) => c.rodzaj !== 'potwierdzenie');
  if (forWriter.length > 0) {
    // Długość tła rośnie z ilością materiału — sztywne minimum kazało
    // modelowi rozwlekać jedno twierdzenie w akapit wypełniaczy.
    const { backgroundCharsMin, backgroundCharsMax, backgroundCharsPerClaim } = config.article;
    const maxChars = Math.max(
      backgroundCharsMin,
      Math.min(backgroundCharsMax, forWriter.length * (backgroundCharsPerClaim ?? 260))
    );
    const backgroundRaw = await runWriter(
      backgroundModel, MODELS.background,
      BACKGROUND_PROMPT(topic, factsText, renderClaims(forWriter), maxChars),
      'tlo'
    );
    if (backgroundRaw && !backgroundRaw.startsWith('SKIP')) {
      backgroundSections = splitSections(backgroundRaw);
    }
  } else {
    log.warn(`Brak zweryfikowanego tła dla "${topic}" — tekst tylko z faktów`);
  }

  const confirmations = vetted
    ? [...new Set(vetted.accepted.filter((c) => c.rodzaj === 'potwierdzenie').flatMap((c) => c.hosts))]
    : [];
  const level = trustLevel({
    corpusPublishers: publishers.length,
    confirmations: confirmations.length,
    hasFullText: true,
  });

  const html = await editOut(title, assemble(factsSections, backgroundSections), earlier);
  const factSources = articles.map((a) => ({ title: `${a.source} — ${a.title}`, uri: a.link }));

  log.ok(
    `Zsyntezowano [${level}] ${title} — ${stripHtml(html).length} zn., ` +
    `${factSources.length} źródeł faktów, ${vetted?.backgroundSources.length || 0} źródeł tła`
  );

  return {
    ...cluster.members[0],
    title,
    html,
    category: cluster.category,
    topic: cluster.topic,
    sources: factSources,
    backgroundSources: vetted?.backgroundSources || [],
    publishers,
    corroborations: confirmations,
    trustLevel: level,
  };
}

export async function synthesizeClusters(clusters, { target, recentTopics = [] } = {}) {
  const limit = target || clusters.length;
  const synthesized = [];

  for (let i = 0; i < clusters.length && synthesized.length < limit; i++) {
    if (i > 0 && config.delayBetweenRequestsMs > 0) await sleep(config.delayBetweenRequestsMs);

    const cluster = clusters[i];
    const reserve = i >= limit ? ' (rezerwa)' : '';
    log.info(`Synteza (${synthesized.length + 1}/${limit})${reserve}: ${cluster.members[0].title}`);

    try {
      // Redakcja widzi teksty, które w audycji padną wcześniej — ta sama
      // informacja nie wraca wtedy w kolejnym temacie.
      const earlier = synthesized
        .map((a) => `${a.title}: ${stripHtml(a.html)}`)
        .join('\n')
        .slice(-(config.editor?.earlierChars ?? 12000));
      const result = await synthesizeCluster(cluster, recentTopics, earlier);
      if (result) synthesized.push(result);
    } catch (err) {
      log.error(`Synteza wywróciła się: ${err.message.slice(0, 120)}`);
    }
  }

  if (synthesized.length < limit) {
    log.warn(`Udało się opracować ${synthesized.length} z ${limit} tematów — rezerwa wyczerpana`);
  }

  return synthesized;
}
