import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { convertToModelMessages, generateText, isStepCount, safeValidateUIMessages, streamText, type StopCondition, type ToolSet, type UIMessage } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import { coachSnapshotSchema, DIAGNOSIS_PREFIX, MAX_UNFOLDED_MESSAGES, SUMMARY_MAX_CHARS, type CoachSnapshot } from '../src/agent/contract';
import { decisionGateId, reviewGateId, type GateKind, type Mode, type RequestGate } from '../src/agent/training';
import { COMPACTION_INSTRUCTIONS, compactionPrompt, serializeSpan } from './compaction';
import { danInstructions } from './dan';
import { memoryInitialized, readInjectedMemory, readMemoryOverview } from './memory';
import { diagnosisTools, memoryTools, releaseActions, tools } from './tools';
import { transcribe } from './voice';

const MAX_BODY_BYTES = 1024 * 1024;
// About two minutes of Opus speech, the client's auto-stop, with room for Safari's AAC.
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const MAX_STEPS = 8;
// Default reasoning delays the first token ~50 s; low keeps answer quality at ~17 s. Some models reject 'none'.
const REASONING = { effort: 'low' } as const;

// Defaults keep a client that predates Training Mode working as Free Play.
const modeSchema = z.object({
  mode: z.enum(['free', 'training'] as const satisfies readonly Mode[]).default('free'),
  gate: z.object({ id: z.string().min(1).max(120), kind: z.enum(['decision', 'review'] as const satisfies readonly GateKind[]) }).nullable().default(null),
  // The level diagnosis runs as a chat phase on top of the mode; absent = normal chat.
  phase: z.literal('diagnosis').nullable().default(null),
});
// History may hold release_actions calls from earlier gates and diagnosis questions even when this request gets no such tool; these schemas do not depend on the hand.
// The diagnosis question outputs are the client's answer records, validated here by their output schemas.
const historyTools = { ...tools, ...memoryTools(null), ...diagnosisTools(null, false), release_actions: { inputSchema: z.object({}) } };
const summarySchema = z.string().trim().min(1).max(SUMMARY_MAX_CHARS).nullable().default(null);

/** The chat history at the trust boundary, shared by /api/chat and /api/compact. */
async function parseMessages(raw: unknown): Promise<{ messages: UIMessage[] } | { error: string }> {
  const validated = await safeValidateUIMessages({ messages: raw, tools: historyTools });
  if (!validated.success) return { error: `Invalid messages: ${validated.error.message.slice(0, 200)}` };
  const messages = validated.data;
  // Only the server sets system instructions.
  if (messages.some((m) => m.role === 'system')) return { error: 'System messages are not allowed' };
  // File parts would make the server fetch client-supplied URLs.
  if (messages.some((m) => m.parts.some((p) => p.type === 'file' || p.type === 'reasoning-file'))) return { error: 'File parts are not allowed' };
  return { messages };
}

const configured = () => {
  const { OPENROUTER_API_KEY: apiKey, OPENROUTER_MODEL: modelId } = process.env;
  return apiKey && modelId ? { model: createOpenRouter({ apiKey })(modelId) } : null;
};
const NOT_CONFIGURED = { error: 'Coach is not configured: set OPENROUTER_API_KEY and OPENROUTER_MODEL' };
const limitBody = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'Request body too large' }, 413) });

/** True when a diagnosis_done already succeeded after the latest diagnosis start. Safe on the folded tail: folding drops a prefix, so a missing start means everything before it is gone too. */
function diagnosisConcluded(messages: UIMessage[]): boolean {
  const start = messages.map((m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text.startsWith(DIAGNOSIS_PREFIX))).lastIndexOf(true);
  return messages.slice(start + 1).some((m) => m.parts.some((p) =>
    p.type === 'tool-diagnosis_done' && p.state === 'output-available' && typeof p.output === 'object' && p.output !== null && 'saved' in p.output));
}

