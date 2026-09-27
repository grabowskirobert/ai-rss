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

// ── Przebieg A: fakty. Kontekst zamknięty, zero wyszukiwarki. ────────────────

const FACTS_PROMPT = (topic, corpus, publishers) => `
Jesteś dziennikarzem piszącym po polsku dla wydawnictwa typu "slow news". Twój czytelnik czyta raz dziennie, nie śledził tej sprawy wcześniej i chce ZROZUMIEĆ, nie być na bieżąco.

Temat: ${topic}

Poniżej pełne teksty ${publishers.length === 1 ? 'publikacji' : `${publishers.length} niezależnych publikacji`} o tym wydarzeniu. To JEDYNE dopuszczalne źródło faktów. Nie wolno ci dodać żadnej informacji spoza tych tekstów — ani z pamięci, ani z domysłu. Jeśli czegoś w nich nie ma, po prostu tego nie piszesz.

=== KORPUS ŹRÓDŁOWY ===
${corpus}
=== KONIEC KORPUSU ===

${TITLE_RULES}

Następnie napisz w czystym HTML dokładnie te trzy sekcje:

<h3>Sedno sprawy</h3>
<p>2–3 zdania: co się stało i dlaczego to ma znaczenie. Pisz tak, jakby czytelnik nie znał sprawy w ogóle — bez odsyłania do "wczorajszych doniesień".</p>

<h3>Kluczowe fakty</h3>
<ul>
  <li>Fakt z konkretną liczbą, datą, nazwiskiem lub instytucją</li>
</ul>
(5–7 bulletów — tylko twarde fakty obecne w korpusie, żadnych ogólników)

<h3>Czego jeszcze nie wiemy</h3>
<p>1–3 zdania: co pozostaje niepotwierdzone, które liczby są szacunkami, jakie rozstrzygnięcia dopiero przed nami. Jeśli źródła się różnią co do jakiejś liczby lub faktu — napisz o tej rozbieżności zamiast wybierać jedną wersję albo uśredniać.</p>

Zasady:
- Pisz wyłącznie po polsku, poprawną polszczyzną; sprawdź odmianę nazw własnych i form mnogich (np. "Szwajcarzy", nie "Szwajcari").
- Te trzy sekcje mają łącznie 1800–2800 znaków. Wykorzystaj korpus — jeśli zawiera fakt istotny dla zrozumienia sprawy, ma trafić do tekstu.
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

const BACKGROUND_PROMPT = (topic, factsText, claimsBlock) => `
Jesteś dziennikarzem piszącym po polsku dla wydawnictwa typu "slow news".

Temat: ${topic}

Ustalone fakty (nienaruszalna baza — nie wolno im zaprzeczyć ani ich powtarzać):
${factsText}

Zweryfikowany materiał uzupełniający — wyłącznie z niego wolno ci korzystać:
${claimsBlock}

Napisz w czystym HTML dokładnie te trzy sekcje:

<h3>Jak do tego doszło</h3>
<p>1–2 akapity tła: co doprowadziło do tej sytuacji. Cofnij się na tyle, żeby wydarzenie stało się zrozumiałe samo z siebie — miesiące lub lata, nie ostatnie 24 godziny.</p>

<h3>Różne perspektywy</h3>
<p>Jak poszczególne strony interpretują sprawę: gdzie się rozchodzą, kto ma jaki interes, które twierdzenia są sporne. Każde stanowisko przypisz nazwanemu aktorowi — "Komisja Europejska uważa", a nie "krytycy twierdzą".</p>

<h3>Dlaczego to ma znaczenie</h3>
<p>Konsekwencje i kolejne kroki: co realnie się zmieni, dla kogo, w jakim horyzoncie czasowym. Jeśli temat dotyczy innego kraju i nie wpływa bezpośrednio na Polskę, wyjaśnij, co ciekawego mówi o tym, jak działa świat — to pełnoprawna odpowiedź, nie brak odpowiedzi.</p>

