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
