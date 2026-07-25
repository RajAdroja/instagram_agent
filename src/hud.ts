import type { Page } from 'playwright';

export interface HudState {
  status: 'starting' | 'waiting_login' | 'running' | 'paused' | 'dry_run' | 'stopped' | 'completed';
  currentUser: string;
  likedCount: number;
  alreadyLikedCount: number;
  slidesViewed: number;
  usersVisited: number;
  dmReactedCount: number;
  maxLikes: number;
  lastAction: string;
}

export interface HudCallbacks {
  onTogglePause: () => boolean;
  onStop: () => void;
}

export async function setupHud(page: Page, callbacks: HudCallbacks): Promise<void> {
  try {
    await page.exposeFunction('__igAgentTogglePause', () => {
      return callbacks.onTogglePause();
    });
    await page.exposeFunction('__igAgentStop', () => {
      callbacks.onStop();
    });
  } catch {
    // Functions may already be exposed on this page context
  }
}