/** Why the gate is not the one on the table in the snapshot, or null when it is. */
function gateMismatch(gate: RequestGate, snapshot: CoachSnapshot | null): string | null {
  if (!snapshot) return 'gate without a table';
  if (gate.kind === 'decision') {
    if (snapshot.status !== 'heroToAct') return 'decision gate but the hero is not to act';
    return gate.id === decisionGateId(snapshot.handId, snapshot.history.length) ? null : 'decision gate does not match the snapshot';
  }
  if (snapshot.status !== 'handComplete' && snapshot.status !== 'tournamentComplete') return 'review gate but the hand is not complete';
  return gate.id === reviewGateId(snapshot.handId) ? null : 'review gate does not match the snapshot';
}

/**
 * Ends the turn at a successful release_actions (always Dan's last call) once he has written an answer: a further step would only
 * add filler while the next trigger waits. A failed call in the step (unknown tool, bad input, a tool's `{ error }`) gets a next step to react.
 */
const releasedWithAnswer: StopCondition<ToolSet> = ({ steps }) => {
  const last = steps.at(-1)!.content;
  const failed = last.some((p) => p.type === 'tool-error'
    || (p.type === 'tool-result' && typeof p.output === 'object' && p.output !== null && 'error' in p.output));
  return !failed && last.some((p) => p.type === 'tool-result' && p.toolName === 'release_actions') && steps.some((s) => s.text.trim() !== '');
};

/** Logs without request bodies or headers, which may carry the conversation or credentials. */
const logError = (where: string, error: unknown) =>
  console.error(`[${where}]`, error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export const app = new Hono();

app.post(
  '/api/chat',
  limitBody,
  async (c) => {
    const coach = configured();
    if (!coach) return c.json(NOT_CONFIGURED, 503);

    const body = await c.req.json().catch(() => null) as { messages?: unknown; snapshot?: unknown; mode?: unknown; gate?: unknown; phase?: unknown; summary?: unknown } | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'Body must be JSON' }, 400);
    const snapshot = coachSnapshotSchema.nullable().safeParse(body.snapshot ?? null);
    if (!snapshot.success) return c.json({ error: `Invalid snapshot: ${snapshot.error.issues[0]?.path.join('.')} ${snapshot.error.issues[0]?.message}` }, 400);
    const training = modeSchema.safeParse({ mode: body.mode, gate: body.gate, phase: body.phase });
    if (!training.success) return c.json({ error: `Invalid mode, gate or phase: ${training.error.issues[0]?.path.join('.')} ${training.error.issues[0]?.message}` }, 400);
    const { mode, gate, phase } = training.data;
    if (mode === 'free' && gate) return c.json({ error: 'Free Play requests carry no gate' }, 400);
    if (phase && gate) return c.json({ error: 'Diagnosis requests carry no gate' }, 400);
    const mismatch = gate && gateMismatch(gate, snapshot.data);
    if (mismatch) return c.json({ error: `Invalid gate: ${mismatch}` }, 400);
    const summary = summarySchema.safeParse(body.summary);
    if (!summary.success) return c.json({ error: `Invalid summary: ${summary.error.issues[0]?.message}` }, 400);
    const parsed = await parseMessages(body.messages);
    if ('error' in parsed) return c.json(parsed, 400);
    // The client sends only the unfolded messages; the cap bounds the prompt if its folding keeps failing.
    const recent = parsed.messages.slice(-MAX_UNFOLDED_MESSAGES);
    const firstUser = recent.findIndex((m) => m.role === 'user');
    if (firstUser < 0) return c.json({ error: 'No user message' }, 400);
    // A stopped turn can leave a tool call without a result; skip it instead of failing every later request.
    const modelMessages = await convertToModelMessages(recent.slice(firstUser), { tools: historyTools, ignoreIncompleteToolCalls: true }).catch(() => null);
    if (!modelMessages) return c.json({ error: 'Invalid messages: cannot convert' }, 400);

    const memory = await readInjectedMemory();
    const handId = snapshot.data?.handId ?? null;
    // The diagnosis gets the question tools and diagnosis_done instead of the memory tools; only a gated training request can unlock anything, and only its own gate.
    const requestTools = phase ? { ...tools, ...diagnosisTools(handId, diagnosisConcluded(parsed.messages)) }
      : gate ? { ...tools, ...memoryTools(handId), release_actions: releaseActions(gate) }
      : { ...tools, ...memoryTools(handId) };
    const result = streamText({
      model: coach.model,
      instructions: danInstructions(snapshot.data, phase ?? mode, gate, memory, summary.data),
      messages: modelMessages,
      tools: requestTools,
      stopWhen: [isStepCount(MAX_STEPS), releasedWithAnswer],
      // The last allowed step must answer in text, not end the turn on another tool call.
      // shortcut: this also blocks release_actions after 7 tool steps (the table stays locked until the next turn), allow it on the last step if that happens in practice.
      prepareStep: ({ stepNumber }) => stepNumber === MAX_STEPS - 1 ? { toolChoice: 'none' } : undefined,
      providerOptions: { openrouter: { reasoning: REASONING } },
      abortSignal: c.req.raw.signal,
      onError: ({ error }) => logError('chat stream', error),
    });
    return result.toUIMessageStreamResponse({
      onError: () => 'Coach could not answer right now. Please try again.',
      redactToolErrors: false,
      // The UI only shows a thinking indicator; reasoning text would bloat the history the client resends.
      sendReasoning: false,
    });
  },
);

