import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { Mutex } from 'async-mutex';
import { assertSafeUrl } from '@/lib/utils/ssrf';

class Scraper {
  private static browser: any | undefined;
  private static IDLE_KILL_TIMEOUT = 30000;
  private static NAVIGATION_TIMEOUT = 20000;
  private static CHALLENGE_TIMEOUT = 60000;
  private static idleTimeout: NodeJS.Timeout | undefined;
  private static browserMutex = new Mutex();
  private static userCount = 0;

  private static challengeTitlePatterns: RegExp[] = [
    /not a bot/i,
    /just a moment/i,
    /checking your browser/i,
    /attention required/i,
    /verify (?:you|your)/i,
    /verify you are human/i,
    /access denied/i,
    /waiting for [a-z]+/i,
  ];

  private static isChallengePage(title: string): boolean {
    if (!title) return false;
    return this.challengeTitlePatterns.some((pattern) =>
      pattern.test(title),
    );
  }

  private static async waitForChallengeResolution(page: any): Promise<boolean> {
    let title = await page.title().catch(() => '');

    if (!this.isChallengePage(title)) return false;

    console.log(
      `[scraper] Anti-bot challenge detected (title: "${title}"), waiting up to ${
        this.CHALLENGE_TIMEOUT / 1000
      }s for it to resolve...`,
    );

    const deadline = Date.now() + this.CHALLENGE_TIMEOUT;

    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);

      title = await page.title().catch(() => '');

      if (!this.isChallengePage(title)) {
        console.log('[scraper] Anti-bot challenge resolved');
        return true;
      }
    }

    console.warn(
      `[scraper] Anti-bot challenge did not resolve within ${
        this.CHALLENGE_TIMEOUT / 1000
      }s, returning current page content`,
    );

    return false;
  }

  private static async initBrowser() {
    await this.browserMutex.runExclusive(async () => {
      if (!this.browser) {
        const { chromium } = await import('playwright');
        this.browser = await chromium.launch({
          headless: true,
          channel: 'chromium-headless-shell',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
          ],
        });
      }

      this.userCount++;
      if (this.idleTimeout) clearTimeout(this.idleTimeout);
    });
  }

  private static scheduleIdleKill() {
    if (this.idleTimeout) clearTimeout(this.idleTimeout);

    this.idleTimeout = setTimeout(async () => {
      await this.browserMutex.runExclusive(async () => {
        if (this.browser && this.userCount === 0) {
          {
            await this.browser.close();
            this.browser = undefined;
          }
        }
      });
    }, this.IDLE_KILL_TIMEOUT);
  }

  static async scrape(
    url: string,
  ): Promise<{ content: string; title: string }> {
    await assertSafeUrl(url);

    await this.initBrowser();

    if (!this.browser) throw new Error('Browser not initialized');

    const context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();

    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.NAVIGATION_TIMEOUT,
      });

      await this.waitForChallengeResolution(page);

      await page
        .waitForLoadState('load', { timeout: 5000 })
        .catch(() => undefined);
      await page.waitForTimeout(500);

      const html = await page.content();

      const dom = new JSDOM(html, {
        url,
      });

      const content = new Readability(dom.window.document).parse();

      const title = await page.title();

      return {
        content: `
        # ${title ?? 'No title'} - ${url}
        ${content?.textContent?.trim() ?? 'No content available'}
        `,
        title,
      };
    } catch (err) {
      console.log(`Error scraping ${url}:`, err);

      return {
        title: 'Failed to scrape',
        content: `# ${url}\n\nError scraping content.`,
      };
    } finally {
      this.userCount--;

      await context.close().catch((err: unknown) =>
        console.warn('[scraper] Context close error:', err),
      );

      if (this.userCount === 0) {
        this.scheduleIdleKill();
      }
    }
  }
}

export default Scraper;
