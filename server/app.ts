import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { convertToModelMessages, isStepCount, safeValidateUIMessages, streamText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import { coachSnapshotSchema, WINDOW_MESSAGES, type CoachSnapshot } from '../src/agent/contract';
import { decisionGateId, reviewGateId, type GateKind, type Mode, type RequestGate } from '../src/agent/training';
import { danInstructions } from './dan';
import { releaseActions, tools } from './tools';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_STEPS = 8;
// Default reasoning delays the first token ~50 s; low keeps answer quality at ~17 s. Some models reject 'none'.
const REASONING = { effort: 'low' } as const;

// Defaults keep a client that predates Training Mode working as Free Play.
const modeSchema = z.object({
  mode: z.enum(['free', 'training'] as const satisfies readonly Mode[]).default('free'),
  gate: z.object({ id: z.string().min(1).max(120), kind: z.enum(['decision', 'review'] as const satisfies readonly GateKind[]) }).nullable().default(null),
});
// History may hold release_actions calls from earlier gates even when this request gets no such tool.
const historyTools = { ...tools, release_actions: { inputSchema: z.object({}) } };

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

/** Logs without request bodies or headers, which may carry the conversation or credentials. */
const logError = (where: string, error: unknown) =>
  console.error(`[${where}]`, error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export const app = new Hono();

app.post(
  '/api/chat',
  bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'Request body too large' }, 413) }),
  async (c) => {
    const { OPENROUTER_API_KEY: apiKey, OPENROUTER_MODEL: modelId } = process.env;
    if (!apiKey || !modelId) return c.json({ error: 'Coach is not configured: set OPENROUTER_API_KEY and OPENROUTER_MODEL' }, 503);

    const body = await c.req.json().catch(() => null) as { messages?: unknown; snapshot?: unknown; mode?: unknown; gate?: unknown } | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'Body must be JSON' }, 400);
    const snapshot = coachSnapshotSchema.nullable().safeParse(body.snapshot ?? null);
    if (!snapshot.success) return c.json({ error: `Invalid snapshot: ${snapshot.error.issues[0]?.path.join('.')} ${snapshot.error.issues[0]?.message}` }, 400);
    const training = modeSchema.safeParse({ mode: body.mode, gate: body.gate });
    if (!training.success) return c.json({ error: `Invalid mode or gate: ${training.error.issues[0]?.path.join('.')} ${training.error.issues[0]?.message}` }, 400);
    const { mode, gate } = training.data;
    if (mode === 'free' && gate) return c.json({ error: 'Free Play requests carry no gate' }, 400);
    const mismatch = gate && gateMismatch(gate, snapshot.data);
    if (mismatch) return c.json({ error: `Invalid gate: ${mismatch}` }, 400);
    const validated = await safeValidateUIMessages({ messages: body.messages, tools: historyTools });
    if (!validated.success) return c.json({ error: `Invalid messages: ${validated.error.message.slice(0, 200)}` }, 400);
    const messages = validated.data;
    // Only the server sets system instructions.
    if (messages.some((m) => m.role === 'system')) return c.json({ error: 'System messages are not allowed' }, 400);
    // File parts would make the server fetch client-supplied URLs.
    if (messages.some((m) => m.parts.some((p) => p.type === 'file' || p.type === 'reasoning-file'))) return c.json({ error: 'File parts are not allowed' }, 400);
    const recent = messages.slice(-WINDOW_MESSAGES);
    const firstUser = recent.findIndex((m) => m.role === 'user');
    if (firstUser < 0) return c.json({ error: 'No user message' }, 400);
    // A stopped turn can leave a tool call without a result; skip it instead of failing every later request.
    const modelMessages = await convertToModelMessages(recent.slice(firstUser), { tools: historyTools, ignoreIncompleteToolCalls: true }).catch(() => null);
    if (!modelMessages) return c.json({ error: 'Invalid messages: cannot convert' }, 400);

    const result = streamText({
      model: createOpenRouter({ apiKey })(modelId),
      instructions: danInstructions(snapshot.data, mode, gate),
      messages: modelMessages,
      // Only a gated training request can unlock anything, and only its own gate.
      tools: gate ? { ...tools, release_actions: releaseActions(gate) } : tools,
      stopWhen: isStepCount(MAX_STEPS),
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

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
