import { html, layout, type SafeHtml } from './html';

export const noticePage = (title: string, body: string): SafeHtml =>
  layout({ title, body: html`<h1>${title}</h1>
      <p>${body}</p>` });
