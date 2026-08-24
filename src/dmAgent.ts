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
}
