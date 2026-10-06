import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import config from '../config.json' with { type: 'json' };
import { log } from './logger.js';
import { record } from './costs.js';

const OPTS = config.audio;

// Gemini TTS zwraca WAV 24 kHz mono 16-bit; rozliczenie to stałe ~32 tokeny
// na sekundę nagrania, niezależnie od modelu i proszonego tempa (zmierzone).
const SAMPLE_RATE = 24000;
const BYTES_PER_SEC = SAMPLE_RATE * 2;
const WAV_HEADER = 44;

// Odsłuch to dosłowne czytanie artykułów: tytuł i treść sekcji, bez nagłówków
// sekcji. Źródła nie siedzą w article.html (feed dokleja je osobno), więc tu
// ich nie ma. Bez etapu przepisywania przez model — lektor czyta to, co jest
// w feedzie.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

// Punktor bez kropki na końcu zlewa się lektorowi z następnym w jedno zdanie.
function sentence(text) {
  const t = decode(text.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return /[.!?…:;]$/.test(t) ? t : `${t}.`;
}

export function articleToSpeech(article) {
  const body = article.html
    .replace(/<h3[^>]*>[\s\S]*?<\/h3>/gi, '')
    .split(/<\/?(?:p|li|ul|ol|br)[^>]*>/i)
    .map(sentence)
    .filter(Boolean);
  return [sentence(article.title), ...body].join(' ');
}

// Zmierzone na realnym nagraniu (odsluch-2026-09-28): 16,92 znaku na sekundę.
const CHARS_PER_SECOND = 16.9;

function estimate(script) {
  const seconds = script.length / CHARS_PER_SECOND;
  return `${script.length} zn ≈ ${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

// Czytany tekst leci do release'u obok nagrania — do porównania z odsłuchem.
function saveScript(topics, articles, outputDir, dateStamp) {
  const path = `${outputDir}/odsluch-${dateStamp}.txt`;
  const header = articles.map((a, i) => `${i + 1}. ${a.title}`).join('\n');
  writeFileSync(path, `TEKSTY W TYM WYDANIU\n${header}\n\n${'='.repeat(60)}\n\n${topics.join('\n\n')}\n`);
  return path;
}

// Każdy temat syntezujemy osobno: cięcie na granicy tematów i tak jest
// pożądane (pauza, nowa intonacja), a w środku tematu go unikamy. Tylko temat
// dłuższy niż limit dzielimy na granicy zdań — na możliwie równe fragmenty,
// bo każde cięcie resetuje intonację lektora.
export function chunkTopic(text) {
  const limit = OPTS.maxCharsPerChunk;
  if (text.length <= limit) return [text];

  const sentences = text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [text];
  const target = Math.ceil(text.length / Math.ceil(text.length / limit));

  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    const joined = current + sentence;
    if (current && (joined.length > limit || current.length >= target)) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = joined;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function speakGemini(text) {
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

// Cloud Text-to-Speech (głosy Chirp 3 HD) ma miesięczny darmowy limit znaków,
// a audycja zużywa go z dużym zapasem — w przeciwieństwie do Gemini TTS, które
// jest rozliczane za każdą sekundę nagrania. Limit żądania to 5000 BAJTÓW,
// a polskie znaki diakrytyczne mają po dwa, stąd maxCharsPerChunk z zapasem.
// Cennik (cloud.google.com/text-to-speech/pricing, sprawdzony 2026-10-06):
// Chirp 3 HD — 1 mln znaków/mies. za darmo, potem 30 USD/1 mln; WaveNet —
// 4 mln za darmo, potem 4 USD/1 mln. Limity liczą się per konto
// rozliczeniowe i obejmują też próby i lokalne przebiegi. Odsłuch to ~26 tys.
// znaków dziennie (~780 tys./mies.), więc Chirp mieści się z niewielkim
// zapasem — gdy limit się kończy, reszta miesiąca idzie głosem WaveNet,
// który ma osobny, czterokrotnie większy limit.
export const CLOUD_VOICES = {
  chirp: { model: 'cloud-tts-chirp3-hd', voice: () => OPTS.cloudVoice, freeChars: 1_000_000 },
  wavenet: { model: 'cloud-tts-wavenet', voice: () => OPTS.cloudOverflowVoice, freeChars: 4_000_000 },
};

const LEDGER = 'costs.jsonl';

// Ile znaków danego modelu zeszło w bieżącym miesiącu — z rejestru kosztów,
// bo API nie podaje stanu darmowego limitu.
export function cloudCharsThisMonth(model, ledger = LEDGER) {
  if (!existsSync(ledger)) return 0;
  const month = new Date().toISOString().slice(0, 7);
  let sum = 0;
  for (const line of readFileSync(ledger, 'utf8').split('\n')) {
    if (!line.includes(model)) continue;
    try {
      const e = JSON.parse(line);
      if (!e.date?.startsWith(month)) continue;
      for (const st of e.stages || []) if (st.model === model) sum += st.input;
    } catch { /* uszkodzona linia rejestru nie blokuje odsłuchu */ }
  }
  return sum;
}

// Zapas na przebiegi, które nie trafią do rejestru (np. przerwane w połowie).
const FREE_MARGIN = 0.95;

export function pickCloudVoice(chars) {
  for (const v of Object.values(CLOUD_VOICES)) {
    const used = cloudCharsThisMonth(v.model);
    if (used + chars <= v.freeChars * FREE_MARGIN) return { ...v, used };
  }
  return null;
}

export async function speakCloud(text, { model, voice }) {
  const key = process.env.GOOGLE_TTS_API_KEY || process.env.GEMINI_API_KEY;
  const input = text.replace(/\s*\n\s*/g, ' ');
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text: input },
      voice: { languageCode: voice.slice(0, 5), name: voice },
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: SAMPLE_RATE },
    }),
  });

  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  if (!json.audioContent) throw new Error('brak danych audio w odpowiedzi');

  // Rozliczenie jest w znakach, nie w tokenach — rejestr kosztów dostaje je
  // jako "input"; z tej liczby liczony jest stan darmowego limitu.
  record(model, { usageMetadata: { promptTokenCount: input.length } }, 'tts');

  // LINEAR16 przychodzi jako WAV z nagłówkiem, którego długość nie jest
  // gwarantowana — wyciągamy sam blok "data" i składamy nagłówek po swojemu,
  // żeby dalsza obróbka mogła zakładać stałe 44 bajty jak przy Gemini.
  const wav = Buffer.from(json.audioContent, 'base64');
  const at = wav.indexOf('data', 12, 'ascii');
  const pcm = at === -1 ? wav : wav.subarray(at + 8, at + 8 + wav.readUInt32LE(at + 4));
  return Buffer.concat([wavHeader(pcm.length), pcm]);
}

export async function synthesize(chunked, speak, label) {
  const count = chunked.flat().length;
  const topics = [];
  let n = 0;
  for (const chunks of chunked) {
    const wavs = [];
    for (const chunk of chunks) {
      n += 1;
      const wav = await speak(chunk);
      wavs.push(wav);
      log.info(`  TTS ${label} ${n}/${count} → ${((wav.length - WAV_HEADER) / BYTES_PER_SEC).toFixed(1)} s`);
    }
    topics.push(wavs);
  }
  return topics;
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

// Krótka cisza między fragmentami jednego tematu, długa między tematami —
// bez niej w odsłuchu trudno złapać, gdzie kończy się jeden temat, a zaczyna
// drugi. Cisza jest doklejana lokalnie, więc nie kosztuje nic w TTS.
function silence(seconds) {
  return Buffer.alloc(Math.round(SAMPLE_RATE * seconds) * 2);
}

function concatWav(topics) {
  const parts = [];
  topics.forEach((wavs, t) => {
    if (t > 0) parts.push(silence(OPTS.topicGapSeconds));
    wavs.forEach((wav, i) => {
      if (i > 0) parts.push(silence(OPTS.gapSeconds));
      parts.push(trimAndFade(wav));
    });
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

  const topics = articles.map(articleToSpeech);
  log.info(`Odsłuch z ${articles.length} tekstów: ${estimate(topics.join(' '))}`);
  const chunked = topics.map(chunkTopic);
  const count = chunked.flat().length;
  const chars = topics.reduce((sum, t) => sum + t.length, 0);
  log.info(`Tekst: ${chars} znaków → ${count} fragmentów do syntezy`);

  // Darmowy lektor może odmówić (wyłączone API, klucz bez uprawnień) albo
  // oba darmowe limity mogą być wyczerpane — wtedy całe nagranie powstaje
  // płatnym Gemini, żeby w jednej audycji nie mieszać głosów.
  let buffers = null;
  let engineUsed = 'gemini';
  if ((OPTS.engine || 'gemini') === 'cloud') {
    const pick = pickCloudVoice(chars);
    if (!pick) {
      log.warn('  Darmowe limity Cloud TTS w tym miesiącu wyczerpane');
    } else {
      const voice = pick.voice();
      log.info(`  Cloud TTS: ${voice} · zużyte w tym miesiącu ${pick.used} + ${chars} z ${pick.freeChars} zn darmowych`);
      try {
        buffers = await synthesize(chunked, (t) => speakCloud(t, { model: pick.model, voice }), voice);
        engineUsed = voice;
      } catch (err) {
        log.error(`  Cloud TTS nie powiódł się: ${err.message.slice(0, 160)}`);
      }
    }
    if (!buffers) log.warn('  Przełączam odsłuch na Gemini TTS');
  }
  if (!buffers) {
    try {
      buffers = await synthesize(chunked, speakGemini, 'gemini');
    } catch (err) {
      log.error(`  TTS gemini nie powiódł się: ${err.message.slice(0, 160)}`);
      return null;
    }
  }

  const wav = concatWav(buffers);
  const durationSec = (wav.length - WAV_HEADER) / BYTES_PER_SEC;

  mkdirSync(outputDir, { recursive: true });
  const scriptPath = saveScript(topics, articles, outputDir, dateStamp);
  const wavPath = `${outputDir}/odsluch-${dateStamp}.wav`;
  writeFileSync(wavPath, wav);
  const filePath = compress(wavPath, `${outputDir}/odsluch-${dateStamp}`) || wavPath;
  const bytes = readFileSync(filePath).length;

  log.ok(
    `Odsłuch gotowy: ${Math.floor(durationSec / 60)}:${String(Math.round(durationSec % 60)).padStart(2, '0')} · ` +
    `${(bytes / 1024 / 1024).toFixed(1)} MB → ${filePath}`
  );

  return { engine: engineUsed, script: topics.join('\n\n'), scriptPath, filePath, fileName: filePath.split('/').pop(), bytes, durationSec };
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
