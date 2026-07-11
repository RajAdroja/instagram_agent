import type { StorySlideInfo } from './types.js';

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseStoryUrl(url: string): StorySlideInfo | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] === 'stories' && parts[1]) {
      return {
        username: parts[1],
        storyId: parts[2] || 'root',
      };
    }
  } catch {
    // Ignore invalid URLs
  }
  return null;
}
