import { describe, expect, it } from 'vitest';
import { escapeXml, fitSize, svgText } from './svg-card';

describe('the SVG card helpers (#881)', () => {
  it('S1 escapes every XML-special character', () => {
    expect(escapeXml(`a<b>&"c'`)).toBe('a&#60;b&#62;&#38;&#34;c&#39;');
  });

  it('S2 fits a text to its slot: the ceiling, the floor of 8 and the wider bold advance', () => {
    expect(fitSize('ab', 1000, 40, false)).toBe(40);
    expect(fitSize('x'.repeat(500), 100, 40, false)).toBe(8);
    expect(fitSize('x'.repeat(10), 248, 40, false)).toBe(40);
    expect(fitSize('x'.repeat(10), 248, 40, true)).toBe(36);
  });

  it('S3 draws a text with its weight and anchor, its value escaped', () => {
    expect(
      svgText('<b>', {
        x: 10.123,
        y: 20,
        width: 500,
        size: 30,
        bold: true,
        fill: '#fff',
        anchor: 'end',
      }),
    ).toBe(
      '<text x="10.12" y="20" font-size="30" font-weight="700" fill="#fff" text-anchor="end">&#60;b&#62;</text>',
    );
    expect(svgText('a', { x: 1, y: 2, width: 500, size: 30, fill: '#000' })).toBe(
      '<text x="1" y="2" font-size="30" fill="#000">a</text>',
    );
  });
});
