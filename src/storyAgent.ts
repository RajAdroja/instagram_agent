import { chromium, type BrowserContext, type Page } from 'playwright';
import type { AgentConfig } from './config.js';
import { setupHud, updateHud, type HudState } from './hud.js';
import type { RunStats } from './types.js';
import { randomInt, sleep } from './utils.js';

export class InstagramStoryAgent {
  private config: AgentConfig;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private isPaused = false;
  private isStopped = false;
  private stats: RunStats = {
    likedCount: 0,
    alreadyLikedCount: 0,
    skippedAdCount: 0,
    skippedUserSlidesCount: 0,
    noLikeButtonCount: 0,
    slidesViewed: 0,
    usersVisited: new Set<string>(),
  };

  constructor(config: AgentConfig) {
    this.config = config;
  }

  public stop(): void {
    this.isStopped = true;
  }

  public getStats(): RunStats {
    return this.stats;
  }

  private async syncHud(
    status: HudState['status'],
    currentUser: string,
    lastAction: string,
  ): Promise<void> {
    if (!this.page) return;
    await updateHud(this.page, {
      status: this.isPaused ? 'paused' : status,
      currentUser,
      likedCount: this.stats.likedCount,
      alreadyLikedCount: this.stats.alreadyLikedCount,
      slidesViewed: this.stats.slidesViewed,
      usersVisited: this.stats.usersVisited.size,
      dmReactedCount: 0,
      maxLikes: this.config.maxLikesPerRun,
      lastAction,
    });
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.isPaused && !this.isStopped) {
      await sleep(400);
    }
  }

  private async launchBrowser(): Promise<Page> {
    console.log(`[Browser] Launching browser (profile: ${this.config.userDataDir})...`);

    const launchOptions = {
      headless: false,
      viewport: { width: 1280, height: 840 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
      ],
    };

    try {
      this.context = await chromium.launchPersistentContext(this.config.userDataDir, {
        ...launchOptions,
        channel: 'chrome',
      });
    } catch {
      console.log('[Browser] System Chrome channel unavailable, falling back to Playwright Chromium...');
      this.context = await chromium.launchPersistentContext(
        this.config.userDataDir,
        launchOptions,
      );
    }

    const pages = this.context.pages();
    const page = pages.length > 0 ? pages[0] : await this.context.newPage();

    await setupHud(page, {
      onTogglePause: () => {
        this.isPaused = !this.isPaused;
        console.log(this.isPaused ? '[Agent] Paused via HUD' : '[Agent] Resumed via HUD');
        return this.isPaused;
      },
      onStop: () => {
        console.log('[Agent] Stop requested via HUD');
        this.isStopped = true;
      },
    });

    return page;
  }

  private async isAuthenticated(page: Page): Promise<boolean> {
    if (!this.context) return false;
    try {
      const cookies = await this.context.cookies('https://www.instagram.com');
      const hasSessionUser = cookies.some(
        (c) => c.name === 'ds_user_id' && Boolean(c.value),
      );
      if (!hasSessionUser) return false;

      const currentUrl = page.url();
      if (
        currentUrl.includes('/accounts/login') ||
        currentUrl.includes('/challenge/') ||
        currentUrl.includes('/two_factor')
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async dismissCommonPopups(page: Page): Promise<void> {
    const dismissLabels = ['Not Now', 'Not now', 'Cancel'];
    for (const label of dismissLabels) {
      try {
        const btn = page
          .locator(`div[role="dialog"] button:has-text("${label}"), div[role="dialog"] div[role="button"]:has-text("${label}")`)
          .first();
        if (await btn.isVisible({ timeout: 300 })) {
          await btn.click({ timeout: 1000 });
          await sleep(500);
        }
      } catch {
        // Ignore if popup is not present
      }
    }

    try {
      if (page.url().includes('/accounts/onetap/')) {
        const saveInfoBtn = page
          .locator('button:has-text("Save info"), div[role="button"]:has-text("Save info"), button:has-text("Not now")')
          .first();
        if (await saveInfoBtn.isVisible({ timeout: 1000 })) {
          await saveInfoBtn.click();
          await sleep(1500);
        }
      }
    } catch {
      // Ignore
    }
  }

  private async ensureLoggedIn(page: Page): Promise<void> {
    await page.goto('https://www.instagram.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await sleep(2000);

    if (await this.isAuthenticated(page)) {
      await this.dismissCommonPopups(page);
      console.log('[Auth] Logged in using saved browser session.');
      return;
    }

    await this.syncHud('waiting_login', '', 'Please log in to Instagram...');

    if (this.config.igUsername && this.config.igPassword) {
      console.log('[Auth] Filling credentials from .env...');
      try {
        const userInput = page
          .locator('input[name="username"], input[name="email"]')
          .first();
        const passInput = page
          .locator('input[name="password"], input[name="pass"]')
          .first();

        if (await userInput.isVisible({ timeout: 5000 })) {
          await userInput.fill(this.config.igUsername);
          await sleep(randomInt(400, 800));
          await passInput.fill(this.config.igPassword);
          await sleep(randomInt(400, 800));
          const submitBtn = page
            .locator('button[type="submit"], div[role="button"]:has-text("Log in")')
            .first();
          await submitBtn.click();
        }
      } catch {
        console.log('[Auth] Could not auto-fill login form; please log in manually in the browser.');
      }
    }

    console.log('\n[Auth] Please complete your Instagram login (and 2FA if prompted) in the opened browser window.');
    console.log('       Your session will be saved in .browser-profile so you only need to do this once.\n');

    while (!this.isStopped) {
      if (await this.isAuthenticated(page)) {
        await sleep(1500);
        await this.dismissCommonPopups(page);
        console.log('[Auth] Login detected and session saved.');
        return;
      }
      await this.syncHud('waiting_login', '', 'Waiting for manual login...');
      await sleep(1500);
    }
  }
}
