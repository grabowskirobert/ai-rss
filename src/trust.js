import config from '../config.json' with { type: 'json' };

// Poziomy zaufania:
//   T1 — feedy z config.sources, pełny tekst. Wolno ustalać fakty.
//   T2 — znany internet (agencje, duża prasa, instytucje, uczelnie, nauka).
//        Wolno dawać tło i opinie, zawsze z nazwaną atrybucją.
//   T3 — cała reszta. Nie wchodzi do tekstu; jest tylko liczona.

const TIER2 = new Set(config.trust.tier2Domains.map((d) => d.toLowerCase()));
const TIER2_SUFFIXES = config.trust.tier2Suffixes.map((s) => s.toLowerCase());
const BLOCKED = new Set((config.trust.blockedDomains || []).map((d) => d.toLowerCase()));

export function sourceUrl(entry) {
  return typeof entry === 'string' ? entry : entry.url;
}

const TIER1 = new Set(
  config.sources.map((entry) => hostOf(sourceUrl(entry))).filter(Boolean)
);

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

// bbc.co.uk dla news.bbc.co.uk — dopasowanie po sufiksie z kropką,
// żeby "notbbc.co.uk" nie przeszło jako bbc.co.uk.
function matchesSet(host, set) {
  if (set.has(host)) return true;
  for (const domain of set) {
    if (host.endsWith(`.${domain}`)) return true;
  }
  return false;
}

export function tierOf(url) {
  const host = hostOf(url);
  if (!host) return 3;
  if (matchesSet(host, BLOCKED)) return 3;
  if (matchesSet(host, TIER1)) return 1;
  if (matchesSet(host, TIER2)) return 2;
  if (TIER2_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) return 2;
  return 3;
}

const REDIRECT_HOSTS = ['vertexaisearch.cloud.google.com', 'grounding-api-redirect'];

function isRedirect(url) {
  return REDIRECT_HOSTS.some((fragment) => url.includes(fragment));
}

// Grounding zwraca redirecty Google — bez rozwinięcia nie znamy prawdziwej
// domeny ani my, ani czytelnik, więc tiering nie ma na czym pracować.
export async function resolveUrl(url, timeoutMs = 8000) {
  if (!isRedirect(url)) return url;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'manual', signal: controller.signal });
    const location = res.headers.get('location');
    return location || url;
  } catch {
    return url;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveAll(urls) {
  return Promise.all(urls.map((url) => resolveUrl(url)));
}

export function uniqueHosts(urls) {
  return [...new Set(urls.map(hostOf).filter(Boolean))];
}

// A/B/C/D — patrz feed-builder, każdy poziom ma inne oznaczenie dla czytelnika.
export function trustLevel({ publisherCount, hasFullText }) {
  if (!hasFullText) return 'D';
  if (publisherCount >= 3) return 'A';
  if (publisherCount === 2) return 'B';
  return 'C';
}
