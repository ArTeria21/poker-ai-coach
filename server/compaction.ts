import { getToolName, isToolUIPart, type UIMessage } from 'ai';
import { TRIGGER_PREFIX } from '../src/agent/training';

/**
 * Dialog compaction, a Russian port of learnharness `src/core/compaction.ts` (`serializeForSummary`, `buildCompactionPrompt`).
 * The client folds the older part of its chat into a summary that Dan reads INSTEAD of those messages.
 */

/** The summary only needs a tool call's gist; the kept tail carries recent results whole. Clipped separately so the result is never cut off by a long input. */
const TOOL_INPUT_TRUNCATE = 150;
const TOOL_RESULT_TRUNCATE = 300;

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…[урезано]` : text;

/** The span as labelled plain text; reasoning and unfinished tool calls are skipped. */
export function serializeSpan(messages: UIMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    for (const part of m.parts) {
      if (part.type === 'text') {
        if (m.role === 'assistant') lines.push(`[ДЭН] ${part.text}`);
        else if (!part.text.startsWith(TRIGGER_PREFIX)) lines.push(`[ИГРОК] ${part.text}`);
        else {
          const gateId = (m.metadata as { gateId?: unknown } | undefined)?.gateId;
          lines.push(`[СОБЫТИЕ${typeof gateId === 'string' ? ` гейт ${gateId.slice(0, 120)}` : ''}] ${part.text}`);
        }
      } else if (isToolUIPart(part)) {
        const result = part.state === 'output-available' ? JSON.stringify(part.output) : part.state === 'output-error' ? `ошибка: ${part.errorText}` : null;
        if (result !== null) lines.push(`[ТУЛ ${getToolName(part)} ${clip(JSON.stringify(part.input), TOOL_INPUT_TRUNCATE)} → ${clip(result, TOOL_RESULT_TRUNCATE)}]`);
      }
    }
  }
  return lines.join('\n\n');
}

export const COMPACTION_INSTRUCTIONS = `Ты сжимаешь раннюю часть тренерской сессии по турнирному покеру (6-max SNG) — пишешь сводку, которую тренер Дэн прочтёт ВМЕСТО этой части переписки. Всё до точки среза заменяется твоим текстом, всё после неё остаётся дословно. В транскрипте: [ИГРОК] — ученик, [ДЭН] — тренер, [СОБЫТИЕ] — автоматические сообщения режима тренировки (ход игрока, конец раздачи), [ТУЛ имя ввод → результат] — вызовы инструментов (урезаны).

Если дана предыдущая сводка, она описывает ещё более раннюю часть сессии. ОБЪЕДИНИ её с транскриптом в одну сводку: перепиши каждый раздел целиком с учётом нового, а не дописывай новое в конец; не теряй из неё то, что ещё важно; закрытые вопросы и исправленные позже заблуждения обнови.

Пиши сводку ровно с такими разделами в этом порядке:

## Понимание игрока и его эволюция
Самая подробная картина того, что игрок понимает и как это менялось за сессию: какие решения он принимал в раздачах и как их обосновывал, насколько самостоятельно он пришёл к каждому верному решению (сам, до подсказок / после наводящих вопросов / только после объяснения Дэна), качество рассуждений, ошибки, заявленная или проявленная уверенность, какие заблуждения всплыли, какие исправлены, а какие ещё держатся. Этот раздел весит больше всего: на нём держатся дальнейшие решения тренера.

## Ход сессии
Как шла сессия: какие раздачи и темы разбирались и в каком порядке, о чём договорились (формулы, термины, правила счёта, план), какие объяснения дошли, а какие нет, как реагировал игрок.

## Текущий момент
Что происходит ПРЯМО СЕЙЧАС на точке среза: вопрос или решение, которое ждёт ответа игрока (открытый гейт тренировки — с его id), обязательства тренера, которые следующий ход должен выполнить (согласованный план и т. п.), и ближайший следующий шаг.

Правила: без похвалы и воды, без домыслов сверх транскрипта. Каждое утверждение об игроке должно опираться на то, что он действительно сказал или сделал. Идентификаторы (id раздач вида ...-hand-N, id гейтов вида ...#N и ...#review, названия тем) сохраняй точно. Пиши по-русски простым текстом: заголовки разделов «## …», списки «- », не длиннее 3000 знаков. Старое сжимай сильнее (закрытые раздачи — до вывода в одну строку), текущее и нерешённое описывай подробнее. Ответь только сводкой.`;

/** The data half of the prompt: the previous summary to merge and the span to fold, both fenced. */
export function compactionPrompt(previous: string | null, spanText: string): string {
  const before = previous
    ? `Предыдущая сводка (ещё более ранняя часть сессии), объедини её с транскриптом:\n<previous-summary>\n${previous}\n</previous-summary>`
    : 'Предыдущей сводки нет: это первое сжатие сессии.';
  return `${before}\n\nТранскрипт для сжатия:\n<transcript>\n${spanText}\n</transcript>`;
}