// Folds the older part of the client's chat into the session summary (merging the previous one); the server keeps no state.
app.post('/api/compact', limitBody, async (c) => {
  const coach = configured();
  if (!coach) return c.json(NOT_CONFIGURED, 503);
  const body = await c.req.json().catch(() => null) as { messages?: unknown; summary?: unknown } | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'Body must be JSON' }, 400);
  const previous = summarySchema.safeParse(body.summary);
  if (!previous.success) return c.json({ error: `Invalid summary: ${previous.error.issues[0]?.message}` }, 400);
  const parsed = await parseMessages(body.messages);
  if ('error' in parsed) return c.json(parsed, 400);
  try {
    const result = await generateText({
      model: coach.model,
      instructions: COMPACTION_INSTRUCTIONS,
      prompt: compactionPrompt(previous.data, serializeSpan(parsed.messages)),
      providerOptions: { openrouter: { reasoning: REASONING } },
      abortSignal: c.req.raw.signal,
    });
    const summary = result.text.trim();
    // A cut-off or oversized summary would lose the current moment at its end: fail, the client retries at its next settle.
    if (result.finishReason !== 'stop' || !summary || summary.length > SUMMARY_MAX_CHARS) {
      logError('compact', `unusable summary: finish ${result.finishReason}, ${summary.length} chars`);
      return c.json({ error: 'Could not summarize the conversation' }, 502);
    }
    return c.json({ summary });
  } catch (error) {
    logError('compact', error);
    return c.json({ error: 'Could not summarize the conversation' }, 502);
  }
});

// Push-to-Talk: the body is the raw recording; the key stays on the server.
app.post(
  '/api/stt',
  bodyLimit({ maxSize: MAX_AUDIO_BYTES, onError: (c) => c.json({ error: 'Recording too large' }, 413) }),
  async (c) => {
    const contentType = c.req.header('content-type') ?? '';
    if (!/^audio\//i.test(contentType)) return c.json({ error: 'Body must be audio/*' }, 415);
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) return c.json({ error: 'Voice input is not configured: set DEEPGRAM_API_KEY' }, 503);
    const audio = await c.req.arrayBuffer();
    if (audio.byteLength === 0) return c.json({ error: 'Empty recording' }, 400);
    try {
      return c.json({ text: await transcribe(audio, contentType, apiKey) });
    } catch (error) {
      logError('stt', error);
      return c.json({ error: 'Speech recognition failed' }, 502);
    }
  },
);

app.get('/api/memory/status', async (c) => c.json({ initialized: await memoryInitialized() }));
app.get('/api/memory', async (c) => c.json(await readMemoryOverview()));

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
