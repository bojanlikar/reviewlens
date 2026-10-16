import { ConfigService } from '@nestjs/config';
import { LlmService } from './llm.service.js';

const delta = (d: object) => ({
  type: 'content_block_delta',
  index: 0,
  delta: d,
});

function serviceWith(events: object[], stop_reason: string) {
  const svc = new LlmService(new ConfigService({ ANTHROPIC_API_KEY: 'x' }));
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    finalMessage: async () => ({
      stop_reason,
      usage: { input_tokens: 1, output_tokens: 2 },
    }),
    abort: vi.fn(),
  };
  (svc as any).client = { messages: { stream: () => stream } };
  return svc;
}

const collect = async (g: AsyncGenerator<string>) => {
  let o = '';
  for await (const t of g) o += t;
  return o;
};

describe('LlmService.stream', () => {
  it('yields only visible text, never reasoning', async () => {
    const svc = serviceWith(
      [
        delta({ type: 'thinking_delta', thinking: 'secret reasoning' }),
        delta({ type: 'text_delta', text: 'Hello' }),
      ],
      'end_turn',
    );
    expect(
      await collect(svc.stream('sys', [{ role: 'user', content: 'hi' }])),
    ).toBe('Hello');
  });

  it('tells the reader when the answer hit the length limit', async () => {
    const svc = serviceWith(
      [delta({ type: 'text_delta', text: 'Partial answer' })],
      'max_tokens',
    );
    const out = await collect(
      svc.stream('sys', [{ role: 'user', content: 'hi' }]),
    );
    expect(out).toContain('Partial answer');
    expect(out).toMatch(/cut off at the length limit/);
  });
});
