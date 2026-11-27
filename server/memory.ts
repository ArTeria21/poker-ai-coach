import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { TOPIC_IDS, TOPICS, type TopicId } from '../src/agent/contract';

/** Read per call so tests can point each case at its own temp folder. */
const memoryDir = () => resolve(process.env.MEMORY_DIR || './memory');
export const memoryFile = (name: 'working-state.md' | 'knowledge-map.md' | 'highlights.md') => join(memoryDir(), name);

/** Thrown for input the model can fix; tools return its message as `{ error }`. */
export class MemoryInputError extends Error {}
const fail = (message: string): never => { throw new MemoryInputError(message); };

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Temp file + rename: a reader sees the old or the new file, never half of one. */
async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(memoryDir(), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

const queues = new Map<string, Promise<unknown>>();
/** Runs read-modify-write updates of one file one at a time, so concurrent tool calls never lose an update. */
function serialized<T>(file: string, update: () => Promise<T>): Promise<T> {
  const run = (queues.get(file) ?? Promise.resolve()).then(update, update);
  queues.set(file, run.catch(() => undefined));
  return run;
}

/** Hand ids are stored inside the line grammars, so only plain id characters are accepted. */
const HAND_ID = /^\w[\w#.:-]{0,99}$/;
function checkHandId(handId: string | null): string {
  if (handId === null) return fail('No hand on the table: this needs the current hand from the table snapshot');
  return HAND_ID.test(handId) ? handId : fail('The current hand id cannot be stored');
}

const oneLine = (field: string, text: string, max: number) => {
  const value = text.trim();
  if (!value) fail(`${field} is empty`);
  if (value.length > max) fail(`${field} is longer than ${max} characters`);
  if (/[\r\n]/.test(value)) fail(`${field} must be one line`);
  return value;
};

// --- working-state.md -------------------------------------------------------

export const WORKING_STATE_MAX_LINES = 80;
export const WORKING_STATE_MAX_CHARS = 8000;
const WORKING_STATE_SECTIONS = ['## Current Workbench', '## Conventions', '## Student Profile'];

export function validateWorkingState(markdown: string): string {
  const trimmed = markdown.replace(/\s+$/, '');
  const text = `${trimmed}\n`;
  const lines = text.split('\n').length - 1;
  if (lines > WORKING_STATE_MAX_LINES) fail(`Working state has ${lines} lines, the limit is ${WORKING_STATE_MAX_LINES}: compress it, drop closed drafts and steps`);
  if (trimmed.length > WORKING_STATE_MAX_CHARS) fail(`Working state is longer than ${WORKING_STATE_MAX_CHARS} characters`);
  const headings = text.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.trimEnd());
  const sorted = (a: string[]) => [...a].sort().join('|');
  if (headings.length !== 3 || sorted(headings) !== sorted(WORKING_STATE_SECTIONS)) {
    fail(`Working state must have exactly the sections ${WORKING_STATE_SECTIONS.join(', ')} (each once, no other "## " headings); found: ${headings.join(', ') || 'none'}`);
  }
  return text;
}

export async function writeWorkingState(markdown: string) {
  const text = validateWorkingState(markdown);
  const file = memoryFile('working-state.md');
  await serialized(file, () => writeAtomic(file, text));
  return { saved: true, lines: text.split('\n').length - 1 };
}

// --- knowledge-map.md -------------------------------------------------------

const BOTTLENECK_TITLE_MAX = 120;
const STATUS_LABELS = ['Not started', 'Theory/Exposed', 'Guided practice', 'Mastered'];
const OVERCOME_TO_REMOVE = 3;
const MAX_BOTTLENECKS = 8;

/** `seen`: the hand where the mistake was last observed (add or relapse); overcoming it in that same hand does not count. */
type Bottleneck = { id: string; title: string; seen: string | null; overcome: string[] };
export type KnowledgeMap = { topics: Record<TopicId, number>; bottlenecks: Bottleneck[] };

const emptyMap = (): KnowledgeMap => ({ topics: Object.fromEntries(TOPIC_IDS.map((id) => [id, 0])) as Record<TopicId, number>, bottlenecks: [] });

/** Deterministic: every catalog topic in catalog order, bottlenecks in insertion order. */
export function renderKnowledgeMap(map: KnowledgeMap): string {
  const topics = TOPIC_IDS.map((id) => `- ${id} [${map.topics[id]}: ${STATUS_LABELS[map.topics[id]]}] ${TOPICS[id]}`);
  const bottlenecks = map.bottlenecks.map((b) => `- ${b.id}: ${b.title} | seen ${b.seen ?? '-'} | overcome ${b.overcome.length}/${OVERCOME_TO_REMOVE}: ${b.overcome.join(', ') || '-'}`);
  return ['# Knowledge Map', '', '## Topics', ...topics, '', '## Active Bottlenecks', ...bottlenecks, ''].join('\n');
}

const TOPIC_LINE = /^- ([a-z-]+) \[([0-3]): [^\]]+\] .+$/;
const BOTTLENECK_LINE = /^- ([a-z0-9-]+): (.+) \| seen (\S+) \| overcome \d+\/\d+: (.+)$/;

