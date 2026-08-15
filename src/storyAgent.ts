import { chromium, type BrowserContext, type Page } from 'playwright';
import type { AgentConfig } from './config.js';
import { setupHud, updateHud, type HudState } from './hud.js';
import type { RunStats } from './types.js';
import { parseStoryUrl, randomInt, sleep } from './utils.js';

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

  private async openFirstStoryFromTray(page: Page): Promise<boolean> {
    if (
      !page.url().startsWith('https://www.instagram.com/') ||
      page.url().includes('/direct/') ||
      page.url().includes('/stories/')
    ) {
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
    }
    await sleep(2500);
    await this.dismissCommonPopups(page);

    console.log('[Stories] Looking for stories in home feed tray...');
    await this.syncHud('running', '', 'Scanning story tray...');

    try {
      await page.waitForSelector(
        'button[aria-label*="Story by"], div[role="button"][aria-label*="Story by"], main ul li button, main canvas',
        { timeout: 8000 },
      );
    } catch {
      // Proceed to evaluate fallback selectors
    }

    const traySelection = await page.evaluate((includeSeen: boolean) => {
      document
        .querySelectorAll('[data-ig-agent-tray-target]')
        .forEach((el) => el.removeAttribute('data-ig-agent-tray-target'));

      const ariaStoryButtons = Array.from(
        document.querySelectorAll<HTMLElement>(
          'button[aria-label*="Story by"], div[role="button"][aria-label*="Story by"], a[aria-label*="Story by"]',
        ),
      ).filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 20 && rect.height > 20;
      });

      if (ariaStoryButtons.length > 0) {
        const unseenButtons = ariaStoryButtons.filter((el) => {
          const label = (el.getAttribute('aria-label') || '').toLowerCase();
          return label.includes('not seen') || !label.includes('seen');
        });

        const target =
          unseenButtons[0] || (includeSeen ? ariaStoryButtons[0] : null);
        if (target) {
          target.setAttribute('data-ig-agent-tray-target', 'true');
          return {
            found: true,
            description: target.getAttribute('aria-label') || 'Story button',
          };
        }
        return {
          found: false,
          reason:
            'All stories in tray are already marked as seen (run with --include-seen to open seen stories too)',
        };
      }

      const mainEl = document.querySelector('main') || document.body;
      const canvases = Array.from(mainEl.querySelectorAll('canvas'));
      for (const canvas of canvases) {
        const clickable = canvas.closest<HTMLElement>('button, [role="button"], a');
        if (!clickable) continue;
        const rect = clickable.getBoundingClientRect();
        if (rect.width < 40 || rect.top > 360) continue;

        const text = (clickable.textContent || '').trim().toLowerCase();
        if (
          text === 'your story' ||
          text.includes('your story') ||
          text.includes('add to story')
        ) {
          continue;
        }

        clickable.setAttribute('data-ig-agent-tray-target', 'true');
        return {
          found: true,
          description: (clickable.textContent || 'Story tray item').trim(),
        };
      }

      return { found: false, reason: 'No story items found in the top tray' };
    }, this.config.includeSeenStories);

    if (!traySelection.found) {
      console.log(`[Stories] ${traySelection.reason}`);
      return false;
    }

    console.log(`[Stories] Opening story tray: ${traySelection.description}`);

    const targetLocator = page.locator('[data-ig-agent-tray-target="true"]').first();
    await targetLocator.click({ timeout: 5000 });

    for (let i = 0; i < 16; i++) {
      if (page.url().includes('/stories/')) {
        return true;
      }
      await sleep(400);
    }

    return page.url().includes('/stories/');
  }

  private async isCurrentSlideSponsored(page: Page): Promise<boolean> {
    try {
      return await page.evaluate(() => {
        const spans = Array.from(
          document.querySelectorAll('section span, div[role="dialog"] span'),
        );
        return spans.some((el) => {
          if (el.closest('article')) return false;
          const text = (el.textContent || '').trim();
          if (text !== 'Sponsored') return false;
          const rect = el.getBoundingClientRect();
          return rect.top >= 0 && rect.top < 220 && rect.width > 10;
        });
      });
    } catch {
      return false;
    }
  }

  private async inspectAndLikeCurrentSlide(
    page: Page,
  ): Promise<'liked' | 'already_liked' | 'no_like_button' | 'dry_run_liked'> {
    const state = await page.evaluate((isDryRun: boolean) => {
      document
        .querySelectorAll('[data-ig-agent-like-target]')
        .forEach((el) => el.removeAttribute('data-ig-agent-like-target'));

      const isStoryElement = (el: Element): boolean => {
        if (el.closest('article')) return false;
        const rect = el.getBoundingClientRect();
        return (
          rect.width > 8 &&
          rect.height > 8 &&
          rect.top > 100 &&
          rect.bottom <= window.innerHeight &&
          rect.left >= 0 &&
          rect.right <= window.innerWidth
        );
      };

      const unlikeSvgs = Array.from(
        document.querySelectorAll('svg[aria-label="Unlike"]'),
      ).filter(isStoryElement);
      if (unlikeSvgs.length > 0) {
        return 'already_liked';
      }

      const likeSvgs = Array.from(
        document.querySelectorAll('svg[aria-label="Like"]'),
      ).filter(isStoryElement);
      if (likeSvgs.length === 0) {
        return 'no_like_button';
      }

      likeSvgs.sort(
        (a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top,
      );
      const targetSvg = likeSvgs[0];
      const clickable =
        targetSvg.closest<HTMLElement>('button, [role="button"]') ||
        targetSvg.parentElement;

      if (!clickable) {
        return 'no_like_button';
      }

      clickable.setAttribute('data-ig-agent-like-target', 'true');

      if (isDryRun) {
        clickable.style.outline = '2px solid #fb7185';
        clickable.style.borderRadius = '50%';
        return 'dry_run_liked';
      }

      return 'can_like';
    }, this.config.dryRun);

    if (
      state === 'already_liked' ||
      state === 'no_like_button' ||
      state === 'dry_run_liked'
    ) {
      return state;
    }

    try {
      const likeButton = page.locator('[data-ig-agent-like-target="true"]').first();
      await likeButton.click({ timeout: 2500 });
      await sleep(250);
      return 'liked';
    } catch {
      return 'no_like_button';
    }
  }

  private async advanceToNextSlide(page: Page): Promise<boolean> {
    if (!page.url().includes('/stories/')) {
      return false;
    }

    const foundNextButton = await page.evaluate(() => {
      document
        .querySelectorAll('[data-ig-agent-next-target]')
        .forEach((el) => el.removeAttribute('data-ig-agent-next-target'));

      const selectors = [
        'button[aria-label="Next"]',
        'div[role="button"][aria-label="Next"]',
        'svg[aria-label="Next"]',
        'svg[aria-label="Right chevron"]',
      ];

      for (const sel of selectors) {
        const elements = Array.from(document.querySelectorAll(sel)).filter((el) => {
          if (el.closest('article')) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 6 && rect.height > 6;
        });

        if (elements.length > 0) {
          const el = elements[0];
          const clickable =
            el.closest<HTMLElement>('button, [role="button"]') ||
            el.parentElement ||
            (el as HTMLElement);
          clickable.setAttribute('data-ig-agent-next-target', 'true');
          return true;
        }
      }
      return false;
    });

    if (foundNextButton) {
      try {
        await page
          .locator('[data-ig-agent-next-target="true"]')
          .first()
          .click({ timeout: 2000 });
        return true;
      } catch {
        // Fall through to keyboard ArrowRight
      }
    }

    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await page.keyboard.press('ArrowRight');
    return true;
  }

  private async processStoryTray(page: Page): Promise<void> {
    const opened = await this.openFirstStoryFromTray(page);
    if (!opened) {
      return;
    }

    let consecutiveStuckCount = 0;
    let lastSlideKey = '';

    while (!this.isStopped) {
      await this.waitWhilePaused();
      if (this.isStopped) break;

      const initialStory = parseStoryUrl(page.url());
      if (!initialStory) {
        console.log('\n[Stories] Exited story viewer; all stories in tray processed.');
        break;
      }

      if (
        this.config.maxSlidesPerRun > 0 &&
        this.stats.slidesViewed >= this.config.maxSlidesPerRun
      ) {
        console.log(`\n[Stories] Reached max slides limit (${this.config.maxSlidesPerRun}). Stopping story scan.`);
        break;
      }

      if (
        this.config.maxLikesPerRun > 0 &&
        this.stats.likedCount >= this.config.maxLikesPerRun
      ) {
        console.log(`\n[Stories] Reached max likes limit (${this.config.maxLikesPerRun}). Stopping story scan.`);
        break;
      }

      const hudMode = this.config.dryRun ? 'dry_run' : 'running';
      await this.syncHud(
        hudMode,
        `@${initialStory.username}`,
        `Viewing slide (${initialStory.storyId.slice(0, 8)}...)`,
      );

      const likeDelay = randomInt(
        this.config.minLikeDelayMs,
        this.config.maxLikeDelayMs,
      );
      await sleep(likeDelay);

      await this.waitWhilePaused();
      if (this.isStopped) break;

      const urlAtLikeTime = page.url();
      const activeStory = parseStoryUrl(urlAtLikeTime);
      if (!activeStory) {
        console.log('\n[Stories] Story tray finished.');
        break;
      }

      const activeUser = activeStory.username;
      const slideKey = `${activeUser}/${activeStory.storyId}`;
      this.stats.slidesViewed++;
      this.stats.usersVisited.add(activeUser);

      if (this.config.skipUsers.has(activeUser.toLowerCase())) {
        this.stats.skippedUserSlidesCount++;
        console.log(`[Skip] [@${activeUser}] Skipped (in skip list)`);
        await this.syncHud(hudMode, `@${activeUser}`, `Skipped @${activeUser}`);
      } else if (await this.isCurrentSlideSponsored(page)) {
        this.stats.skippedAdCount++;
        console.log(`[Skip] [@${activeUser}] Skipped Sponsored Ad`);
        await this.syncHud(hudMode, `@${activeUser}`, 'Skipped Sponsored Ad');
      } else {
        const result = await this.inspectAndLikeCurrentSlide(page);
        if (result === 'liked') {
          this.stats.likedCount++;
          console.log(
            `[Liked #${this.stats.likedCount}] Story slide by @${activeUser} (${activeStory.storyId})`,
          );
          await this.syncHud(hudMode, `@${activeUser}`, `Liked @${activeUser}'s story`);
        } else if (result === 'dry_run_liked') {
          this.stats.likedCount++;
          console.log(
            `[DRY RUN #${this.stats.likedCount}] Would like story slide by @${activeUser} (${activeStory.storyId})`,
          );
          await this.syncHud(hudMode, `@${activeUser}`, `Dry-run liked @${activeUser}`);
        } else if (result === 'already_liked') {
          this.stats.alreadyLikedCount++;
          console.log(
            `[Skip] [@${activeUser}] Already liked (${activeStory.storyId})`,
          );
          await this.syncHud(hudMode, `@${activeUser}`, `Already liked @${activeUser}`);
        } else {
          this.stats.noLikeButtonCount++;
          console.log(
            `[Info] [@${activeUser}] No Like button on this slide (${activeStory.storyId})`,
          );
          await this.syncHud(hudMode, `@${activeUser}`, 'No Like button on slide');
        }
      }

      const nextDelay = randomInt(
        this.config.minNextDelayMs,
        this.config.maxNextDelayMs,
      );
      await sleep(nextDelay);

      await this.waitWhilePaused();
      if (this.isStopped) break;

      if (page.url() === urlAtLikeTime) {
        const advanced = await this.advanceToNextSlide(page);
        if (!advanced) {
          break;
        }
        await sleep(750);
      }

      const urlAfterAdvance = page.url();
      if (!urlAfterAdvance.includes('/stories/')) {
        console.log('\n[Stories] Reached the end of all stories in the tray.');
        break;
      }

      if (urlAfterAdvance === urlAtLikeTime && slideKey === lastSlideKey) {
        consecutiveStuckCount++;
        if (consecutiveStuckCount >= 3) {
          console.log('\n[Stories] Story viewer no longer advancing; reached the end of stories.');
          break;
        }
      } else {
        consecutiveStuckCount = 0;
      }
      lastSlideKey = slideKey;
    }
  }

  public async run(): Promise<RunStats> {
    const page = await this.launchBrowser();
    this.page = page;
    try {
      await this.ensureLoggedIn(page);
      if (!this.config.loginOnly && !this.isStopped) {
        await this.processStoryTray(page);
      }
      return this.stats;
    } finally {
      if (this.context) {
        await this.context.close().catch(() => {});
      }
    }
  }
}
