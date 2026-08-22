import assert from 'node:assert/strict';
import { test } from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { LoginPageContent } from './login-page-content';

Object.assign(globalThis, { React });

test('development login page content renders the credential form slot', () => {
  const html = renderToStaticMarkup(
    <LoginPageContent
      credentialsEnabled
      credentialsForm={
        <form data-login-form="login">
          <input name="email" type="email" />
          <input name="password" type="password" />
          <button type="submit">Sign in</button>
        </form>
      }
      googleEnabled={false}
    />,
  );

  assert.match(html, /Use the configured development credentials/u);
  assert.match(html, /data-login-form="login"/u);
  assert.match(html, /name="email"/u);
  assert.match(html, /type="submit"/u);
});

test('production login page content omits actionable Credentials fields and submit controls', () => {
  const html = renderToStaticMarkup(
    <LoginPageContent
      credentialsEnabled={false}
      credentialsForm={
        <form data-login-form="login">
          <input name="email" type="email" />
          <input name="password" type="password" />
          <button type="submit">Sign in</button>
        </form>
      }
      googleEnabled={false}
    />,
  );

  assert.match(html, /Sign-in is not configured for this environment./u);
  assert.doesNotMatch(html, /data-login-form="login"/u);
  assert.doesNotMatch(html, /name="email"/u);
  assert.doesNotMatch(html, /name="password"/u);
  assert.doesNotMatch(html, /type="submit"/u);
});

test('configured production login renders Google only and does not claim public enrollment', () => {
  const html = renderToStaticMarkup(
    <LoginPageContent
      credentialsEnabled={false}
      googleEnabled
      googleSignInForm={<button type="submit">Continue with Google</button>}
    />,
  );

  assert.match(html, /Continue only with a pre-provisioned SkyOS account./u);
  assert.match(html, /Continue with Google/u);
  assert.doesNotMatch(html, /name="email"/u);
  assert.doesNotMatch(html, /name="password"/u);
  assert.doesNotMatch(html, /sign up|register/u);
});