/** Only a topic dropped from the catalog is skipped; any other line outside the grammar fails as a server error, because the next render would silently drop it. */
export function parseKnowledgeMap(text: string): KnowledgeMap {
  const map = emptyMap();
  let section = '';
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!line || line === '# Knowledge Map') return;
    if (line === '## Topics' || line === '## Active Bottlenecks') {
      section = line;
      return;
    }
    const topic = section === '## Topics' && TOPIC_LINE.exec(line);
    const bottleneck = section === '## Active Bottlenecks' && BOTTLENECK_LINE.exec(line);
    if (topic) {
      if (topic[1] in TOPICS) map.topics[topic[1] as TopicId] = Number(topic[2]);
    } else if (bottleneck) {
      map.bottlenecks.push({ id: bottleneck[1], title: bottleneck[2], seen: bottleneck[3] === '-' ? null : bottleneck[3], overcome: bottleneck[4] === '-' ? [] : bottleneck[4].split(', ') });
    } else throw new Error(`knowledge-map.md line ${i + 1} is not in the grammar: fix or delete it by hand`);
  });
  return map;
}

const bottleneckId = z.string().min(1).max(40).describe('Bottleneck id, kebab-case, e.g. "ignores-raise-size"');
/** Field schemas of set_topic and add, shared with diagnosis_done. */
export const topicStatusFields = { topic: z.enum(TOPIC_IDS), status: z.number().int().min(0).max(3) };
export const bottleneckFields = { id: bottleneckId, title: z.string().min(1).max(BOTTLENECK_TITLE_MAX).describe('Short Russian description of the mistake, one line') };
/** The knowledge-map operations, shared by the tool schema and the code that applies them. */
export const knowledgeOpsSchema = z.array(z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_topic'), ...topicStatusFields }),
  z.object({ op: z.literal('add'), ...bottleneckFields }),
  z.object({ op: z.enum(['overcome', 'relapse', 'remove']), id: bottleneckId }),
])).min(1).max(10);
type KnowledgeOp = z.infer<typeof knowledgeOpsSchema>[number];

/** Applies one op in place and says what happened; `handId` comes from the request snapshot, never from the model. */
function applyOp(map: KnowledgeMap, op: KnowledgeOp, handId: string | null): string {
  if (op.op === 'set_topic') {
    map.topics[op.topic] = op.status;
    return `${op.topic} -> ${op.status}: ${STATUS_LABELS[op.status]}`;
  }
  const index = map.bottlenecks.findIndex((b) => b.id === op.id);
  const observedHand = handId !== null && HAND_ID.test(handId) ? handId : null;
  if (op.op === 'add') {
    if (index >= 0) fail(`bottleneck ${op.id} already exists`);
    if (map.bottlenecks.length >= MAX_BOTTLENECKS) fail(`at most ${MAX_BOTTLENECKS} active bottlenecks: remove or merge one first (in diagnosis_done: drop the extra bottlenecks)`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(op.id) || op.id.length > 40) fail('bottleneck id must be kebab-case, at most 40 characters');
    const title = oneLine('title', op.title, BOTTLENECK_TITLE_MAX);
    if (title.includes('|')) fail('title must not contain "|"');
    map.bottlenecks.push({ id: op.id, title, seen: observedHand, overcome: [] });
    return `added ${op.id}`;
  }
  if (index < 0) return fail(`no active bottleneck ${op.id}`);
  const bottleneck = map.bottlenecks[index];
  if (op.op === 'remove') {
    map.bottlenecks.splice(index, 1);
    return `removed ${op.id}`;
  }
  if (op.op === 'relapse') {
    bottleneck.overcome = [];
    bottleneck.seen = observedHand;
    return `${op.id}: relapse, counter reset to 0/${OVERCOME_TO_REMOVE}`;
  }
  const hand = checkHandId(handId);
  if (hand === bottleneck.seen) fail(`the mistake was observed in this hand (${hand}): only a new hand counts`);
  if (bottleneck.overcome.includes(hand)) fail(`hand ${hand} already counted for ${op.id}: only a new hand counts`);
  bottleneck.overcome.push(hand);
  if (bottleneck.overcome.length < OVERCOME_TO_REMOVE) return `${op.id}: overcome ${bottleneck.overcome.length}/${OVERCOME_TO_REMOVE}`;
  map.bottlenecks.splice(index, 1);
  return `${op.id}: overcome in ${OVERCOME_TO_REMOVE} distinct hands, removed from the active list`;
}

/** All ops or none: the first invalid op leaves the file untouched. */
export function updateKnowledgeMap(ops: KnowledgeOp[], handId: string | null) {
  const file = memoryFile('knowledge-map.md');
  return serialized(file, async () => {
    const text = await readText(file);
    const map = text === null ? emptyMap() : parseKnowledgeMap(text);
    const results = ops.map((op, i) => {
      try {
        return applyOp(map, op, handId);
      } catch (e) {
        throw e instanceof MemoryInputError ? new MemoryInputError(`op ${i + 1} (${op.op}): ${e.message}; nothing was saved`) : e;
      }
    });
    await writeAtomic(file, renderKnowledgeMap(map));
    return { results };
  });
}

