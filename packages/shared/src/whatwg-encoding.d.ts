// TextDecoder/TextEncoder are WHATWG globals in Node and every browser, but TypeScript ships their
// declarations only in lib.dom; declaring the subset used here keeps this package free of DOM and
// Node type dependencies (it is consumed by the web app and the Node apps alike).
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: ArrayBuffer | ArrayBufferView): string;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
