import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendHighlight, MemoryInputError, memoryFile, parseKnowledgeMap, readHighlights, readMemoryOverview, renderKnowledgeMap, updateKnowledgeMap, validateWorkingState, writeWorkingState,
  type KnowledgeMap,
} from './memory';
import { TOPIC_IDS } from '../src/agent/contract';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dan-memory-'));
  vi.stubEnv('MEMORY_DIR', dir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const workingState = (extraLines = 0) => [
  '# Working State', '## Current Workbench', '- Тема: pot-odds', '## Conventions', '- Требуемое эквити = колл / (банк + колл)', '## Student Profile', '- Уровень: начинающий',
  ...Array.from({ length: extraLines }, (_, i) => `- line ${i}`),
].join('\n');
const mapText = () => readFile(memoryFile('knowledge-map.md'), 'utf8');

describe('memory overview', () => {
  it('returns an empty overview without creating files', async () => {
    expect(await readMemoryOverview()).toEqual({ initialized: false, workingState: null, knowledgeMap: null, highlights: { total: 0, entries: [] } });
    expect(await readdir(dir)).toEqual([]);
  });

  it('splits reordered CRLF sections and exposes the full catalog, bottlenecks and highlights', async () => {
    const raw = '# Working State\r\n## Student Profile\r\n  Игрок SNG  \r\n## Current Workbench\r\n- Защита BB\r\n### Next spot\r\nПроверить цену\r\n## Conventions\r\n- Считать в BB\r\n';
    await writeWorkingState(raw);
    await updateKnowledgeMap([{ op: 'set_topic', topic: 'pot-odds', status: 2 }, { op: 'add', id: 'wide-defense', title: 'Слишком широкая защита' }], 'hand-1');
    await updateKnowledgeMap([{ op: 'overcome', id: 'wide-defense' }], 'hand-2');
    await appendHighlight({ spot: 'BB против рейза', independence: 2, takeaway: 'Учесть цену колла' }, 'hand-2');
    const overview = await readMemoryOverview();
    expect(overview.initialized).toBe(true);
    expect(overview.workingState).toEqual({ raw: await readFile(memoryFile('working-state.md'), 'utf8'), sections: {
      studentProfile: 'Игрок SNG', workbench: '- Защита BB\n### Next spot\nПроверить цену', conventions: '- Считать в BB',
    } });
    expect(overview.knowledgeMap?.topics.map((t) => t.id)).toEqual(TOPIC_IDS);
    expect(overview.knowledgeMap?.topics.find((t) => t.id === 'pot-odds')).toEqual({ id: 'pot-odds', title: 'Шансы банка и требуемое эквити', status: 2, label: 'Guided practice' });
    expect(overview.knowledgeMap?.bottlenecks).toEqual([{ id: 'wide-defense', title: 'Слишком широкая защита', seen: 'hand-1', overcome: ['hand-2'], target: 3 }]);
    expect(overview.highlights).toMatchObject({ total: 1, entries: [{ handId: 'hand-2', independence: 2, spot: 'BB против рейза', takeaway: 'Учесть цену колла' }] });
  });

  it('retains partial memory and reports grammar errors without rewriting the edited map', async () => {
    await writeFile(memoryFile('knowledge-map.md'), '# Hand edited\n');
    await appendHighlight({ spot: 'Spot', independence: 1, takeaway: 'Takeaway' }, 'hand-1');
    const overview = await readMemoryOverview();
    expect(overview).toMatchObject({ initialized: false, workingState: null, knowledgeMap: null, knowledgeMapError: expect.stringMatching(/line 1 is not in the grammar/), highlights: { total: 1 } });
    expect(await mapText()).toBe('# Hand edited\n');
  });
});

describe('knowledge map grammar', () => {
  it('round-trips deterministically', () => {
    const map: KnowledgeMap = parseKnowledgeMap(renderKnowledgeMap({ topics: { ...parseKnowledgeMap('').topics, 'pot-odds': 2, 'icm-bubble': 3 }, bottlenecks: [
      { id: 'ignores-raise-size', title: 'Игнорирует размер рейза: защищает BB слишком широко', seen: 'sng-a-hand-1', overcome: ['sng-a-hand-3', 'sng-a-hand-7'] },
      { id: 'overvalues-ax', title: 'Переоценивает доминируемые тузы', seen: null, overcome: [] },
    ] }));
    const text = renderKnowledgeMap(map);
    expect(parseKnowledgeMap(text)).toEqual(map);
    expect(renderKnowledgeMap(parseKnowledgeMap(text))).toBe(text);
    expect(text).toContain('- pot-odds [2: Guided practice] Шансы банка и требуемое эквити');
    expect(text).toContain('- ignores-raise-size: Игнорирует размер рейза: защищает BB слишком широко | seen sng-a-hand-1 | overcome 2/3: sng-a-hand-3, sng-a-hand-7');
    expect(text).toContain('- overvalues-ax: Переоценивает доминируемые тузы | seen - | overcome 0/3: -');
    expect(text.split('\n').filter((l) => l.includes('[0: Not started]'))).toHaveLength(TOPIC_IDS.length - 2);
  });

  it('skips only dropped catalog topics; any other stray line blocks updates as a server error instead of being dropped', async () => {
    const text = '# Knowledge Map\n\n## Topics\n- river-play [1: Theory/Exposed] Ривер\n- pot-odds [2: Guided practice] x\n## Active Bottlenecks\n- a: A | seen - | overcome 0/3: -\n';
    expect(parseKnowledgeMap(text)).toMatchObject({ topics: { 'pot-odds': 2 }, bottlenecks: [{ id: 'a' }] });
    for (const edited of [`${text}<!-- note -->`, text.replace('- pot-odds', '* pot-odds'), text.replace('- a:', '  - a:'), text.replace('## Topics\n', ''), text.replace('| seen - ', '')]) {
      expect(() => parseKnowledgeMap(edited), edited).toThrow(/not in the grammar/);
    }
    await writeFile(memoryFile('knowledge-map.md'), `${text}<!-- note -->`);
    const error = await updateKnowledgeMap([{ op: 'set_topic', topic: 'pot-odds', status: 1 }], null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MemoryInputError);
    expect(await mapText()).toContain('<!-- note -->');
  });
});

describe('working state', () => {
  it('accepts 80 lines with exactly the three sections and rejects the rest', async () => {
    expect(validateWorkingState(workingState(73)).split('\n')).toHaveLength(81);
    expect(() => validateWorkingState(workingState(74))).toThrow(/81 lines, the limit is 80/);
    const filler = (n: number) => `## Current Workbench\n## Conventions\n## Student Profile\n${'x'.repeat(n - 55)}`;
    expect(validateWorkingState(filler(8000))).toHaveLength(8001);
    expect(() => validateWorkingState(filler(8001))).toThrow(/longer than 8000/);
    expect(() => validateWorkingState(workingState().replace('## Conventions', '## Notes'))).toThrow(/exactly the sections/);
    expect(() => validateWorkingState(`${workingState()}\n## Student Profile`)).toThrow(/exactly the sections/);
    await writeWorkingState(workingState());
    expect(await readFile(memoryFile('working-state.md'), 'utf8')).toBe(`${workingState()}\n`);
  });
});

describe('bottlenecks', () => {
  it('counts overcome per distinct snapshot hand, rejects the same hand, removes at the 3rd and resets on relapse', async () => {
    await updateKnowledgeMap([{ op: 'add', id: 'ignores-raise-size', title: 'Игнорирует размер рейза' }, { op: 'set_topic', topic: 'blind-defense', status: 1 }], 'h-0');
    await expect(updateKnowledgeMap([{ op: 'overcome', id: 'ignores-raise-size' }], 'h-0')).rejects.toThrow(/observed in this hand/);
    await expect(updateKnowledgeMap([{ op: 'add', id: 'b', title: 'B' }, { op: 'overcome', id: 'b' }], 'h-1')).rejects.toThrow(/observed in this hand/);
    expect(await updateKnowledgeMap([{ op: 'overcome', id: 'ignores-raise-size' }], 'h-1')).toEqual({ results: ['ignores-raise-size: overcome 1/3'] });
    await expect(updateKnowledgeMap([{ op: 'overcome', id: 'ignores-raise-size' }], 'h-1')).rejects.toThrow(/already counted/);
    await expect(updateKnowledgeMap([{ op: 'overcome', id: 'ignores-raise-size' }], null)).rejects.toThrow(/No hand/);
    await expect(updateKnowledgeMap([{ op: 'overcome', id: 'ignores-raise-size' }], '-')).rejects.toThrow(/cannot be stored/);
    await updateKnowledgeMap([{ op: 'overcome', id: 'ignores-raise-size' }], 'h-2');
    await updateKnowledgeMap([{ op: 'relapse', id: 'ignores-raise-size' }], 'h-3');
    expect(await mapText()).toContain('| seen h-3 | overcome 0/3: -');
    await expect(updateKnowledgeMap([{ op: 'overcome', id: 'ignores-raise-size' }], 'h-3')).rejects.toThrow(/observed in this hand/);
    for (const hand of ['h-4', 'h-6']) await updateKnowledgeMap([{ op: 'overcome', id: 'ignores-raise-size' }], hand);
    expect(await mapText()).toContain('overcome 2/3: h-4, h-6');
    const { results } = await updateKnowledgeMap([{ op: 'overcome', id: 'ignores-raise-size' }], 'h-5');
    expect(results[0]).toMatch(/removed/);
    const map = parseKnowledgeMap(await mapText());
    expect(map.bottlenecks).toEqual([]);
    expect(map.topics['blind-defense']).toBe(1);
  });

  it('applies a batch all or nothing', async () => {
    await expect(updateKnowledgeMap([{ op: 'add', id: 'a', title: 'A' }, { op: 'remove', id: 'missing' }], 'h-1')).rejects.toThrow(/op 2 \(remove\).*nothing was saved/);
    await expect(readdir(dir)).resolves.toEqual([]);
    await expect(updateKnowledgeMap([{ op: 'add', id: 'Bad Id', title: 'A' }], null)).rejects.toThrow(/kebab-case/);
  });
});

describe('highlights', () => {
  it('keeps one entry per hand and reads the latest ten oldest first', async () => {
    await appendHighlight({ spot: 'BB против мин-рейза', independence: 3, takeaway: 'Защита по шансам банка' }, 'h-1');
    await expect(appendHighlight({ spot: 'x', independence: 1, takeaway: 'y' }, 'h-1')).rejects.toThrow(/already has a highlight/);
    await expect(appendHighlight({ spot: 'x\ny', independence: 1, takeaway: 'y' }, 'h-2')).rejects.toThrow(/one line/);
    for (let i = 2; i <= 12; i++) await appendHighlight({ spot: `spot ${i}`, independence: 2, takeaway: `takeaway ${i}` }, `h-${i}`);
    const { total, entries } = await readHighlights();
    expect(total).toBe(12);
    expect(entries.map((e) => e.handId)).toEqual(Array.from({ length: 10 }, (_, i) => `h-${i + 3}`));
    expect(entries[9]).toMatchObject({ independence: 2, spot: 'spot 12', takeaway: 'takeaway 12' });
    const text = await readFile(memoryFile('highlights.md'), 'utf8');
    await writeFile(memoryFile('highlights.md'), text.replaceAll('\n', '\r\n'));
    await expect(appendHighlight({ spot: 'x', independence: 1, takeaway: 'y' }, 'h-12')).rejects.toThrow(/already has a highlight/);
    expect(text).toMatch(/^### \d{4}-\d{2}-\d{2} · h-1 · independence 3\/3\n- Spot: BB против мин-рейза\n- Takeaway: Защита по шансам банка\n/m);
  });
});

describe('concurrent writes', () => {
  it('serializes updates of one file and leaves no temp files', async () => {
    const adds = Array.from({ length: 8 }, (_, i) => updateKnowledgeMap([{ op: 'add', id: `b-${i}`, title: `B ${i}` }], null));
    const highlights = Array.from({ length: 20 }, (_, i) => appendHighlight({ spot: `s${i}`, independence: 1, takeaway: 't' }, `h-${i}`));
    const states = Array.from({ length: 5 }, () => writeWorkingState(workingState()));
    await Promise.all([...adds, ...highlights, ...states]);
    expect(parseKnowledgeMap(await mapText()).bottlenecks).toHaveLength(8);
    expect((await readHighlights()).total).toBe(20);
    expect((await readdir(dir)).sort()).toEqual(['highlights.md', 'knowledge-map.md', 'working-state.md']);
  });
});
