import assert from 'node:assert/strict';

type HttpResult = {
  response: Response;
  setCookies: string[];
};

export type ServerActionCookieJar = {
  request(path: string, init?: RequestInit): Promise<HttpResult>;
};

export async function assertStreamedRedirectTo(
  response: Response,
  requestPath: string,
  targetPath: string,
  forbiddenHtml?: string,
): Promise<void> {
  assert.equal(response.status, 200, 'A streamed App Router redirect must return its HTML shell.');
  const responseUrl = new URL(response.url);
  const expectedRequestUrl = new URL(requestPath, responseUrl.origin);
  assert.equal(expectedRequestUrl.origin, responseUrl.origin);
  assert.equal(responseUrl.pathname, expectedRequestUrl.pathname);
  assert.equal(responseUrl.search, expectedRequestUrl.search);
  assert.equal(expectedRequestUrl.hash, '');

  const html = await response.text();
  const redirectMeta = html.match(/<meta(?=[^>]*\bid="__next-page-redirect")[^>]*>/u)?.[0];
  assert.ok(redirectMeta, 'Denied page render must include the Next.js redirect instruction.');
  assert.match(redirectMeta, /\bhttp-equiv="refresh"/u);
  assert.equal(redirectMeta.match(/\bcontent="([^"]*)"/u)?.[1], `1;url=${targetPath}`);
  if (forbiddenHtml) {
    assert.equal(
      html.includes(forbiddenHtml),
      false,
      'Denied page render must not expose protected form content.',
    );
  }
}

type ServerActionFormSelector = Readonly<{
  markerName: string;
  markerValue: string;
  requiredFields?: Readonly<Record<string, string>>;
}>;

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu;

  for (const match of tag.matchAll(pattern)) {
    const [, name = '', doubleQuoted, singleQuoted, unquoted] = match;
    if (name === 'form' || name === 'input') continue;
    attributes.set(name, decodeHtml(doubleQuoted ?? singleQuoted ?? unquoted ?? ''));
  }

  return attributes;
}

export function findServerActionForm(
  html: string,
  selector: ServerActionFormSelector,
): Array<readonly [string, string]> {
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gu)) {
    const formAttributes = parseAttributes(`form ${form[1] ?? ''}`);
    if (formAttributes.get(selector.markerName) !== selector.markerValue) continue;

    const fields: Array<readonly [string, string]> = [];
    for (const input of (form[2] ?? '').matchAll(/<input\b([^>]*)>/gu)) {
      const attributes = parseAttributes(`input ${input[1] ?? ''}`);
      const name = attributes.get('name');
      if (name) fields.push([name, attributes.get('value') ?? '']);
    }

    const matchesRequiredFields = Object.entries(selector.requiredFields ?? {}).every(
      ([requiredName, requiredValue]) =>
        fields.some(([name, value]) => name === requiredName && value === requiredValue),
    );
    if (!matchesRequiredFields) continue;

    assert.ok(
      fields.some(([name]) => name.startsWith('$ACTION_')),
      `Rendered ${selector.markerValue} form must contain React server-action metadata.`,
    );
    return fields;
  }

  throw new Error(`Unable to find the rendered ${selector.markerValue} server-action form.`);
}

export async function submitServerActionForm(
  jar: ServerActionCookieJar,
  baseUrl: string,
  path: string,
  html: string,
  selector: ServerActionFormSelector,
  overrides: Readonly<Record<string, string>> = {},
): Promise<Response> {
  const body = new FormData();
  for (const [name, value] of findServerActionForm(html, selector)) {
    body.append(name, value);
  }
  for (const [name, value] of Object.entries(overrides)) {
    body.set(name, value);
  }

  return (
    await jar.request(path, {
      body,
      headers: { Origin: baseUrl },
      method: 'POST',
    })
  ).response;
}
