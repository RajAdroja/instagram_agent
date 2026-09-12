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
}
