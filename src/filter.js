import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../config.json' with { type: 'json' };
import { log } from './logger.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash-lite' });

export async function filterItems(items) {
  if (items.length === 0) return [];

  log.info(`Wysyłam ${items.length} artykułów do Gemini (filtr)...`);

  const numbered = items.map((item, idx) =>
    `[${idx}] ${item.title}\n${item.description}`
  );

  const prompt = `Jesteś redaktorem poważnego dziennika newsowego. Masz do oceny listę artykułów.

Wybierz dokładnie ${config.maxItemsPerRun} artykułów według poniższych zasad.

OBOWIĄZKOWE PROPORCJE — musisz ich przestrzegać:
- minimum 2 artykuły dotyczące Polski (krajowe decyzje, wydarzenia w Polsce)
- minimum 2 artykuły dotyczące świata (geopolityka, gospodarka globalna, inne kraje)
- pozostałe miejsca: według własnej oceny ważności

ODRZUĆ bezwzględnie:
- clickbait i sensacja bez treści
- lifestyle, zdrowie, dieta, moda
- plotki i życie celebrytów
- wypadki drogowe i lokalne zdarzenia kryminalne (chyba że mają znaczenie ogólnokrajowe)
- wyniki loterii, quizy, rankingi bez znaczenia
- sport (chyba że poważny skandal korupcyjny lub systemowy)
- kłótnie polityków, przepychanki słowne, partyjne przepychanki — interesują nas KONKRETNE zdarzenia i decyzje, nie spory

AKCEPTUJ (w kolejności priorytetu w swojej kategorii):
1. Geopolityka, konflikty zbrojne, ważne decyzje dyplomatyczne
2. Gospodarka: decyzje banków centralnych, recesja, inflacja, duże bankructwa, zmiany systemowe
3. Nauka i technologia: przełomowe odkrycia, AI, klimat
4. Poważne katastrofy z dużą liczbą ofiar — tylko jeśli należą do ważniejszych wydarzeń dnia
5. Polska: ważne decyzje rządu, Sejmu, sądów — konkretne, nie polityczna pyskówka

DEDUPLICATION: jeśli kilka artykułów opisuje to samo wydarzenie, wybierz tylko jeden — z najlepszego, najbardziej wiarygodnego źródła. Nie przepuszczaj dwóch artykułów o tym samym temacie.

Artykuły:
${numbered.join('\n\n')}

Odpowiedz WYŁĄCZNIE tablicą JSON z indeksami wybranych artykułów w kolejności od najważniejszego, np.: [3, 0, 7]
Bez wyjaśnień, bez markdown, tylko tablica JSON.`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim().replace(/```json|```/g, '').trim();
    const indices = JSON.parse(text);
    if (!Array.isArray(indices)) return [];

    const selected = indices
      .filter((idx) => typeof idx === 'number' && idx >= 0 && idx < items.length)
      .slice(0, config.maxItemsPerRun)
      .map((idx) => items[idx]);

    log.ok(`Filtr wybrał ${selected.length} artykułów:`);
    selected.forEach((item, i) => log.info(`  ${i + 1}. ${item.title}`));

    return selected;
  } catch (err) {
    log.error(`Filtr nie powiódł się: ${err.message}`);
    return [];
  }
}
