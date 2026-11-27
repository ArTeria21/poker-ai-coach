// Shared harness for the happy-dom App tests (Training Mode, level diagnosis). Import it before App.
import { act } from 'react';
import { expect, vi } from 'vitest';

// Node's own experimental localStorage global (undefined without a file) shadows happy-dom's; the settings store persists to it.
vi.hoisted(() => Object.defineProperty(globalThis, 'localStorage', { value: new Storage(), configurable: true }));
/** Whether the preflop filter calls the hero's spot obvious. */
// Read lazily by the mock factory, which runs when App first imports the training module.
export const filter = { obvious: false };
vi.mock('../agent/training', async (original) => ({
  ...await original<typeof import('../agent/training')>(),
  obviousPreflopSpot: () => filter.obvious,
}));
vi.mock('../app/sounds', () => ({ sounds: { deal: vi.fn(), chips: vi.fn(), check: vi.fn(), fold: vi.fn(), allIn: vi.fn(), win: vi.fn(), yourTurn: vi.fn() } }));
// Bots check or call, so hands run to the hero's decisions deterministically.
vi.mock('../bots/botDecision', async (original) => ({
  ...await original<typeof import('../bots/botDecision')>(),
  decideAction: vi.fn((view) => ({ action: { type: view.legal.check ? 'check' : 'call' }, trace: [] })),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const tick = () => act(() => vi.advanceTimersByTimeAsync(300));
export async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

/** Sets a controlled input's value the way React notices it. */
export async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** A UI message stream as the server writes it (SSE), fed chunk by chunk. */
export function streamed() {
  let ctl!: ReadableStreamDefaultController<string>;
  const body = new ReadableStream<string>({ start: (c) => { ctl = c; } }).pipeThrough(new TextEncoderStream());
  const send = (chunk: object) => ctl.enqueue(`data: ${JSON.stringify(chunk)}\n\n`);
  send({ type: 'start' });
  send({ type: 'start-step' });
  let calls = 0;
  const tool = (toolName: string, toolCallId: string, input: object, output: object) => {
    send({ type: 'tool-input-available', toolCallId, toolName, input });
    send({ type: 'tool-output-available', toolCallId, output });
  };
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } }),
    tool,
    /** A client question call: the server has no execute, so the step ends at the call. */
    call(toolName: string, toolCallId: string, input: object) {
      send({ type: 'tool-input-available', toolCallId, toolName, input });
    },
    /** A call whose input failed the tool's schema: the error text carries the whole input. */
    rejected(toolName: string, toolCallId: string, input: object) {
      send({ type: 'tool-input-error', toolCallId, toolName, input, errorText: `Invalid input for tool ${toolName}: ${JSON.stringify(input)}` });
    },
    release(gateId: string) {
      // Per-response numbering, as providers do: ids repeat across turns.
      tool('release_actions', `call_${calls++}`, {}, { released: gateId, kind: gateId.endsWith('#review') ? 'review' : 'decision' });
    },
    fail() {
      send({ type: 'error', errorText: 'Coach could not answer right now.' });
      ctl.close();
    },
    end(text?: string) {
      if (text) {
        send({ type: 'text-start', id: 't' });
        send({ type: 'text-delta', id: 't', delta: text });
        send({ type: 'text-end', id: 't' });
      }
      send({ type: 'finish-step' });
      send({ type: 'finish' });
      ctl.enqueue('data: [DONE]\n\n');
      ctl.close();
    },
  };
}
export type Stream = ReturnType<typeof streamed>;

/** Mocks fetch: the memory status answers `status()`, every chat request gets a new open stream pushed to `streams`. */
export function mockApi(streams: Stream[], status: () => Response | Promise<Response> = () => Response.json({ initialized: true })) {
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === '/api/memory/status') return status();
    const s = streamed();
    streams.push(s);
    return s.response;
  });
  // The chat mounts with one GET /api/memory/status; only chat requests are LLM calls.
  const chatCalls = () => spy.mock.calls.filter(([url]) => url === '/api/chat');
  return { spy, chatCalls, bodies: () => chatCalls().map(([, init]) => JSON.parse(String(init?.body))) };
}

export function dom(container: () => HTMLElement) {
  const button = (text: string) => [...container().querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  const actionButtons = () => [...container().querySelectorAll<HTMLButtonElement>('.action-buttons .btn')];
  return {
    button,
    click: (text: string) => act(() => button(text)!.click()),
    actionButtons,
    locked: () => actionButtons().length > 0 && actionButtons().every((b) => b.disabled),
    async say(text: string) {
      await type(container().querySelector<HTMLTextAreaElement>('.chat-form textarea')!, text);
      await act(() => button('Send')!.click());
    },
  };
}