/** The diagnosis result: the working state is validated before the map ops apply (all or none) and written after them, so a fixable mistake saves nothing. */
export async function saveDiagnosis(markdown: string, ops: KnowledgeOp[], handId: string | null) {
  validateWorkingState(markdown);
  if (ops.length > 0) await updateKnowledgeMap(ops, handId);
  await writeWorkingState(markdown);
}

// --- highlights.md ----------------------------------------------------------

type Highlight = { date: string; handId: string; independence: number; spot: string; takeaway: string };
const HIGHLIGHT_HEADER = /^### (\S+) · (\S+) · independence ([123])\/3$/;
const HIGHLIGHTS_READ_LIMIT = 10;

function parseHighlights(text: string): Highlight[] {
  const entries: Highlight[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = HIGHLIGHT_HEADER.exec(line);
    if (!m) return;
    const field = (prefix: string, at: number) => lines[at]?.startsWith(prefix) ? lines[at].slice(prefix.length) : '';
    entries.push({ date: m[1], handId: m[2], independence: Number(m[3]), spot: field('- Spot: ', i + 1), takeaway: field('- Takeaway: ', i + 2) });
  });
  return entries;
}

export async function appendHighlight(input: { spot: string; independence: number; takeaway: string }, handId: string | null) {
  const hand = checkHandId(handId);
  const spot = oneLine('spot', input.spot, 200);
  const takeaway = oneLine('takeaway', input.takeaway, 300);
  const file = memoryFile('highlights.md');
  return serialized(file, async () => {
    const text = (await readText(file)) ?? '# Highlights\n';
    if (parseHighlights(text).some((h) => h.handId === hand)) fail(`hand ${hand} already has a highlight: at most one per hand`);
    const entry = `### ${new Date().toLocaleDateString('sv')} · ${hand} · independence ${input.independence}/3\n- Spot: ${spot}\n- Takeaway: ${takeaway}\n`;
    await writeAtomic(file, `${text}\n${entry}`);
    return { saved: true, handId: hand };
  });
}

/** The latest entries, oldest first. */
export async function readHighlights() {
  const all = parseHighlights((await readText(memoryFile('highlights.md'))) ?? '');
  return { total: all.length, entries: all.slice(-HIGHLIGHTS_READ_LIMIT) };
}

/** True once a working state exists (after the diagnosis or Dan's first write). */
export const memoryInitialized = () => access(memoryFile('working-state.md')).then(() => true, () => false);

export interface MemoryOverview {
  initialized: boolean;
  workingState: {
    raw: string;
    sections: { workbench: string; conventions: string; studentProfile: string };
  } | null;
  knowledgeMap: {
    topics: Array<{ id: TopicId; title: string; status: number; label: string }>;
    bottlenecks: Array<Bottleneck & { target: number }>;
  } | null;
  knowledgeMapError?: string;
  highlights: { total: number; entries: Highlight[] };
}

/** Read-only inspection: a hand-edited map must not hide the other memory files. */
export async function readMemoryOverview(): Promise<MemoryOverview> {
  const [raw, mapText, highlights] = await Promise.all([
    readText(memoryFile('working-state.md')), readText(memoryFile('knowledge-map.md')), readHighlights(),
  ]);
  const sections = { workbench: '', conventions: '', studentProfile: '' };
  const headings = { 'Current Workbench': 'workbench', Conventions: 'conventions', 'Student Profile': 'studentProfile' } as const;
  let section: keyof typeof sections | null = null;
  for (const line of (raw ?? '').split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      const heading = line.slice(3).trimEnd();
      section = Object.hasOwn(headings, heading) ? headings[heading as keyof typeof headings] : null;
    } else if (section) sections[section] += `${line}\n`;
  }
  for (const key of Object.keys(sections) as Array<keyof typeof sections>) sections[key] = sections[key].trim();
  const overview: MemoryOverview = {
    initialized: raw !== null,
    workingState: raw === null ? null : { raw, sections },
    knowledgeMap: null,
    highlights,
  };
  if (mapText !== null) {
    try {
      const map = parseKnowledgeMap(mapText);
      overview.knowledgeMap = {
        topics: TOPIC_IDS.map((id) => ({ id, title: TOPICS[id], status: map.topics[id], label: STATUS_LABELS[map.topics[id]] })),
        bottlenecks: map.bottlenecks.map((b) => ({ ...b, target: OVERCOME_TO_REMOVE })),
      };
    } catch (error) {
      overview.knowledgeMapError = error instanceof Error ? error.message : String(error);
    }
  }
  return overview;
}

/** The files injected into every prompt; null when missing. */
export async function readInjectedMemory() {
  const [workingState, knowledgeMap] = await Promise.all([readText(memoryFile('working-state.md')), readText(memoryFile('knowledge-map.md'))]);
  return { workingState, knowledgeMap };
}
