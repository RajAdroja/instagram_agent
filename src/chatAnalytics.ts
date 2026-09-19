import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type { AgentConfig } from './config.js';
import type { HudState } from './hud.js';
import type {
  DmMessageCategory,
  FullChatAnalyticsReport,
  ParticipantAnalytics,
  ReactionPairStat,
  RunStats,
  ThreadAnalyticsReport,
} from './types.js';
import { randomInt, sleep } from './utils.js';

interface AnalyticsHooks {
  syncHud: (
    status: HudState['status'],
    currentUser: string,
    lastAction: string,
  ) => Promise<void>;
  waitWhilePaused: () => Promise<void>;
  isStopped: () => boolean;
  dismissCommonPopups: (page: Page) => Promise<void>;
}

interface RawExtractedMessage {
  signature: string;
  sender: string;
  category: DmMessageCategory;
  text: string;
  wordCount: number;
  charCount: number;
  sharedCreator: string | null;
  reactions: Array<{
    emoji: string;
    reactor: string;
  }>;
}

function createEmptyParticipantAnalytics(participant: string): ParticipantAnalytics {
  return {
    participant,
    totalMessagesSent: 0,
    textMessagesSent: 0,
    reelsSent: 0,
    postsSent: 0,
    storyInteractionsSent: 0,
    mediaAttachmentsSent: 0,
    voiceNotesSent: 0,
    linksSent: 0,
    totalWordsSent: 0,
    totalCharactersSent: 0,
    averageWordsPerMessage: 0,
    reactionsGiven: 0,
    reactionsReceived: 0,
    reactionsReceivedOnReels: 0,
    reactionsReceivedOnPosts: 0,
    reactionsReceivedOnText: 0,
    reelReactionRatePct: 0,
  };
}

