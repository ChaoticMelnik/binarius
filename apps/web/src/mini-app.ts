// What every Mini App page (the OAuth pages, the cashier) shares.

// the line core.telegram.org/bots/webapps gives (fetched 2026-10-01); in <head>, before our script
export const TELEGRAM_SDK_URL = 'https://telegram.org/js/telegram-web-app.js?63';

// The admin pages' policy plus what a Mini App needs: Telegram's SDK, a fetch to this origin, and
// being framed by Telegram Web — the one parent origin the SDK itself trusts. No X-Frame-Options
// beside it: a browser that honours both would let DENY override frame-ancestors. A page that
// embeds a frame of its own (the cashier, #111) names its origins; without them nothing may be
// framed, as default-src 'none' says.
export const miniAppCsp = (frameOrigins: readonly string[] = []): string =>
  [
    "default-src 'none'",
    "script-src 'self' https://telegram.org",
    "connect-src 'self'",
    "style-src 'self'",
    ...(frameOrigins.length > 0 ? [`frame-src ${frameOrigins.join(' ')}`] : []),
    "form-action 'none'",
    'frame-ancestors https://web.telegram.org',
    "base-uri 'none'",
  ].join('; ');
