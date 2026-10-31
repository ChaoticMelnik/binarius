import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

// The help push's banner (#879, docs/mailing.md → The help push): the SVG source in
// packages/shared/assets rasterised to the PNG the backend sends, as the bot renders the session
// card (apps/bot/src/session-card.ts). No words in it, so no fonts are loaded and the output is
// the same on every machine with this resvg version. Run after editing the SVG:
// node tooling/help-banner.ts

// 2:1 like the analysis card's pictures and the scanner's media
export const HELP_BANNER_WIDTH = 1280;
export const HELP_BANNER_HEIGHT = 640;

const ASSETS = path.join(import.meta.dirname, '..', 'packages', 'shared', 'assets');
export const HELP_BANNER_SVG = path.join(ASSETS, 'help-banner.svg');
export const HELP_BANNER_PNG = path.join(ASSETS, 'help-banner.png');

export const renderHelpBanner = (svg: string): Buffer =>
  new Resvg(svg, {
    fitTo: { mode: 'width', value: HELP_BANNER_WIDTH },
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();

if (import.meta.main) {
  const png = renderHelpBanner(readFileSync(HELP_BANNER_SVG, 'utf8'));
  writeFileSync(HELP_BANNER_PNG, png);
  console.log(`help-banner.png: ${String(png.length)} bytes`);
}
