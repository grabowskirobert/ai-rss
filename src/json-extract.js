// Modele potrafią dopisać tekst przed lub po JSON-ie (komentarz, drugi blok,
// powtórzoną tablicę). Wycinamy pierwszą zbalansowaną strukturę zaczynającą
// się od `open`, z uwzględnieniem nawiasów wewnątrz stringów.
export function extractJson(text, open = '[') {
  const close = open === '[' ? ']' : '}';
  const s = String(text).replace(/```(?:json)?/g, '');
  let start = s.indexOf(open);
  while (start !== -1) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        depth--;
        if (depth === 0) {
          if (c !== close) break;
          try {
            return JSON.parse(s.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
    start = s.indexOf(open, start + 1);
  }
  throw new Error(`Brak poprawnego JSON-a (${open}…${close}) w odpowiedzi modelu`);
}
