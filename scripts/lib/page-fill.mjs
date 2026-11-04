import { pathToFileURL } from 'node:url';

// Letter is 11in tall with 0.5in print margins on each side. At 96 CSS px/in
// the printable height is 960px. The theme uses 15px text at line-height 1.4,
// so one line is 21px.
export const PAGE_CONTENT_HEIGHT = 960;
export const LINE_HEIGHT = 21;
export const MIN_FILL_HEIGHT = PAGE_CONTENT_HEIGHT - 2 * LINE_HEIGHT;

export async function createPageMeasurer() {
  const puppeteer = (await import('puppeteer')).default;
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  return {
    async measure(htmlPath) {
      const page = await browser.newPage();
      try {
        await page.emulateMediaType('print');
        await page.setViewport({
          width: 720,
          height: PAGE_CONTENT_HEIGHT,
          deviceScaleFactor: 1,
        });
        await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
        return await page.evaluate(() => {
          const resume = document.querySelector('#resume') ?? document.body;
          return resume.getBoundingClientRect().height;
        });
      } finally {
        await page.close();
      }
    },
    async close() {
      await browser.close();
    },
  };
}
