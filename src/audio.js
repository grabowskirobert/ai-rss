import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../config.json' with { type: 'json' };
import { log } from './logger.js';
import { record } from './costs.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const OPTS = config.audio;

// Gemini TTS zwraca WAV 24 kHz mono 16-bit; rozliczenie to stałe ~32 tokeny
// na sekundę nagrania, niezależnie od modelu i proszonego tempa (zmierzone).
const SAMPLE_RATE = 24000;
const BYTES_PER_SEC = SAMPLE_RATE * 2;
const WAV_HEADER = 44;

const scriptModel = genAI.getGenerativeModel({
  model: config.models.script,
  generationConfig: config.thinkingBudget?.script >= 0
    ? { thinkingConfig: { thinkingBudget: config.thinkingBudget.script } }
    : {},
});

// Jeden temat = jedno wywołanie. Powód: przy jednym wywołaniu na całe wydanie
// model pisze tyle, ile uzna za stosowne, a podana liczba znaków nic nie robi —
// zmierzone: cel 13 500 → 19 669 zn, cel 17 000 → 12 121 zn (ten sam materiał).
// Cel rzędu 3 500 znaków na pojedynczy temat trafia w okolicę ±15%, więc
// długość audycji staje się sterowalna, a przez to sterowalny jest koszt TTS.
const SCRIPT_RULES = `- NIE CZYTAJ artykułu słowo w słowo i NIE wymieniaj nazw sekcji ("Sedno sprawy", "Kluczowe fakty"). Przepisz treść na żywą mowę.
- NIE GUB informacji: każdy fakt, liczba, nazwisko i wniosek ma się znaleźć w tekście. Skracasz formę, nie treść.
- Liczby zapisuj słownie, tak jak się je wymawia ("siedemdziesiąt procent", "siedem i cztery dziesiąte miliarda franków").
- Skróty i nazwy obce rozwijaj przy pierwszym użyciu, zapisuj fonetycznie tam, gdzie lektor mógłby się pomylić.
- Zero nagłówków, zero punktorów, zero znaczników, zero pustych linii — jeden ciągły akapit do przeczytania.
- Ton: spokojny, rzeczowy, ciekawy. Bez emocji i bez "breaking news".`;

const TOPIC_PROMPT = ({ article, budget, previous, previousTitle, used, isFirst, isLast }) => `Jesteś autorem i prowadzącym codzienny przegląd "slow news" do odsłuchu. Opracuj JEDEN temat audycji na podstawie poniższego tekstu.

DŁUGOŚĆ: dokładnie około ${budget} znaków. To wymóg — nie ${Math.round(budget * 0.6)}, nie ${Math.round(budget * 1.4)}. Jeśli kończysz poniżej budżetu, znaczy że pominąłeś fakty z tekstu źródłowego; jeśli powyżej — rozwlekle formułujesz.

${SCRIPT_RULES}
${isFirst
  ? '- To PIERWSZY temat audycji. Zacznij od JEDNEGO zdania powitania i od razu przechodź do treści. Nie zapowiadaj, ile będzie tematów, nie opisuj charakteru audycji ("spokojny przegląd"), nie podawaj daty.'
  : `- To KOLEJNY temat audycji. Zacznij od przejścia przez treść, geografię albo wątek ("z Berna przenosimy się do Warszawy", "zostajemy przy pieniądzach, ale zmieniamy kontynent"). Nigdy nie numeruj ("temat drugi") i nigdy nie powtarzaj formuły powitania.
  Poprzedni temat dotyczył: "${previousTitle}" i skończył się tak: "${previous}"
  Przejście ma wychodzić OD TEGO tematu — nie od miejsca czy wątku, którego w nim nie było.${used.length ? `
  Wcześniejsze przejścia w tej audycji zaczynały się od: ${used.map((u) => `"${u}"`).join(', ')}. Twoje ma zaczynać się INACZEJ — ani tymi samymi słowami, ani tą samą konstrukcją gramatyczną (jeśli poprzednie zaczynały się od przyzwolenia "mimo że"/"choć", użyj innej figury).` : ''}`}
${isLast ? '- To OSTATNI temat. Zakończ jednym zdaniem domknięcia. Bez zapraszania na kolejne wydanie.' : ''}

Zwróć sam tekst tematu, bez komentarza.

TEKST ŹRÓDŁOWY — ${article.title}:
${toPlainText(article.html)}`;

