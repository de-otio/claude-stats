/**
 * Phase-D LLM-judge tests: prompt construction (blinding), tolerant verdict
 * parsing, verdict→signal mapping, and graceful failure. No real network — the
 * provider is a fake.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildJudgePrompt,
  parseJudgeVerdict,
  judgeSignal,
  runJudge,
  type JudgeProvider,
  type JudgeVerdict,
} from '../cost-per-task/judge.js';
import { createHttpJudgeProvider } from '../cost-per-task/judge-http.js';
import type { TaskEvidence } from '../cost-per-task/outcome-types.js';

function ev(overrides: Partial<TaskEvidence> = {}): TaskEvidence {
  return {
    userPrompts: [],
    stopReasons: [],
    editEvents: [],
    committed: false,
    lastActivityMs: 0,
    toolErrors: 0,
    commitSubjects: [],
    ...overrides,
  };
}

const fakeProvider = (reply: string): JudgeProvider => ({ complete: vi.fn(async () => reply) });

describe('buildJudgePrompt', () => {
  it('includes the user turns, mechanical facts, and asks for a JSON verdict', () => {
    const p = buildJudgePrompt(ev({ userPrompts: ['fix the parser', "still broken"], toolErrors: 4, committed: true }));
    expect(p).toContain('fix the parser');
    expect(p).toContain('still broken');
    expect(p).toContain('failed tool calls: 4');
    expect(p).toContain('committed: yes');
    expect(p).toContain('"outcome":"success|failed|uncertain"');
    // Framed as an independent reviewer (self-attribution mitigation).
    expect(p.toLowerCase()).toContain('independent reviewer');
  });

  it('handles no turns without crashing', () => {
    expect(buildJudgePrompt(ev())).toContain('(none)');
  });
});

describe('parseJudgeVerdict', () => {
  it('parses a clean JSON verdict', () => {
    expect(parseJudgeVerdict('{"outcome":"success","confidence":0.9}')).toEqual({ outcome: 'success', confidence: 0.9 });
  });

  it('extracts the verdict from surrounding prose', () => {
    expect(parseJudgeVerdict('Sure! {"outcome":"failed","confidence":0.7} hope that helps'))
      .toEqual({ outcome: 'failed', confidence: 0.7 });
  });

  it('clamps confidence to [0,1] and defaults a missing/invalid one to 0.5', () => {
    expect(parseJudgeVerdict('{"outcome":"success","confidence":5}')?.confidence).toBe(1);
    expect(parseJudgeVerdict('{"outcome":"success","confidence":-2}')?.confidence).toBe(0);
    expect(parseJudgeVerdict('{"outcome":"success"}')?.confidence).toBe(0.5);
    expect(parseJudgeVerdict('{"outcome":"success","confidence":"high"}')?.confidence).toBe(0.5);
  });

  it('returns null for malformed / invalid outcomes', () => {
    expect(parseJudgeVerdict('not json at all')).toBeNull();
    expect(parseJudgeVerdict('{"outcome":"maybe","confidence":1}')).toBeNull();
    expect(parseJudgeVerdict('{"confidence":1}')).toBeNull();
    expect(parseJudgeVerdict('{bad json}')).toBeNull();
    expect(parseJudgeVerdict('')).toBeNull();
  });
});

describe('judgeSignal', () => {
  const v = (o: JudgeVerdict): JudgeVerdict => o;
  it('maps success/failed to ±confidence with the llm_judge tag', () => {
    expect(judgeSignal(v({ outcome: 'success', confidence: 0.8 }))).toEqual({ id: 'llm_judge', value: 0.8, evidence: 'llm_judge' });
    expect(judgeSignal(v({ outcome: 'failed', confidence: 0.6 }))).toEqual({ id: 'llm_judge', value: -0.6, evidence: 'llm_judge' });
  });

  it('produces no signal for uncertain or null', () => {
    expect(judgeSignal(v({ outcome: 'uncertain', confidence: 0.9 }))).toBeNull();
    expect(judgeSignal(null)).toBeNull();
  });
});

describe('runJudge', () => {
  it('returns the mapped signal on a good reply', async () => {
    const sig = await runJudge(fakeProvider('{"outcome":"failed","confidence":1}'), ev({ userPrompts: ['x', 'nope'] }));
    expect(sig).toEqual({ id: 'llm_judge', value: -1, evidence: 'llm_judge' });
  });

  it('degrades to null when the provider throws (graceful)', async () => {
    const provider: JudgeProvider = { complete: vi.fn(async () => { throw new Error('network down'); }) };
    expect(await runJudge(provider, ev())).toBeNull();
  });

  it('degrades to null when the reply is unparseable', async () => {
    expect(await runJudge(fakeProvider('I think it went fine'), ev())).toBeNull();
  });

  it('PRIVACY: the emitted signal carries only the enum tag, no prompt text', async () => {
    const sig = await runJudge(fakeProvider('{"outcome":"success","confidence":0.5}'), ev({ userPrompts: ['secret prompt text'] }));
    expect(JSON.stringify(sig)).not.toContain('secret prompt text');
  });
});

describe('createHttpJudgeProvider', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function stubFetch(impl: (url: string, init: RequestInit) => { ok: boolean; status: number; body: unknown }): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async (url: string, init: RequestInit) => {
      const r = impl(url, init);
      return { ok: r.ok, status: r.status, json: async () => r.body } as unknown as Response;
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('POSTs an OpenAI-compatible body and returns the assistant content', async () => {
    const fetchFn = stubFetch(() => ({ ok: true, status: 200, body: { choices: [{ message: { content: 'hello' } }] } }));
    const provider = createHttpJudgeProvider({ endpoint: 'http://localhost:11434/v1/chat/completions', model: 'llama3.1' });
    const out = await provider.complete('judge this');
    expect(out).toBe('hello');
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ model: 'llama3.1', temperature: 0, stream: false });
    expect(body.messages[0]).toEqual({ role: 'user', content: 'judge this' });
    // No apiKey → no Authorization header.
    expect((init as RequestInit).headers).not.toHaveProperty('authorization');
  });

  it('adds a Bearer Authorization header when an apiKey is given', async () => {
    const fetchFn = stubFetch(() => ({ ok: true, status: 200, body: { choices: [{ message: { content: 'x' } }] } }));
    const provider = createHttpJudgeProvider({ endpoint: 'https://api.example.com/v1/chat/completions', model: 'gpt-4o-mini', apiKey: 'sk-test' });
    await provider.complete('p');
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
  });

  it('throws on a non-2xx response (runJudge then degrades to no signal)', async () => {
    stubFetch(() => ({ ok: false, status: 503, body: {} }));
    const provider = createHttpJudgeProvider({ endpoint: 'http://x/y', model: 'm' });
    await expect(provider.complete('p')).rejects.toThrow(/503/);
  });

  it('returns empty string when the response has no content', async () => {
    stubFetch(() => ({ ok: true, status: 200, body: { choices: [] } }));
    const provider = createHttpJudgeProvider({ endpoint: 'http://x/y', model: 'm' });
    expect(await provider.complete('p')).toBe('');
  });
});
