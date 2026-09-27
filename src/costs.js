import config from '../config.json' with { type: 'json' };
import { log } from './logger.js';

// Ceny za 1M tokenów w USD — zaktualizuj w config.json, jeśli Google je zmieni.
const usage = new Map();

function key(model, stage) {
  return `${stage}|${model}`;
}

export function record(model, response, stage = 'inne') {
  const meta = response?.usageMetadata;
  if (!meta) return;

  const entry = usage.get(key(model, stage)) || { model, stage, calls: 0, input: 0, output: 0 };
  entry.calls += 1;
  entry.input += meta.promptTokenCount || 0;
  entry.output += (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0);
  usage.set(key(model, stage), entry);
}

function grOf(entry) {
  const price = config.pricing?.[entry.model];
  if (!price) return null;
  const usd = (entry.input / 1e6) * price.inputUsdPerMTok
    + (entry.output / 1e6) * price.outputUsdPerMTok;
  return usd * config.usdPlnRate * 100;
}

export function reportCosts(articleCount = 0) {
  if (usage.size === 0) return;

  let totalGr = 0;
  log.phase('Koszty');

  const rows = [...usage.values()].sort((a, b) => (grOf(b) ?? 0) - (grOf(a) ?? 0));

  for (const entry of rows) {
    const gr = grOf(entry);
    if (gr === null) {
      log.warn(`${entry.stage}/${entry.model}: brak cennika w config.json`);
      continue;
    }
    totalGr += gr;
    log.info(
      `${entry.stage.padEnd(11)} ${entry.model.padEnd(23)} ` +
      `${entry.calls}× · ${entry.input} in / ${entry.output} out → ${gr.toFixed(2)} gr`
    );
  }

  // Skalowanie do pełnego przebiegu: etapy per-artykuł rosną z liczbą tekstów,
  // filtr i embeddingi są stałe niezależnie od --limit.
  const perArticleGr = rows
    .filter((e) => PER_ARTICLE_STAGES.has(e.stage))
    .reduce((sum, e) => sum + (grOf(e) ?? 0), 0);
  const fixedGr = totalGr - perArticleGr;
  const projectedGr = articleCount > 0
    ? fixedGr + (perArticleGr / articleCount) * config.maxItemsPerRun
    : totalGr;

  log.ok(`Razem: ${totalGr.toFixed(2)} gr (${(totalGr / config.usdPlnRate / 100).toFixed(4)} USD)`);
  log.ok(
    `Prognoza pełnego przebiegu (${config.maxItemsPerRun} tekstów): ` +
    `${projectedGr.toFixed(2)} gr/dobę · ~${(projectedGr * 30 / 100).toFixed(2)} zł/mies.`
  );

  const monthly = projectedGr * 30 / 100;
  const budget = config.monthlyBudgetPln;
  if (budget && monthly > budget) {
    log.warn(`Przekroczony budżet: ${monthly.toFixed(2)} zł > ${budget} zł/mies.`);
  }
}

// Etapy, których koszt rośnie z liczbą tekstów — scenariusz i TTS też,
// bo audycja jest proporcjonalnie dłuższa.
const PER_ARTICLE_STAGES = new Set(['fakty', 'twierdzenia', 'tlo', 'scenariusz', 'tts']);
