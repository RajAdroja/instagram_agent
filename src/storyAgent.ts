import { chromium, type BrowserContext, type Page } from 'playwright';
import type { AgentConfig } from './config.js';
import { setupHud, updateHud, type HudState } from './hud.js';
import type { RunStats } from './types.js';
import { sleep } from './utils.js';

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
}
