import assert from 'node:assert/strict';
import { test } from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MarkdownDocument, sanitizeMarkdownUrl } from './markdown-document';

test('Markdown rendering keeps normal formatting and safe external links', () => {
  const html = renderToStaticMarkup(
    <MarkdownDocument
      content={`# Safe heading

Normal **bold** text and a [safe link](https://example.com).`}
    />,
  );

  assert.match(html, /<h1[^>]*>Safe heading<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
});

test('Markdown rendering rejects raw HTML, executable attributes, and unsafe URLs', () => {
  const html = renderToStaticMarkup(
    <MarkdownDocument
      content={`[javascript](javascript:alert('xss'))

[data](data:text/html,<script>alert('xss')</script>)

[file](file:///etc/passwd)

<script>alert('xss')</script>
<iframe src="https://evil.example"></iframe>
<form action="https://evil.example"><input onerror="alert('xss')" /></form>`}
    />,
  );

  assert.equal(sanitizeMarkdownUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeMarkdownUrl('data:text/html,alert(1)'), '');
  assert.equal(sanitizeMarkdownUrl('file:///etc/passwd'), '');
  assert.equal(sanitizeMarkdownUrl('//evil.example/path'), '');
  assert.doesNotMatch(
    html,
    /<script|<iframe|<form|<input|onerror=|javascript:|data:text|file:\/\//i,
  );
});
