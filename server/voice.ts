// Speech-to-text for the chat's Push-to-Talk: Deepgram pre-recorded transcription with a Russian poker vocabulary.

/** Deepgram `keyterm` prompts (Nova-3 only, at most 500 tokens in total). */
export const POKER_TERMS = [
  'трибет', 'контбет', 'пот-оддс', 'эквити', 'гатшот', 'ОЕСД', 'натс', 'баттон', 'кат-офф', 'анте', 'олл-ин',
  'префлоп', 'флоп', 'тёрн', 'ривер', 'лимп', 'колл', 'рейз', 'фолд', 'чек', 'блайнды', 'стрит', 'флеш', 'сет', 'кикер',
  'оверпара', 'топ-пара', 'дро', 'ауты', 'баббл', 'пуш', 'фолд-эквити', 'диапазон', 'сайзинг', 'донк-бет', 'сквиз',
  'стек', 'банк', 'шорт-стек', 'хедз-ап', 'ICM', 'фулл-хаус', 'каре', 'оверкарты', 'флеш-дро', 'чек-рейз', 'мультипот',
];

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';
const TIMEOUT_MS = 30_000;

// JS `\b` is ASCII-only, so word edges are Unicode lookarounds: no letter or digit on the outside.
const word = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu');
const NUMBER = '(\\d+(?:[.,]\\d+)?)';
/** What Deepgram splits or spells differently, mapped to one written form Dan reads unambiguously. */
const RULES: [RegExp, string][] = [
  // Fused or hyphenated with any ending ("трибета", "3-бета"); spaced only bare or as a verb, so "3 беты на флопе" (three bets) stays.
  // Endings are listed so "бетон" stays.
  [word('(?:три|3)(?:-?бет(а|у|е|ом|ы|ов|ами|ах|ить|ишь|ит|ил|ила|или)?|\\s+бет(ить|ишь|ит|ил|ила|или)?)'), '3-бет$1$2'],
  [word('(?:четыре|4)(?:-?бет(а|у|е|ом|ы|ов|ами|ах|ить|ишь|ит|ил|ила|или)?|\\s+бет(ить|ишь|ит|ил|ила|или)?)'), '4-бет$1$2'],
  // The first letter is captured to keep its case at the start of a sentence.
  [word('(п)от[\\s-]+од{1,2}с(ы|ов|ам|ах)?'), '$1от-оддс$2'],
  [word('(о)лл?[\\s-]+ин'), '$1лл-ин'],
  [word('(к)ат[\\s-]?оф{1,2}(а|е|у|ом)?'), '$1ат-офф$2'],
  [word('о[\\s-]?е[\\s-]?с[\\s-]?д'), 'OESD'],
  // Only after a number: "40 процентов" → "40%", a bare "процентов" is left alone.
  [word(`${NUMBER}\\s?процент(?:а|ов)?`), '$1%'],
  [word(`${NUMBER}\\s?(?:бб|би[\\s-]?би|больш(?:ой|их|ого) блайнд(?:а|ов)?)`), '$1 BB'],
];

/** Deterministic post-processing of a Deepgram transcript. */
export function normalizeTranscript(text: string): string {
  return RULES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text).trim();
}

/** Transcribes recorded audio; throws on any Deepgram failure (the message carries no credentials). */
export async function transcribe(audio: ArrayBuffer, contentType: string, apiKey: string): Promise<string> {
  const params = new URLSearchParams({ model: 'nova-3', language: 'ru', smart_format: 'true' });
  for (const term of POKER_TERMS) params.append('keyterm', term);
  const res = await fetch(`${DEEPGRAM_URL}?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': contentType },
    body: audio,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Deepgram answered ${res.status}`);
  const body = await res.json() as { results?: { channels?: { alternatives?: { transcript?: unknown }[] }[] } };
  const transcript = body.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (typeof transcript !== 'string') throw new Error('Deepgram answered without a transcript');
  return normalizeTranscript(transcript);
}
