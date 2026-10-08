// Checks that the UI language follows the browser language.
// Usage: start `npm run dev`, then `node scripts/i18n-check.mjs [url] [screenshotDir]`
import { openBrowser, reporter } from './cdp.mjs';

const url = process.argv[2] || 'http://localhost:3000/';
const report = reporter();
const { check } = report;
const japanese = /[぀-ヿ一-鿿]/;
let browser;

try {
  browser = await openBrowser({ shotDir: process.argv[3] || null });
  const { send, run, until, waitFrames, shot, problems } = browser;
  const userAgent = await run('navigator.userAgent');
  // All user-visible text: content, tooltips and accessibility labels
  const uiText = () => run(`[document.body.innerText, ...[...document.querySelectorAll('[title],[aria-label]')].map((e) => e.title + ' ' + (e.getAttribute('aria-label') || ''))].join(' ')`);

  const cases = [
    ['ja-JP', '', 'ja'], ['ja', '', 'ja'], ['en-US', '', 'en'], ['fr-FR', '', 'en'], ['zh-CN', '', 'en'],
    ['en-US', '?lang=ja', 'ja'], ['ja-JP', '?lang=en', 'en']
  ];
  for (const [acceptLanguage, query, expected] of cases) {
    await send('Emulation.setUserAgentOverride', { userAgent, acceptLanguage });
    await send('Page.navigate', { url: url + query });
    await until('!!(window.corsa && corsa.physics.track) && navigator.language === ' + JSON.stringify(acceptLanguage), 60000);
    const text = await uiText();
    const isJa = japanese.test(text);
    const label = `${acceptLanguage}${query ? ' ' + query : ''} → ${expected}`;
    check(label, (await run('document.documentElement.lang')) === expected && isJa === (expected === 'ja'), (await run("document.getElementById('mode-label').textContent")));
    check('  no untranslated keys or empty labels', await run("[...document.querySelectorAll('[data-i18n]')].every((e) => e.textContent.trim() && !/^[a-z]+\\.[a-z.]+$/.test(e.textContent.trim()))"));
    await run("document.getElementById('start-btn').click(); document.getElementById('btn-mode').click()");
    check('  mode toggle stays in language', japanese.test(await run("document.getElementById('mode-label').textContent")) === (expected === 'ja'));
    if (!query) { await waitFrames(2); await shot(`i18n-${acceptLanguage}`); }
  }
  check('no console errors or exceptions', problems.length === 0, problems.slice(0, 3).join(' | '));
} catch (err) {
  console.error(err);
  report.fail();
} finally {
  if (browser) browser.close();
}
console.log(report.failures ? `\n${report.failures} check(s) failed` : '\nAll language checks passed');
process.exit(report.failures ? 1 : 0);