function toPlainText(html) {
  return html
    .replace(/<h3[^>]*>/g, '\n')
    .replace(/<\/h3>/g, ': ')
    .replace(/<li[^>]*>/g, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n +/g, '\n')
    .trim();
}

// Zmierzone na realnym nagraniu (odsluch-2026-09-28): 16,92 znaku na sekundę.
const CHARS_PER_SECOND = 16.9;

function estimate(script) {
  const seconds = script.length / CHARS_PER_SECOND;
  return `${script.length} zn ≈ ${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

export async function writeScript(articles) {
  const total = Math.round((OPTS.scriptCharsMin + OPTS.scriptCharsMax) / 2);
  const budget = Math.round(total / articles.length);
  const parts = [];

  // Sekwencyjnie, bo każdy temat potrzebuje końcówki poprzedniego, żeby zbudować
  // przejście ("z Tallinna wracamy do Polski") zamiast zaczynać od zera.
  for (const [i, article] of articles.entries()) {
    const previous = parts.length ? parts[parts.length - 1].slice(-220) : '';
    // Bez tego model otwiera niemal każde przejście tak samo ("Zostajemy przy…"),
    // a powtarzana formułka przed każdym tematem była pierwszą rzeczą, która
    // raziła w odsłuchu.
    const used = parts.slice(1).map((t) => t.split(/\s+/).slice(0, 2).join(' '));
    const result = await scriptModel.generateContent(TOPIC_PROMPT({
      article,
      budget,
      previous,
      previousTitle: i > 0 ? articles[i - 1].title : '',
      used,
      isFirst: i === 0,
      isLast: i === articles.length - 1,
    }));
    record(config.models.script, result.response, 'scenariusz');
    const text = result.response.text().trim().replace(/\s*\n\s*/g, ' ');
    log.info(`  temat ${i + 1}/${articles.length}: ${text.length} zn (cel ${budget})`);
    parts.push(text);
  }

  // Puste linie między tematami to punkty cięcia dla syntezatora mowy.
  const script = parts.join('\n\n');
  log.info(`Scenariusz: ${estimate(script)}`);
  return script;
}

// Scenariusz leci do release'u obok nagrania — inaczej nie da się sprawdzić,
// czy audycja faktycznie pokryła wszystkie tematy.
function saveScript(script, articles, outputDir, dateStamp) {
  const path = `${outputDir}/odsluch-${dateStamp}.txt`;
  const header = articles.map((a, i) => `${i + 1}. ${a.title}`).join('\n');
  writeFileSync(path, `TEKSTY W TYM WYDANIU\n${header}\n\n${'='.repeat(60)}\n\n${script}\n`);
  return path;
}

// Długiej audycji nie da się wygenerować jednym żądaniem — tniemy na akapitach,
// a gdy akapit sam jest za długi, na granicy zdań. Każde cięcie resetuje
// intonację lektora, więc celujemy w jak najmniejszą liczbę możliwie równych
// fragmentów zamiast pakować je zachłannie pod sam limit.
export function chunkScript(script) {
  const limit = OPTS.maxCharsPerChunk;

  const pieces = [];
  for (const paragraph of script.split(/\n\s*\n/)) {
    if (!paragraph.trim()) continue;
    if (paragraph.length <= limit) {
      pieces.push(paragraph.trim());
      continue;
    }
    const sentences = paragraph.match(new RegExp(`[\\s\\S]{1,${limit}}(?=[.!?]\\s|$)`, 'g'))
      || [paragraph];
    pieces.push(...sentences.map((x) => x.trim()));
  }

  const total = pieces.reduce((sum, p) => sum + p.length, 0);
  const target = Math.ceil(total / Math.ceil(total / limit));

  const chunks = [];
  let current = '';
  for (const piece of pieces) {
    const joined = current ? `${current}\n\n${piece}` : piece;
    if (current && (joined.length > limit || current.length >= target)) {
      chunks.push(current);
      current = piece;
    } else {
      current = joined;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

async function speakChunk(text) {
  const model = config.models.tts;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // ŻADNEJ instrukcji stylu w treści. Model TTS nie przyjmuje
        // systemInstruction, a każda instrukcja doklejona do tekstu — obojętne
        // czy po pustej linii, czy po dwukropku w jednej linii — jest czytana
        // na głos. Zmierzone: ten sam tekst 9,0 s bez instrukcji, 16,4 s z nią.
        // Do wypowiedzi trafia wyłącznie sam tekst audycji.
        contents: [{ parts: [{ text: text.replace(/\s*\n\s*/g, ' ') }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: OPTS.voice } } },
        },
      }),
    }
  );

  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  const inline = json.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inline?.data) throw new Error('brak danych audio w odpowiedzi');

  record(model, json, 'tts');
  return Buffer.from(inline.data, 'base64');
}

function wavHeader(pcmLength) {
  const h = Buffer.alloc(WAV_HEADER);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcmLength, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(BYTES_PER_SEC, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcmLength, 40);
  return h;
}

const WINDOW = SAMPLE_RATE / 100;          // 10 ms
const SPEECH_FLOOR = 600;                  // poniżej tego to cisza
const ARTIFACT_PEAK = 29000;               // mowa szczytuje ~20 000

function windowPeaks(pcm) {
  const count = Math.floor(pcm.length / 2 / WINDOW);
  const peaks = new Int32Array(count);
  for (let w = 0; w < count; w++) {
    let peak = 0;
    for (let i = w * WINDOW; i < (w + 1) * WINDOW; i++) {
      const v = Math.abs(pcm.readInt16LE(i * 2));
      if (v > peak) peak = v;
    }
    peaks[w] = peak;
  }
  return peaks;
}

// Każdy fragment kończy się ~150 ms szumu na pełnej skali — model dorzuca go
// po ostatnim słowie. Bez tego przy każdym sklejeniu słychać trzask.
function trimAndFade(wav) {
  const pcm = Buffer.from(wav.subarray(WAV_HEADER));
  const peaks = windowPeaks(pcm);

  let last = -1;
  let first = -1;
  for (let w = 0; w < peaks.length; w++) {
    const isSpeech = peaks[w] >= SPEECH_FLOOR && peaks[w] < ARTIFACT_PEAK;
    if (!isSpeech) continue;
    if (first === -1) first = w;
    last = w;
  }
  if (first === -1) return pcm;

  const from = Math.max(0, first - 5) * WINDOW;
  const to = Math.min(peaks.length, last + 4) * WINDOW;
  const cut = Buffer.from(pcm.subarray(from * 2, to * 2));

  // Łagodne zbocza 25 ms, żeby sklejenie nie dawało skoku amplitudy.
  const ramp = Math.min(SAMPLE_RATE * 0.025, cut.length / 4);
  for (let i = 0; i < ramp; i++) {
    const g = i / ramp;
    cut.writeInt16LE(Math.round(cut.readInt16LE(i * 2) * g), i * 2);
    const j = cut.length / 2 - 1 - i;
    cut.writeInt16LE(Math.round(cut.readInt16LE(j * 2) * g), j * 2);
  }
  return cut;
}

function concatWav(wavBuffers) {
  const gap = Buffer.alloc(Math.round(SAMPLE_RATE * OPTS.gapSeconds) * 2);
  const parts = [];
  wavBuffers.forEach((wav, i) => {
    if (i > 0) parts.push(gap);
    parts.push(trimAndFade(wav));
  });
  const body = Buffer.concat(parts);
  return Buffer.concat([wavHeader(body.length), body]);
}

function has(binary) {
  try {
    execFileSync(binary, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const AUDIO_MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav' };

// WAV z Gemini to ~2,8 MB na minutę — 10-minutowy odcinek miałby 28 MB.
// ffmpeg jest pierwszym wyborem (CI), afconvert to wbudowany fallback macOS.
function compress(wavPath, outBase) {
  if (has('ffmpeg')) {
    const out = `${outBase}.mp3`;
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', wavPath,
      '-codec:a', 'libmp3lame', '-b:a', `${OPTS.bitrateKbps}k`, '-ac', '1', out,
    ]);
    unlinkSync(wavPath);
    return out;
  }

  try {
    const out = `${outBase}.m4a`;
    execFileSync('afconvert', [
      '-f', 'm4af', '-d', 'aac', '-b', String(OPTS.bitrateKbps * 1000), wavPath, out,
    ], { stdio: 'ignore' });
    log.info('Brak ffmpeg — skompresowano przez afconvert do AAC/m4a');
    unlinkSync(wavPath);
    return out;
  } catch {
    log.warn('Brak ffmpeg i afconvert — zostawiam WAV (kilkukrotnie większy plik)');
    return null;
  }
}

export async function buildAudioDigest(articles, { outputDir, dateStamp }) {
  if (articles.length === 0) return null;

  log.info(`Piszę scenariusz odsłuchu z ${articles.length} tekstów (model: ${config.models.script})...`);
  const script = await writeScript(articles);
  const chunks = chunkScript(script);
  log.info(`Scenariusz: ${script.length} znaków → ${chunks.length} fragmentów do syntezy`);

  const buffers = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const wav = await speakChunk(chunks[i]);
      buffers.push(wav);
      log.info(`  TTS ${i + 1}/${chunks.length} → ${((wav.length - WAV_HEADER) / BYTES_PER_SEC).toFixed(1)} s`);
    } catch (err) {
      log.error(`  TTS ${i + 1}/${chunks.length} nie powiódł się: ${err.message.slice(0, 100)}`);
      return null;
    }
  }

  const wav = concatWav(buffers);
  const durationSec = (wav.length - WAV_HEADER) / BYTES_PER_SEC;

  mkdirSync(outputDir, { recursive: true });
  const scriptPath = saveScript(script, articles, outputDir, dateStamp);
  const wavPath = `${outputDir}/odsluch-${dateStamp}.wav`;
  writeFileSync(wavPath, wav);
  const filePath = compress(wavPath, `${outputDir}/odsluch-${dateStamp}`) || wavPath;
  const bytes = readFileSync(filePath).length;

  log.ok(
    `Odsłuch gotowy: ${Math.floor(durationSec / 60)}:${String(Math.round(durationSec % 60)).padStart(2, '0')} · ` +
    `${(bytes / 1024 / 1024).toFixed(1)} MB → ${filePath}`
  );

  return { script, scriptPath, filePath, fileName: filePath.split('/').pop(), bytes, durationSec };
}

// 1 temat · 2-4 tematy · 5+ tematów (i 12-14 tematów mimo końcówki 2-4)
function tematy(n) {
  if (n === 1) return '1 temat';
  const last = n % 10;
  const teens = n % 100 >= 12 && n % 100 <= 14;
  return `${n} ${!teens && last >= 2 && last <= 4 ? 'tematy' : 'tematów'}`;
}

export function audioEntry(digest, { articles, dateStamp, url }) {
  const mmss = `${Math.floor(digest.durationSec / 60)}:${String(Math.round(digest.durationSec % 60)).padStart(2, '0')}`;
  const list = articles
    .map((a) => `<li style="margin-bottom:0.3em">${a.title}</li>`)
    .join('');

  return {
    guid: `odsluch-${dateStamp}`,
    kind: 'audio',
    title: `ODSŁUCH — ${dateStamp} (${mmss})`,
    link: url || '',
    pubDate: new Date().toISOString(),
    source: 'AI RSS',
    imageUrl: null,
    category: 'odsluch',
    topic: `odsłuch wydania ${dateStamp}`,
    html:
      `<p>Całe dzisiejsze wydanie do odsłuchania — ${tematy(articles.length)}, ${mmss}.</p>` +
      `<h3>W tym odcinku</h3><ul>${list}</ul>`,
    audio: url
      ? { url, type: AUDIO_MIME[digest.fileName.split('.').pop()] || 'audio/mpeg', length: digest.bytes }
      : null,
    durationSec: digest.durationSec,
    sources: [],
    backgroundSources: [],
    publishers: [],
    trustLevel: null,
  };
}
