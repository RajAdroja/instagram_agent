import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type { AgentConfig } from './config.js';
import type { HudState } from './hud.js';
import type { RunStats } from './types.js';
import { randomInt, sleep } from './utils.js';

interface DmActionHooks {
  syncHud: (status: HudState['status'], currentUser: string, lastAction: string) => Promise<void>;
  waitWhilePaused: () => Promise<void>;
  isStopped: () => boolean;
  dismissCommonPopups: (page: Page) => Promise<void>;
}

export class InstagramDmReactor {
  private config: AgentConfig;
  private stats: RunStats;
  private hooks: DmActionHooks;
  private reactedCachePath: string;
  private reactedSignatures: Set<string>;

  constructor(config: AgentConfig, stats: RunStats, hooks: DmActionHooks) {
    this.config = config;
    this.stats = stats;
    this.hooks = hooks;
    this.reactedCachePath = path.join(config.userDataDir, 'reacted-dm-items.json');
    this.reactedSignatures = this.loadReactedCache();
  }

  private loadReactedCache(): Set<string> {
    try {
      if (fs.existsSync(this.reactedCachePath)) {
        const raw = fs.readFileSync(this.reactedCachePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return new Set(parsed);
        }
      }
    } catch {
      // Ignore corrupt cache
    }
    return new Set<string>();
  }

  private saveReactedCache(): void {
    try {
      fs.mkdirSync(path.dirname(this.reactedCachePath), { recursive: true });
      const items = Array.from(this.reactedSignatures).slice(-2000);
      fs.writeFileSync(this.reactedCachePath, JSON.stringify(items, null, 2), 'utf8');
    } catch {
      // Ignore cache write errors
    }
  }

