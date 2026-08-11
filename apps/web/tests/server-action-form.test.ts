import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertAppRouterNotFound } from './server-action-form';

const REQUEST_URL = 'http://localhost:3000/ai/00000000-0000-4000-8000-000000000001';
const STREAMED_NOT_FOUND = `<!doctype html><html><head><meta content="noindex" name="robots"></head><body><script>self.__next_f.push([1,"NEXT_HTTP_ERROR_FALLBACK;404"])</script></body></html>`;

function htmlResponse(status: number, html: string, url = REQUEST_URL): Response {
  const response = new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    status,
  });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

test('App Router not-found assertion accepts non-streamed 404 and streamed 200 responses', async () => {
  await assert.doesNotReject(
    assertAppRouterNotFound(htmlResponse(404, '<h1>Not found</h1>'), new URL(REQUEST_URL).pathname),
  );
  assert.equal(
    await assertAppRouterNotFound(
      htmlResponse(200, STREAMED_NOT_FOUND),
      new URL(REQUEST_URL).pathname,
    ),
    STREAMED_NOT_FOUND,
  );
});

test('App Router not-found assertion rejects ordinary pages and redirects', async () => {
  await assert.rejects(
    assertAppRouterNotFound(htmlResponse(200, '<h1>Not Found</h1>'), new URL(REQUEST_URL).pathname),
    /must contain the Next\.js 404 digest/u,
  );
  await assert.rejects(
    assertAppRouterNotFound(
      htmlResponse(
        200,
        `${STREAMED_NOT_FOUND}<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/dashboard">`,
      ),
      new URL(REQUEST_URL).pathname,
    ),
    /must not be a redirect/u,
  );
});

test('App Router not-found assertion rejects protected content and a different response path', async () => {
  await assert.rejects(
    assertAppRouterNotFound(
      htmlResponse(200, `${STREAMED_NOT_FOUND}<p>private conversation</p>`),
      new URL(REQUEST_URL).pathname,
      ['private conversation'],
    ),
    /exposed protected content/u,
  );
  await assert.rejects(
    assertAppRouterNotFound(
      htmlResponse(200, STREAMED_NOT_FOUND, 'http://localhost:3000/dashboard'),
      new URL(REQUEST_URL).pathname,
    ),
  );
});
