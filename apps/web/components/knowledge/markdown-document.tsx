import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';

type MarkdownDocumentProps = Readonly<{
  content: string;
}>;

/** Restricts links to safe browser schemes and ordinary internal paths. */
export function sanitizeMarkdownUrl(value: string): string {
  const url = value.trim();

  if (
    !url ||
    url.startsWith('//') ||
    url.startsWith('/') ||
    url.startsWith('#') ||
    url.startsWith('?') ||
    url.startsWith('./') ||
    url.startsWith('../')
  ) {
    return url.startsWith('//') ? '' : url;
  }

  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? url : '';
  } catch {
    return '';
  }
}

function isExternalHttpUrl(url: string | undefined): boolean {
  return Boolean(url && /^https?:\/\//i.test(url));
}

const components: Components = {
  a({ children, href, ...props }) {
    if (!href) {
      return <span>{children}</span>;
    }

    return (
      <a
        {...props}
        href={href}
        rel={isExternalHttpUrl(href) ? 'noopener noreferrer nofollow' : undefined}
        target={isExternalHttpUrl(href) ? '_blank' : undefined}
      >
        {children}
      </a>
    );
  },
  blockquote({ children, ...props }) {
    return (
      <blockquote {...props} className="border-l-2 border-accent pl-4 text-muted-foreground">
        {children}
      </blockquote>
    );
  },
  code({ children, className, ...props }) {
    return (
      <code
        {...props}
        className={`rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[0.9em] ${className ?? ''}`}
      >
        {children}
      </code>
    );
  },
  h1({ children, ...props }) {
    return (
      <h1
        {...props}
        className="mt-8 text-3xl font-semibold tracking-tight text-foreground first:mt-0"
      >
        {children}
      </h1>
    );
  },
  h2({ children, ...props }) {
    return (
      <h2 {...props} className="mt-7 text-2xl font-semibold tracking-tight text-foreground">
        {children}
      </h2>
    );
  },
  h3({ children, ...props }) {
    return (
      <h3 {...props} className="mt-6 text-xl font-semibold tracking-tight text-foreground">
        {children}
      </h3>
    );
  },
  img({ alt }) {
    return <span>{alt ? `[Image omitted: ${alt}]` : '[Image omitted]'}</span>;
  },
  li({ children, ...props }) {
    return <li {...props}>{children}</li>;
  },
  ol({ children, ...props }) {
    return (
      <ol {...props} className="my-4 list-decimal space-y-1.5 pl-6">
        {children}
      </ol>
    );
  },
  p({ children, ...props }) {
    return (
      <p {...props} className="my-4 first:mt-0 last:mb-0">
        {children}
      </p>
    );
  },
  pre({ children, ...props }) {
    return (
      <pre
        {...props}
        className="my-4 overflow-x-auto rounded-control bg-surface-raised p-4 text-sm"
      >
        {children}
      </pre>
    );
  },
  ul({ children, ...props }) {
    return (
      <ul {...props} className="my-4 list-disc space-y-1.5 pl-6">
        {children}
      </ul>
    );
  },
};

/**
 * Renders CommonMark only. Raw HTML is skipped, the HAST is sanitized, and
 * unsafe URLs are removed before React creates an anchor element.
 */
export function MarkdownDocument({ content }: MarkdownDocumentProps) {
  return (
    <div className="break-words text-base leading-7 text-foreground">
      <ReactMarkdown
        components={components}
        rehypePlugins={[rehypeSanitize]}
        skipHtml
        urlTransform={sanitizeMarkdownUrl}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