  public async scanAndReactToDmMedia(page: Page): Promise<void> {
    const hudMode = this.config.dryRun ? 'dry_run' : 'running';
    console.log('\n[DM] Opening Instagram Direct Messages (/direct/inbox/)...');
    await this.hooks.syncHud(hudMode, 'Direct Inbox', 'Opening DM inbox...');

    await page.goto('https://www.instagram.com/direct/inbox/', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await sleep(3000);
    await this.hooks.dismissCommonPopups(page);

    try {
      await page.waitForSelector(
        'div[role="listitem"], a[href^="/direct/t/"], div[aria-label*="Thread"]',
        { timeout: 8000 },
      );
    } catch {
      // Proceed to fallback evaluation
    }

    const threadCount = await this.tagCandidateThreads(page);
    if (threadCount === 0) {
      console.log('[DM] No conversation threads found in inbox.');
      return;
    }

    const limit = Math.min(threadCount, this.config.maxDmThreadsToCheck);
    console.log(
      `[DM] Scanning top ${limit} thread(s) for incoming Reels and Posts...`,
    );

    for (let idx = 0; idx < limit; idx++) {
      await this.hooks.waitWhilePaused();
      if (this.hooks.isStopped()) break;

      await this.tagCandidateThreads(page);

      const threadMeta = await page.evaluate((targetIdx: number) => {
        const el = document.querySelector<HTMLElement>(
          `[data-ig-agent-dm-thread="${targetIdx}"]`,
        );
        if (!el) return null;
        const lines = (el.innerText || '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        return {
          title: lines[0] || `Thread #${targetIdx + 1}`,
          snippet: lines.slice(1).join(' ') || '',
        };
      }, idx);

      if (!threadMeta) continue;

      const cleanTitle = threadMeta.title.replace(/^Unread\s+/i, '').trim();
      if (this.config.skipUsers.has(cleanTitle.toLowerCase())) {
        console.log(`[DM: ${cleanTitle}] Skipped (in skip list)`);
        continue;
      }

      try {
        const threadLocator = page
          .locator(`[data-ig-agent-dm-thread="${idx}"]`)
          .first();
        await threadLocator.scrollIntoViewIfNeeded({ timeout: 2000 });
        await threadLocator.click({ timeout: 3000 });
      } catch {
        continue;
      }

      this.stats.dmThreadsChecked++;
      await this.hooks.syncHud(
        hudMode,
        cleanTitle,
        `Checking DMs with ${cleanTitle}...`,
      );
      await sleep(randomInt(1800, 2600));

      await this.processOpenThreadMessages(page, cleanTitle);
    }
  }

  private async tagCandidateThreads(page: Page): Promise<number> {
    return await page.evaluate(() => {
      document
        .querySelectorAll('[data-ig-agent-dm-thread]')
        .forEach((el) => el.removeAttribute('data-ig-agent-dm-thread'));

      const rawCandidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          'div[role="listitem"], a[href^="/direct/t/"], div[role="row"], div[role="button"]',
        ),
      ).filter((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.left < 0 || rect.left > 420) return false;
        if (rect.top < 80 || rect.width < 180) return false;
        if (rect.height < 48 || rect.height > 115) return false;
        const text = (el.innerText || '').trim();
        if (!text || text === 'Primary' || text === 'General' || text === 'Requests') {
          return false;
        }
        return true;
      });

      const uniqueThreads: HTMLElement[] = [];
      for (const candidate of rawCandidates) {
        const rect = candidate.getBoundingClientRect();
        const overlapsExisting = uniqueThreads.some((existing) => {
          const r2 = existing.getBoundingClientRect();
          return Math.abs(r2.top - rect.top) < 28;
        });
        if (!overlapsExisting) {
          uniqueThreads.push(candidate);
        }
      }

      uniqueThreads.sort((a, b) => {
        const score = (el: HTMLElement): number => {
          const text = (el.innerText || '').toLowerCase();
          const hasMediaSnippet =
            text.includes('sent a reel') ||
            text.includes('sent a post') ||
            text.includes('sent an attachment') ||
            text.includes('shared a reel') ||
            text.includes('shared a post');
          const hasUnread =
            text.includes('unread') ||
            Boolean(el.querySelector('[aria-label*="Unread"]'));
          return (hasMediaSnippet ? 2 : 0) + (hasUnread ? 1 : 0);
        };
        return score(b) - score(a);
      });

      uniqueThreads.forEach((el, idx) => {
        el.setAttribute('data-ig-agent-dm-thread', String(idx));
      });

      return uniqueThreads.length;
    });
  }

  private async processOpenThreadMessages(
    page: Page,
    threadTitle: string,
  ): Promise<void> {
    const hudMode = this.config.dryRun ? 'dry_run' : 'running';

    const candidates = await page.evaluate(
      ({ emoji, maxPerThread }) => {
        document
          .querySelectorAll('[data-ig-agent-dm-media]')
          .forEach((el) => el.removeAttribute('data-ig-agent-dm-media'));

        const results: Array<{
          index: number;
          signature: string;
          mediaType: 'Reel' | 'Post';
          alreadyHasReactionInDom: boolean;
        }> = [];

        const potentialCards = Array.from(
          document.querySelectorAll<HTMLElement>(
            'a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], div[role="button"], div[role="gridcell"]',
          ),
        ).filter((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.left < 320 || rect.top < 65 || rect.bottom > window.innerHeight - 75) {
            return false;
          }
          if (rect.width < 110 || rect.width > 420 || rect.height < 130) {
            return false;
          }
          const distanceFromRightEdge = window.innerWidth - rect.right;
          if (distanceFromRightEdge < 155) {
            return false;
          }

          const href = el.getAttribute('href') || '';
          const hasReelOrPostLink =
            href.includes('/reel/') ||
            href.includes('/reels/') ||
            href.includes('/p/') ||
            Boolean(
              el.querySelector('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"]'),
            );

          const hasMediaIcon = Boolean(
            el.querySelector(
              'svg[aria-label="Clip"], svg[aria-label="Reel"], svg[aria-label="Video"], svg[aria-label*="Carousel"], svg[aria-label*="Post"], video',
            ),
          );

          const hasPreviewImage = Boolean(
            el.querySelector('img[src*="cdninstagram"], img[src*="fbcdn"]'),
          );

          return hasReelOrPostLink || hasMediaIcon || hasPreviewImage;
        });

        const uniqueCards: HTMLElement[] = [];
        for (const card of potentialCards) {
          const r1 = card.getBoundingClientRect();
          const duplicate = uniqueCards.some((existing) => {
            const r2 = existing.getBoundingClientRect();
            return (
              Math.abs(r1.top - r2.top) < 50 && Math.abs(r1.left - r2.left) < 50
            );
          });
          if (!duplicate) {
            uniqueCards.push(card);
          }
        }

        const recentCards = uniqueCards.slice(-maxPerThread);

        recentCards.forEach((card, idx) => {
          card.setAttribute('data-ig-agent-dm-media', String(idx));

          const linkEl =
            card.tagName === 'A'
              ? card
              : card.querySelector('a[href*="/reel/"], a[href*="/p/"]');
          const href = linkEl?.getAttribute('href') || '';
          const imgEl = card.querySelector('img');
          const imgSrc = (imgEl?.getAttribute('src') || '').slice(0, 120);
          const textSnippet = (card.innerText || '').trim().slice(0, 60);

          const isReel =
            href.includes('/reel') ||
            Boolean(card.querySelector('svg[aria-label="Clip"], svg[aria-label="Reel"]'));

          const row =
            card.closest('[role="row"], [role="listitem"]') ||
            card.parentElement?.parentElement ||
            card;
          const rowText = row.textContent || '';
          const alreadyHasReactionInDom = rowText.includes(emoji);

          const signature = `${href || imgSrc || textSnippet || idx}`;
          results.push({
            index: idx,
            signature,
            mediaType: isReel ? 'Reel' : 'Post',
            alreadyHasReactionInDom,
          });
        });

        return results;
      },
      {
        emoji: this.config.dmReactionEmoji,
        maxPerThread: this.config.maxMessagesPerThread,
      },
    );

    if (candidates.length === 0) {
      console.log(`   [DM: ${threadTitle}] No incoming shared Reels or Posts in recent messages.`);
      return;
    }

    for (const item of candidates) {
      await this.hooks.waitWhilePaused();
      if (this.hooks.isStopped()) break;

      const cacheKey = `${threadTitle}::${item.signature}`;
      if (item.alreadyHasReactionInDom || this.reactedSignatures.has(cacheKey)) {
        this.stats.dmAlreadyReacted++;
        console.log(
          `   [DM: ${threadTitle}] Already reacted to ${item.mediaType}`,
        );
        continue;
      }

      const delay = randomInt(this.config.minLikeDelayMs, this.config.maxLikeDelayMs);
      await sleep(delay);

      const reacted = await this.reactToTaggedMessage(page, item.index);
      if (reacted) {
        this.stats.dmMediaReacted++;
        this.reactedSignatures.add(cacheKey);
        this.saveReactedCache();

        const prefix = this.config.dryRun ? '[DRY RUN]' : '[REACTED]';
        console.log(
          `   ${prefix} [DM: ${threadTitle}] Reacted to incoming ${item.mediaType}`,
        );
        await this.hooks.syncHud(
          hudMode,
          threadTitle,
          `Reacted to ${item.mediaType} from ${threadTitle}`,
        );
      }
    }
  }

  private async reactToTaggedMessage(
    page: Page,
    mediaIndex: number,
  ): Promise<boolean> {
    const mediaLocator = page
      .locator(`[data-ig-agent-dm-media="${mediaIndex}"]`)
      .first();

    try {
      await mediaLocator.scrollIntoViewIfNeeded({ timeout: 2500 });
      await sleep(300);

      if (this.config.dryRun) {
        await page.evaluate((idx: number) => {
          const el = document.querySelector<HTMLElement>(
            `[data-ig-agent-dm-media="${idx}"]`,
          );
          if (el) {
            el.style.outline = '3px solid #facc15';
            el.style.borderRadius = '12px';
          }
        }, mediaIndex);
        return true;
      }

      await mediaLocator.hover({ timeout: 2500 });
      await sleep(randomInt(450, 750));

      const foundReactTrigger = await page.evaluate((idx: number) => {
        document
          .querySelectorAll('[data-ig-agent-react-trigger]')
          .forEach((el) => el.removeAttribute('data-ig-agent-react-trigger'));

        const mediaEl = document.querySelector<HTMLElement>(
          `[data-ig-agent-dm-media="${idx}"]`,
        );
        if (!mediaEl) return false;
        const mediaRect = mediaEl.getBoundingClientRect();

        const triggers = Array.from(
          document.querySelectorAll<Element>(
            'svg[aria-label*="React"], svg[aria-label*="emoji"], button[aria-label*="React"], div[role="button"][aria-label*="React"], div[role="button"][aria-label*="emoji"]',
          ),
        ).filter((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 8 || rect.bottom > window.innerHeight - 85) {
            return false;
          }
          if (rect.left < 300) return false;
          return true;
        });

        if (triggers.length === 0) return false;

        triggers.sort((a, b) => {
          const distA = Math.abs(
            a.getBoundingClientRect().top - mediaRect.top,
          );
          const distB = Math.abs(
            b.getBoundingClientRect().top - mediaRect.top,
          );
          return distA - distB;
        });

        const bestTrigger = triggers[0];
        const clickable =
          bestTrigger.closest<HTMLElement>('button, [role="button"]') ||
          bestTrigger.parentElement ||
          (bestTrigger as HTMLElement);

        clickable.setAttribute('data-ig-agent-react-trigger', 'true');
        return true;
      }, mediaIndex);

      if (!foundReactTrigger) {
        return false;
      }

      await page
        .locator('[data-ig-agent-react-trigger="true"]')
        .first()
        .click({ timeout: 2500 });

      await sleep(randomInt(450, 750));

      const foundEmoji = await page.evaluate((targetEmoji: string) => {
        document
          .querySelectorAll('[data-ig-agent-emoji-btn]')
          .forEach((el) => el.removeAttribute('data-ig-agent-emoji-btn'));

        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>(
            'button, div[role="button"], span, img',
          ),
        ).filter((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 12 || rect.height < 12 || rect.width > 80) {
            return false;
          }
          const text = (el.textContent || '').trim();
          const aria = el.getAttribute('aria-label') || '';
          const alt = el.getAttribute('alt') || '';
          return (
            text === targetEmoji ||
            aria.includes(targetEmoji) ||
            alt === targetEmoji
          );
        });

        if (candidates.length === 0) return false;

        const best = candidates[0];
        const clickable =
          best.closest<HTMLElement>('button, [role="button"]') || best;
        clickable.setAttribute('data-ig-agent-emoji-btn', 'true');
        return true;
      }, this.config.dmReactionEmoji);

      if (!foundEmoji) {
        await page.keyboard.press('Escape');
        return false;
      }

      await page
        .locator('[data-ig-agent-emoji-btn="true"]')
        .first()
        .click({ timeout: 2500 });

      await sleep(500);
      return true;
    } catch {
      return false;
    }
  }
}