Zasady:
- Te trzy sekcje mają łącznie 1800–2600 znaków. Nie rozciągaj na siłę, ale wykorzystaj cały dostępny materiał.
- Nie powtarzaj faktów z sekcji powyżej — dokładasz kontekst, nie streszczasz drugi raz.
- Poprawna polszczyzna: sprawdź odmianę nazw własnych i form mnogich.
- NIE WOLNO ci wprowadzić żadnej nowej liczby, daty, nazwiska ani instytucji, których nie ma w materiale powyżej.
- NIE WOLNO ci zaprzeczyć ustalonym faktom. Jeśli materiał uzupełniający jest z nimi sprzeczny — napisz wprost, że źródła się rozchodzą.
- Twierdzenie relacjonowane zachowuje atrybucję.
- Jeśli na którąś sekcję brakuje materiału, pomiń ją w całości — lepiej krócej niż na wyrost.
- Pisz wyłącznie po polsku, bez języka emocjonalnego.
- Wypisz tylko HTML, bez markdown, bez wyjaśnień.
`;

const SECTION_ORDER = [
  'Sedno sprawy',
  'Kluczowe fakty',
  'Jak do tego doszło',
  'Różne perspektywy',
  'Dlaczego to ma znaczenie',
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

async function synthesizeCluster(cluster) {
  const topic = cluster.topic || cluster.members[0].title;
  const { articles, publishers } = await buildCorpus(cluster);

  if (articles.length === 0) {
    log.warn(`Brak pełnych tekstów dla "${topic}" — pomijam (paywall lub blokada)`);
    return null;
  }

  // A — fakty
  const factsRaw = await runWriter(
    factsModel, MODELS.facts,
    FACTS_PROMPT(topic, renderCorpus(articles), publishers),
    'fakty'
  );
  if (!factsRaw) return null;
  if (factsRaw.startsWith('SKIP')) {
    log.skip(`SKIP od modelu (fakty): ${topic}`);
    return null;
  }

  const { title, body: factsHtml } = extractTitle(factsRaw, cluster.members[0].title);
  const factsSections = splitSections(factsHtml);
  const factsText = stripHtml(factsHtml).slice(0, 2600);

  // B1 — zbieranie twierdzeń z internetu + odsiew po poziomach zaufania
  const rawClaims = await gatherClaims(topic, factsText);
  const vetted = rawClaims ? await vetClaims(rawClaims) : null;

  if (vetted) {
    const { total, t3, accepted, rejectedThin } = vetted.stats;
    log.info(`Tło: ${total} twierdzeń → ${accepted} przyjętych, ${t3} odrzuconych jako T3, ${rejectedThin} zbyt słabych`);

    const t3Ratio = total > 0 ? t3 / total : 0;
    if (total >= config.background.t3MinClaimsForSkip && t3Ratio >= config.background.t3RatioSkipThreshold) {
      log.warn(
        `🚩 "${topic}": ${Math.round(t3Ratio * 100)}% materiału z serwisów bez redakcji — pomijam temat`
      );
      return null;
    }
  }

  // B2 — pisanie tła wyłącznie z przefiltrowanego materiału
  let backgroundSections = new Map();
  if (vetted && vetted.accepted.length > 0) {
    const backgroundRaw = await runWriter(
      backgroundModel, MODELS.background,
      BACKGROUND_PROMPT(topic, factsText, renderClaims(vetted.accepted)),
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

  const html = assemble(factsSections, backgroundSections);
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

export async function synthesizeClusters(clusters) {
  const synthesized = [];

  for (let i = 0; i < clusters.length; i++) {
    if (i > 0 && config.delayBetweenRequestsMs > 0) await sleep(config.delayBetweenRequestsMs);

    const cluster = clusters[i];
    log.info(`Synteza (${i + 1}/${clusters.length}): ${cluster.members[0].title}`);

    try {
      const result = await synthesizeCluster(cluster);
      if (result) synthesized.push(result);
    } catch (err) {
      log.error(`Synteza wywróciła się: ${err.message.slice(0, 120)}`);
    }
  }

  return synthesized;
}
