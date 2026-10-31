import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

// The demo-to-real chain's banner (#880, docs/mailing.md → The demo-to-real chain): the SVG source
// in packages/shared/assets rasterised to the PNG the backend sends with the 1 h step, as the help
// banner (help-banner.ts). No words in it, so no fonts are loaded and the output is the same on
// every machine with this resvg version. Run after editing the SVG:
// node tooling/demo-to-real-banner.ts

// the help banner's 2:1 (help-banner.ts; not imported: `node` runs this file without a resolver)
export const DEMO_TO_REAL_BANNER_WIDTH = 1280;
export const DEMO_TO_REAL_BANNER_HEIGHT = 640;

const ASSETS = path.join(import.meta.dirname, '..', 'packages', 'shared', 'assets');
export const DEMO_TO_REAL_BANNER_SVG = path.join(ASSETS, 'demo-to-real-banner.svg');
export const DEMO_TO_REAL_BANNER_PNG = path.join(ASSETS, 'demo-to-real-banner.png');

export const renderDemoToRealBanner = (svg: string): Buffer =>
  new Resvg(svg, {
    fitTo: { mode: 'width', value: DEMO_TO_REAL_BANNER_WIDTH },
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();

if (import.meta.main) {
  const png = renderDemoToRealBanner(readFileSync(DEMO_TO_REAL_BANNER_SVG, 'utf8'));
  writeFileSync(DEMO_TO_REAL_BANNER_PNG, png);
  console.log(`demo-to-real-banner.png: ${String(png.length)} bytes`);
}
