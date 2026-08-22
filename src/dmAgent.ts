import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type { AgentConfig } from './config.js';
import type { HudState } from './hud.js';
import type { RunStats } from './types.js';

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
}
