import config from '../config.json' with { type: 'json' };
import { log } from './logger.js';

// Ceny za 1M tokenów w USD — zaktualizuj w config.json, jeśli Google je zmieni.
const usage = new Map();

export function record(model, response) {
  const meta = response?.usageMetadata;
  if (!meta) return;

  const entry = usage.get(model) || { calls: 0, input: 0, output: 0 };
  entry.calls += 1;
  entry.input += meta.promptTokenCount || 0;
  entry.output += (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0);
  usage.set(model, entry);
}

export function reportCosts() {
  if (usage.size === 0) return;

  let totalUsd = 0;
  log.phase('Koszty');

  for (const [model, entry] of usage) {
    const price = config.pricing?.[model];
    if (!price) {
      log.warn(`${model}: ${entry.calls} zapytań, ${entry.input} in / ${entry.output} out — brak cennika w config.json`);
      continue;
    }
    const usd = (entry.input / 1e6) * price.inputUsdPerMTok
      + (entry.output / 1e6) * price.outputUsdPerMTok;
    totalUsd += usd;
    log.info(
      `${model}: ${entry.calls} zapytań, ${entry.input} in / ${entry.output} out → ` +
      `${(usd * config.usdPlnRate * 100).toFixed(2)} gr`
    );
  }

  const gr = totalUsd * config.usdPlnRate * 100;
  log.ok(`Razem: ${gr.toFixed(2)} gr (${totalUsd.toFixed(4)} USD) · ~${(gr * 30 / 100).toFixed(2)} zł/mies.`);
}