function escapeCsvCell(value: string | number): string {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export class InstagramChatAnalyticsExtractor {
  private config: AgentConfig;
  private stats: RunStats;
  private hooks: AnalyticsHooks;

  constructor(config: AgentConfig, stats: RunStats, hooks: AnalyticsHooks) {
    this.config = config;
    this.stats = stats;
    this.hooks = hooks;
  }

  private async scrollMessagePaneUp(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
      const allDivs = Array.from(document.querySelectorAll<HTMLElement>('div'));
      const scrollables = allDivs.filter((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.left < 300 || rect.width < 300 || rect.height < 250) return false;
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        return (
          (overflowY === 'auto' || overflowY === 'scroll') &&
          el.scrollHeight > el.clientHeight + 20
        );
      });

      if (scrollables.length === 0) return false;

      scrollables.sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth);
      const container = scrollables[0];
      const prevTop = container.scrollTop;
      container.scrollTop = Math.max(0, container.scrollTop - container.clientHeight * 0.85);
      return container.scrollTop !== prevTop;
    });
  }

  private async harvestVisibleMessagesInDom(
    page: Page,
    threadTitle: string,
  ): Promise<RawExtractedMessage[]> {
    return await page.evaluate((defaultOtherUser: string) => {
      const results: RawExtractedMessage[] = [];

      const rawRows = Array.from(
        document.querySelectorAll<HTMLElement>(
          'div[role="row"], div[role="listitem"], div[role="gridcell"]',
        ),
      ).filter((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.left < 310 || rect.top < 60 || rect.bottom > window.innerHeight - 60) {
          return false;
        }
        if (rect.height < 22 || rect.width < 40) return false;
        return true;
      });

      const messageRows: HTMLElement[] = [];
      for (const row of rawRows) {
        const r1 = row.getBoundingClientRect();
        const isNestedDuplicate = messageRows.some((existing) => {
          const r2 = existing.getBoundingClientRect();
          return Math.abs(r1.top - r2.top) < 18 && Math.abs(r1.height - r2.height) < 28;
        });
        if (!isNestedDuplicate) {
          messageRows.push(row);
        }
      }

      for (const row of messageRows) {
        const innerBubbles = Array.from(
          row.querySelectorAll<HTMLElement>('a[href*="/reel/"], a[href*="/p/"], div[dir="auto"], img, video, audio'),
        ).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 16 && r.height > 14;
        });

        let minLeft = window.innerWidth;
        let maxRight = 0;

        if (innerBubbles.length > 0) {
          for (const b of innerBubbles) {
            const r = b.getBoundingClientRect();
            if (r.left < minLeft) minLeft = r.left;
            if (r.right > maxRight) maxRight = r.right;
          }
        } else {
          const r = row.getBoundingClientRect();
          minLeft = r.left;
          maxRight = r.right;
        }

        const distanceFromRight = window.innerWidth - maxRight;
        const isSentByYou = distanceFromRight < 150 && minLeft > 520;

        let sender = isSentByYou ? 'You' : defaultOtherUser;
        if (!isSentByYou) {
          const avatarImg = row.querySelector<HTMLImageElement>('img[alt*="profile"], img[alt]');
          const altText = (avatarImg?.getAttribute('alt') || '').trim();
          if (altText && !altText.toLowerCase().includes('photo') && altText.length < 40) {
            sender = altText.replace(/'s profile picture$/i, '').trim() || defaultOtherUser;
          }
        }

        const reelLink = row.querySelector<HTMLAnchorElement>(
          'a[href*="/reel/"], a[href*="/reels/"]',
        );
        const postLink = row.querySelector<HTMLAnchorElement>('a[href*="/p/"]');
        const storyLink = row.querySelector<HTMLAnchorElement>('a[href*="/stories/"]');

        const hasReelIcon = Boolean(
          row.querySelector('svg[aria-label="Clip"], svg[aria-label="Reel"]'),
        );
        const hasPostIcon = Boolean(
          row.querySelector('svg[aria-label*="Carousel"], svg[aria-label*="Post"]'),
        );
        const hasVoiceNote = Boolean(
          row.querySelector('audio, svg[aria-label*="Voice"], svg[aria-label*="Audio"]'),
        );
        const hasMediaPreview = Boolean(
          row.querySelector('video, img[src*="cdninstagram"], img[src*="fbcdn"]'),
        );

        const rawText = (row.innerText || '').trim();
        const lowerText = rawText.toLowerCase();

        let category: DmMessageCategory = 'text';
        if (reelLink || hasReelIcon || lowerText.includes('sent a reel')) {
          category = 'reel';
        } else if (postLink || hasPostIcon || lowerText.includes('sent a post')) {
          category = 'post';
        } else if (
          storyLink ||
          lowerText.includes('replied to your story') ||
          lowerText.includes('replied to their story') ||
          lowerText.includes('mentioned you in their story')
        ) {
          category = 'story_interaction';
        } else if (hasVoiceNote) {
          category = 'voice_note';
        } else if (hasMediaPreview && rawText.length < 40) {
          category = 'media_attachment';
        } else if (/https?:\/\/(?!www\.instagram\.com)/i.test(rawText)) {
          category = 'link';
        }

        let sharedCreator: string | null = null;
        if (category === 'reel' || category === 'post') {
          const lines = rawText
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 1 && l.length < 32 && !l.includes(' '));
          if (lines.length > 0) {
            sharedCreator = lines[0].replace(/^@/, '');
          }
        }

        const cleanText =
          category === 'text' || category === 'link' || category === 'story_interaction'
            ? rawText
            : '';
        const words = cleanText
          ? cleanText.split(/\s+/).filter(Boolean).length
          : 0;
        const chars = cleanText.length;

        const reactions: Array<{ emoji: string; reactor: string }> = [];
        const reactionNodes = Array.from(
          row.querySelectorAll<HTMLElement>(
            '[aria-label*="Reaction"], [aria-label*="reaction"], [role="button"] span, img[alt]',
          ),
        );

        for (const node of reactionNodes) {
          const txt = (node.textContent || node.getAttribute('alt') || '').trim();
          if (
            txt.length >= 1 &&
            txt.length <= 8 &&
            /[^\x00-\x7F]/.test(txt) &&
            !/[a-zA-Z0-9]/.test(txt)
          ) {
            const inferredReactor = isSentByYou ? defaultOtherUser : 'You';
            if (!reactions.some((r) => r.emoji === txt && r.reactor === inferredReactor)) {
              reactions.push({
                emoji: txt,
                reactor: inferredReactor,
              });
            }
          }
        }

        const mediaHref =
          reelLink?.getAttribute('href') ||
          postLink?.getAttribute('href') ||
          storyLink?.getAttribute('href') ||
          '';
        const firstImgSrc = (
          row.querySelector('img')?.getAttribute('src') || ''
        ).slice(0, 90);

        if (!rawText && !mediaHref && !firstImgSrc && category === 'text') {
          continue;
        }

        const signature = `${sender}::${category}::${mediaHref || firstImgSrc}::${rawText.slice(0, 100)}`;

        results.push({
          signature,
          sender,
          category,
          text: cleanText,
          wordCount: words,
          charCount: chars,
          sharedCreator,
          reactions,
        });
      }

      return results;
    }, threadTitle);
  }
}
