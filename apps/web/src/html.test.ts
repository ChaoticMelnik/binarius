import { describe, expect, it } from 'vitest';
import { escapeHtml, html, layout } from './html';

describe('escapeHtml', () => {
  it.each([
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
    ["'", '&#39;'],
  ])('escapes %j', (raw, escaped) => {
    expect(escapeHtml(raw)).toBe(escaped);
  });

  // the ampersand has to go first, or every other escape gets double-escaped
  it('does not double-escape what it produced', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
});

describe('html', () => {
  // the whole reason this tag exists: a user agent is attacker-controlled and reaches a cell
  it('escapes an interpolated value', () => {
    const agent = '<script>alert(1)</script>';
    expect(html`<td>${agent}</td>`.value).toBe('<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>');
  });

  it('escapes a value in an attribute, including the quote that would break out of it', () => {
    expect(html`<time datetime="${'" onload="x'}">`.value).toBe(
      '<time datetime="&quot; onload=&quot;x">',
    );
  });

  it('nests its own output without escaping it again', () => {
    const inner = html`<b>${'&'}</b>`;
    expect(html`<p>${inner}</p>`.value).toBe('<p><b>&amp;</b></p>');
  });

  it('renders an array of fragments in order', () => {
    const items = ['a', '<b>'].map((value) => html`<li>${value}</li>`);
    expect(html`<ul>${items}</ul>`.value).toBe('<ul><li>a</li><li>&lt;b&gt;</li></ul>');
  });

  it.each([
    [null, ''],
    [undefined, ''],
    [false, ''],
    [0, '0'],
  ])('renders %j as %j', (value, expected) => {
    expect(html`${value}`.value).toBe(expected);
  });

  // a string is not SafeHtml just because a caller believes it is; that the type has no other
  // way in is a compile-time claim, and its oracle is html.typecheck.ts
  it('treats a plain string as text even when it is markup', () => {
    const notSafe = '<b>bold</b>';
    expect(html`${notSafe}`.value).not.toContain('<b>');
    expect(html`${html`<b>bold</b>`}`.value).toBe('<b>bold</b>');
  });
});

describe('layout', () => {
  it('escapes the title and links the stylesheet rather than inlining a style', () => {
    const page = layout({ title: '<x>', body: html`<p>hi</p>` }).value;
    expect(page).toContain('<title>&lt;x&gt;</title>');
    expect(page).toContain('<link rel="stylesheet" href="/admin/static/app.css" />');
    expect(page).not.toContain('<style');
    expect(page).not.toContain('<script');
  });
});
