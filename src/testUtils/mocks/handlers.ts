import { http, HttpResponse } from 'msw';

/**
 * Default OpenAI-compatible endpoint used by the backend.  Real HTTP traffic
 * from tests goes through the Tauri IPC bridge (stubbed in `mocks/tauri.ts`),
 * so this handler mostly exists to catch stray fetches and provide a sensible
 * stream shape if any test ever calls the endpoint directly.
 */
const API_URL = 'http://127.0.0.1:1234/v1';

function sseStreamResponse(tokens: string[]) {
  const events = tokens
    .map(
      (t) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`,
    )
    .concat('data: [DONE]\n\n');
  return new HttpResponse(events.join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

export const handlers = [
  http.post(`${API_URL}/chat/completions`, () => {
    return sseStreamResponse(['Hello', ' world', '!']);
  }),
];
