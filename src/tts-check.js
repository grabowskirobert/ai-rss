// Próba darmowego lektora przed włączeniem go na produkcji: czy klucz ma
// dostęp do Cloud Text-to-Speech, czy skonfigurowane głosy istnieją i czy
// pełny artykuł przechodzi przez syntezę bez cichego powrotu do płatnego
// Gemini. Uruchamiane z workflow (tts_check) albo lokalnie:
//   node --env-file-if-exists=.env src/tts-check.js
import { readFileSync } from 'fs';
import config from '../config.json' with { type: 'json' };
import { log } from './logger.js';
import { reportCosts } from './costs.js';
import { CLOUD_VOICES, buildAudioDigest, cloudCharsThisMonth, speakCloud } from './audio.js';

const OUT = process.env.TTS_CHECK_DIR || '/tmp/tts-check';
const key = process.env.GOOGLE_TTS_API_KEY || process.env.GEMINI_API_KEY;

function fail(msg) {
  log.error(msg);
  process.exit(1);
}

if (!key) fail('Brak GOOGLE_TTS_API_KEY i GEMINI_API_KEY');
log.phase(`Próba Cloud TTS (klucz z ${process.env.GOOGLE_TTS_API_KEY ? 'GOOGLE_TTS_API_KEY' : 'GEMINI_API_KEY'})`);

// 1. Dostęp i lista głosów — bez kosztu, nie zużywa limitu znaków.
const res = await fetch(`https://texttospeech.googleapis.com/v1/voices?languageCode=pl-PL&key=${key}`);
const json = await res.json();
if (json.error) fail(`Lista głosów: ${json.error.status} — ${json.error.message}`);
const names = (json.voices || []).map((v) => v.name);
log.info(`Polskie głosy Chirp 3 HD: ${names.filter((n) => n.includes('Chirp3')).join(', ') || 'brak'}`);
log.info(`Polskie głosy WaveNet: ${names.filter((n) => n.includes('Wavenet')).join(', ') || 'brak'}`);
for (const v of Object.values(CLOUD_VOICES)) {
  if (!names.includes(v.voice())) fail(`Głos ${v.voice()} z config.json nie istnieje`);
  log.ok(`${v.voice()} dostępny · zużyte w tym miesiącu wg rejestru: ${cloudCharsThisMonth(v.model)} z ${v.freeChars} zn`);
}

// 2. Krótka synteza — tani test, zanim pójdzie cały artykuł.
const sample = 'Dzień dobry. To jest próba polskiego lektora: zażółć gęślą jaźń.';
try {
  const wav = await speakCloud(sample, { model: CLOUD_VOICES.chirp.model, voice: CLOUD_VOICES.chirp.voice() });
  log.ok(`Krótka próba: ${sample.length} zn → ${((wav.length - 44) / 48000).toFixed(1)} s`);
} catch (err) {
  fail(`Krótka próba nie powiodła się: ${err.message}`);
}

// 3. Pełny artykuł z archiwum — ta sama ścieżka co nocny przebieg.
const archive = JSON.parse(readFileSync('archive.json', 'utf8'));
const article = (archive.items || archive).find((a) => a.kind !== 'audio');
log.info(`Pełny artykuł: ${article.title}`);
const digest = await buildAudioDigest([article], { outputDir: OUT, dateStamp: 'tts-check' });
reportCosts(1, { dryRun: true });
if (!digest) fail('Odsłuch nie powstał');
if (digest.engine === 'gemini') fail('Synteza poszła przez płatne Gemini zamiast Cloud TTS');
log.done(`Działa: ${digest.engine} · ${digest.durationSec.toFixed(0)} s · ${digest.filePath} (silnik w config: ${config.audio.engine})`);
