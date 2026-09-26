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

  public async extractAllChatsAnalytics(
    page: Page,
  ): Promise<FullChatAnalyticsReport> {
    const hudMode = this.config.dryRun ? 'dry_run' : 'running';
    console.log('\n[Analytics] Opening Instagram Direct Messages (/direct/inbox/) for data extraction...');
    await this.hooks.syncHud(hudMode, 'DM Analytics', 'Opening inbox for analytics...');

    if (!page.url().includes('/direct/')) {
      await page.goto('https://www.instagram.com/direct/inbox/', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await sleep(3000);
    }
    await this.hooks.dismissCommonPopups(page);

    try {
      await page.waitForSelector(
        'div[role="listitem"], a[href^="/direct/t/"], div[aria-label*="Thread"]',
        { timeout: 8000 },
      );
    } catch {
      // Fallback evaluation will handle thread discovery
    }

    const totalAvailableThreads = await this.tagSidebarThreads(page);
    const threadsToScan = Math.min(
      totalAvailableThreads,
      this.config.maxDmThreadsToCheck,
    );

    console.log(
      `[Analytics] Found ${totalAvailableThreads} visible thread(s); extracting data from top ${threadsToScan} thread(s) (${this.config.analyticsScrollPasses} scroll pass(es) per thread)...`,
    );

    const threadReports: ThreadAnalyticsReport[] = [];

    for (let idx = 0; idx < threadsToScan; idx++) {
      await this.hooks.waitWhilePaused();
      if (this.hooks.isStopped()) break;

      await this.tagSidebarThreads(page);

      const threadMeta = await page.evaluate((targetIdx: number) => {
        const el = document.querySelector<HTMLElement>(
          `[data-ig-agent-analytics-thread="${targetIdx}"]`,
        );
        if (!el) return null;
        const lines = (el.innerText || '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        return {
          title: (lines[0] || `Thread_${targetIdx + 1}`).replace(/^Unread\s+/i, '').trim(),
        };
      }, idx);

      if (!threadMeta) continue;

      if (this.config.skipUsers.has(threadMeta.title.toLowerCase())) {
        console.log(`[Analytics] Skipping thread "${threadMeta.title}" (in skip list)`);
        continue;
      }

      try {
        const locator = page
          .locator(`[data-ig-agent-analytics-thread="${idx}"]`)
          .first();
        await locator.scrollIntoViewIfNeeded({ timeout: 2000 });
        await locator.click({ timeout: 3000 });
      } catch {
        continue;
      }

      await sleep(randomInt(1800, 2600));
      const threadReport = await this.analyzeCurrentOpenThread(
        page,
        threadMeta.title,
      );
      threadReports.push(threadReport);
      this.stats.analyticsThreadsExtracted++;
      this.stats.analyticsMessagesExtracted += threadReport.totalMessagesAnalyzed;
    }

    const fullReport = this.buildFullReport(threadReports);
    const savedPaths = this.writeReportsToDisk(fullReport);
    this.stats.analyticsReportPath = savedPaths.markdownPath;

    this.printConsoleSummary(fullReport, savedPaths);
    return fullReport;
  }

  private async tagSidebarThreads(page: Page): Promise<number> {
    return await page.evaluate(() => {
      document
        .querySelectorAll('[data-ig-agent-analytics-thread]')
        .forEach((el) => el.removeAttribute('data-ig-agent-analytics-thread'));

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
        const overlaps = uniqueThreads.some((existing) => {
          const r2 = existing.getBoundingClientRect();
          return Math.abs(r2.top - rect.top) < 28;
        });
        if (!overlaps) {
          uniqueThreads.push(candidate);
        }
      }

      uniqueThreads.forEach((el, idx) => {
        el.setAttribute('data-ig-agent-analytics-thread', String(idx));
      });

      return uniqueThreads.length;
    });
  }

  private async analyzeCurrentOpenThread(
    page: Page,
    threadTitle: string,
  ): Promise<ThreadAnalyticsReport> {
    const hudMode = this.config.dryRun ? 'dry_run' : 'running';
    const urlParts = page.url().split('/').filter(Boolean);
    const threadId = urlParts[urlParts.indexOf('t') + 1] || threadTitle;

    console.log(`[Analytics] Analyzing conversation: "${threadTitle}"...`);

    const collectedMessages = new Map<string, RawExtractedMessage>();
    const scrollPasses = Math.max(1, this.config.analyticsScrollPasses);

    for (let pass = 1; pass <= scrollPasses; pass++) {
      await this.hooks.waitWhilePaused();
      if (this.hooks.isStopped()) break;

      await this.hooks.syncHud(
        hudMode,
        threadTitle,
        `Extracting messages (pass ${pass}/${scrollPasses})...`,
      );

      const batch = await this.harvestVisibleMessagesInDom(page, threadTitle);
      let newInPass = 0;
      for (const msg of batch) {
        if (!collectedMessages.has(msg.signature)) {
          collectedMessages.set(msg.signature, msg);
          newInPass++;
        } else {
          const prev = collectedMessages.get(msg.signature)!;
          if (msg.reactions.length > prev.reactions.length) {
            collectedMessages.set(msg.signature, msg);
          }
        }
      }

      if (pass < scrollPasses) {
        const scrolledUp = await this.scrollMessagePaneUp(page);
        if (!scrolledUp && newInPass === 0) {
          break;
        }
        await sleep(randomInt(900, 1400));
      }
    }

    const allMessages = Array.from(collectedMessages.values());
    return this.aggregateThreadMessages(threadId, threadTitle, allMessages);
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

  private aggregateThreadMessages(
    threadId: string,
    threadTitle: string,
    messages: RawExtractedMessage[],
  ): ThreadAnalyticsReport {
    const participants: Record<string, ParticipantAnalytics> = {};
    const pairMap = new Map<string, ReactionPairStat>();
    const creatorCounts = new Map<string, number>();

    const ensureParticipant = (name: string): ParticipantAnalytics => {
      if (!participants[name]) {
        participants[name] = createEmptyParticipantAnalytics(name);
      }
      return participants[name];
    };

    ensureParticipant('You');
    ensureParticipant(threadTitle);

    let totalReelsShared = 0;
    let totalPostsShared = 0;
    let totalReactionsLogged = 0;

    for (const msg of messages) {
      const senderStats = ensureParticipant(msg.sender);
      senderStats.totalMessagesSent++;

      switch (msg.category) {
        case 'reel':
          senderStats.reelsSent++;
          totalReelsShared++;
          break;
        case 'post':
          senderStats.postsSent++;
          totalPostsShared++;
          break;
        case 'story_interaction':
          senderStats.storyInteractionsSent++;
          break;
        case 'media_attachment':
          senderStats.mediaAttachmentsSent++;
          break;
        case 'voice_note':
          senderStats.voiceNotesSent++;
          break;
        case 'link':
          senderStats.linksSent++;
          senderStats.totalWordsSent += msg.wordCount;
          senderStats.totalCharactersSent += msg.charCount;
          break;
        case 'text':
          senderStats.textMessagesSent++;
          senderStats.totalWordsSent += msg.wordCount;
          senderStats.totalCharactersSent += msg.charCount;
          break;
      }

      if (msg.sharedCreator) {
        creatorCounts.set(
          msg.sharedCreator,
          (creatorCounts.get(msg.sharedCreator) || 0) + 1,
        );
      }

      for (const reaction of msg.reactions) {
        totalReactionsLogged++;
        const reactorStats = ensureParticipant(reaction.reactor);
        reactorStats.reactionsGiven++;
        senderStats.reactionsReceived++;

        if (msg.category === 'reel') {
          senderStats.reactionsReceivedOnReels++;
        } else if (msg.category === 'post') {
          senderStats.reactionsReceivedOnPosts++;
        } else {
          senderStats.reactionsReceivedOnText++;
        }

        const pairKey = `${reaction.reactor}>>>${msg.sender}`;
        if (!pairMap.has(pairKey)) {
          pairMap.set(pairKey, {
            reactor: reaction.reactor,
            messageAuthor: msg.sender,
            threadTitle,
            totalReactions: 0,
            onReels: 0,
            onPosts: 0,
            onTextOrOther: 0,
            reactionCountsByType: {},
          });
        }

        const pair = pairMap.get(pairKey)!;
        pair.totalReactions++;
        if (msg.category === 'reel') {
          pair.onReels++;
        } else if (msg.category === 'post') {
          pair.onPosts++;
        } else {
          pair.onTextOrOther++;
        }
        pair.reactionCountsByType[reaction.emoji] =
          (pair.reactionCountsByType[reaction.emoji] || 0) + 1;
      }
    }

    for (const p of Object.values(participants)) {
      const textMsgCount = Math.max(1, p.textMessagesSent + p.linksSent);
      p.averageWordsPerMessage =
        p.totalWordsSent > 0
          ? Number((p.totalWordsSent / textMsgCount).toFixed(1))
          : 0;
      p.reelReactionRatePct =
        p.reelsSent > 0
          ? Number(((p.reactionsReceivedOnReels / p.reelsSent) * 100).toFixed(1))
          : 0;
    }

    const participantList = Object.values(participants);
    const pickTop = (
      selector: (p: ParticipantAnalytics) => number,
    ): string | null => {
      const sorted = [...participantList].sort((a, b) => selector(b) - selector(a));
      return sorted[0] && selector(sorted[0]) > 0 ? sorted[0].participant : null;
    };

    const mostSharedCreators = Array.from(creatorCounts.entries())
      .map(([creator, count]) => ({ creator, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      threadId,
      threadTitle,
      isGroupChat: Object.keys(participants).length > 2,
      totalMessagesAnalyzed: messages.length,
      totalReelsShared,
      totalPostsShared,
      totalReactionsLogged,
      topReelSender: pickTop((p) => p.reelsSent),
      topPostSender: pickTop((p) => p.postsSent),
      topMessageSender: pickTop((p) => p.totalMessagesSent),
      mostSharedCreators,
      participants,
      whoReactedToWhom: Array.from(pairMap.values()).sort(
        (a, b) => b.totalReactions - a.totalReactions,
      ),
    };
  }

  private buildFullReport(
    threads: ThreadAnalyticsReport[],
  ): FullChatAnalyticsReport {
    const globalParticipants: Record<string, ParticipantAnalytics> = {};
    const globalPairs: ReactionPairStat[] = [];

    const ensureGlobalParticipant = (name: string): ParticipantAnalytics => {
      if (!globalParticipants[name]) {
        globalParticipants[name] = createEmptyParticipantAnalytics(name);
      }
      return globalParticipants[name];
    };

    let totalMessagesAnalyzed = 0;
    let totalReelsShared = 0;
    let totalPostsShared = 0;
    let totalReactionsLogged = 0;

    for (const t of threads) {
      totalMessagesAnalyzed += t.totalMessagesAnalyzed;
      totalReelsShared += t.totalReelsShared;
      totalPostsShared += t.totalPostsShared;
      totalReactionsLogged += t.totalReactionsLogged;

      for (const p of Object.values(t.participants)) {
        const gp = ensureGlobalParticipant(p.participant);
        gp.totalMessagesSent += p.totalMessagesSent;
        gp.textMessagesSent += p.textMessagesSent;
        gp.reelsSent += p.reelsSent;
        gp.postsSent += p.postsSent;
        gp.storyInteractionsSent += p.storyInteractionsSent;
        gp.mediaAttachmentsSent += p.mediaAttachmentsSent;
        gp.voiceNotesSent += p.voiceNotesSent;
        gp.linksSent += p.linksSent;
        gp.totalWordsSent += p.totalWordsSent;
        gp.totalCharactersSent += p.totalCharactersSent;
        gp.reactionsGiven += p.reactionsGiven;
        gp.reactionsReceived += p.reactionsReceived;
        gp.reactionsReceivedOnReels += p.reactionsReceivedOnReels;
        gp.reactionsReceivedOnPosts += p.reactionsReceivedOnPosts;
        gp.reactionsReceivedOnText += p.reactionsReceivedOnText;
      }

      for (const pair of t.whoReactedToWhom) {
        globalPairs.push(pair);
      }
    }

    for (const gp of Object.values(globalParticipants)) {
      const textCount = Math.max(1, gp.textMessagesSent + gp.linksSent);
      gp.averageWordsPerMessage =
        gp.totalWordsSent > 0
          ? Number((gp.totalWordsSent / textCount).toFixed(1))
          : 0;
      gp.reelReactionRatePct =
        gp.reelsSent > 0
          ? Number(((gp.reactionsReceivedOnReels / gp.reelsSent) * 100).toFixed(1))
          : 0;
    }

    const allParticipants = Object.values(globalParticipants);
    const buildLeaderboard = (
      selector: (p: ParticipantAnalytics) => number,
    ): Array<{ participant: string; count: number }> =>
      allParticipants
        .map((p) => ({ participant: p.participant, count: selector(p) }))
        .filter((x) => x.count > 0)
        .sort((a, b) => b.count - a.count);

    return {
      generatedAt: new Date().toISOString(),
      threadsAnalyzed: threads.length,
      totalMessagesAnalyzed,
      totalReelsShared,
      totalPostsShared,
      totalReactionsLogged,
      globalLeaderboards: {
        topReelSenders: buildLeaderboard((p) => p.reelsSent),
        topPostSenders: buildLeaderboard((p) => p.postsSent),
        topMessageSenders: buildLeaderboard((p) => p.totalMessagesSent),
        topReactors: buildLeaderboard((p) => p.reactionsGiven),
        mostReactedToUsers: buildLeaderboard((p) => p.reactionsReceived),
      },
      globalWhoReactedToWhom: globalPairs.sort(
        (a, b) => b.totalReactions - a.totalReactions,
      ),
      globalParticipants,
      threads,
    };
  }

  private writeReportsToDisk(report: FullChatAnalyticsReport): {
    jsonPath: string;
    participantsCsvPath: string;
    reactionsCsvPath: string;
    markdownPath: string;
  } {
    const outDir = path.resolve(process.cwd(), this.config.analyticsOutputDir);
    fs.mkdirSync(outDir, { recursive: true });

    const jsonPath = path.join(outDir, 'chat-analytics-report.json');
    const participantsCsvPath = path.join(outDir, 'participant-stats.csv');
    const reactionsCsvPath = path.join(outDir, 'who-reacted-to-whom.csv');
    const markdownPath = path.join(outDir, 'chat-summary.md');

    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

    const participantHeaders = [
      'Thread',
      'Participant',
      'Total Messages Sent',
      'Reels Sent',
      'Posts Sent',
      'Text Messages Sent',
      'Story Interactions',
      'Media Attachments',
      'Voice Notes',
      'Links Sent',
      'Total Words',
      'Avg Words/Message',
      'Reactions Given',
      'Reactions Received',
      'Reactions on Reels',
      'Reactions on Posts',
      'Reel Reaction Rate (%)',
    ];
    const participantRows: string[] = [participantHeaders.join(',')];

    for (const t of report.threads) {
      for (const p of Object.values(t.participants)) {
        participantRows.push(
          [
            escapeCsvCell(t.threadTitle),
            escapeCsvCell(p.participant),
            p.totalMessagesSent,
            p.reelsSent,
            p.postsSent,
            p.textMessagesSent,
            p.storyInteractionsSent,
            p.mediaAttachmentsSent,
            p.voiceNotesSent,
            p.linksSent,
            p.totalWordsSent,
            p.averageWordsPerMessage,
            p.reactionsGiven,
            p.reactionsReceived,
            p.reactionsReceivedOnReels,
            p.reactionsReceivedOnPosts,
            p.reelReactionRatePct,
          ].join(','),
        );
      }
    }
    fs.writeFileSync(participantsCsvPath, participantRows.join('\n') + '\n', 'utf8');

    const reactionHeaders = [
      'Thread',
      'Reactor',
      'Message Author',
      'Total Reactions',
      'On Reels',
      'On Posts',
      'On Text/Other',
    ];
    const reactionRows: string[] = [reactionHeaders.join(',')];
    for (const pair of report.globalWhoReactedToWhom) {
      reactionRows.push(
        [
          escapeCsvCell(pair.threadTitle),
          escapeCsvCell(pair.reactor),
          escapeCsvCell(pair.messageAuthor),
          pair.totalReactions,
          pair.onReels,
          pair.onPosts,
          pair.onTextOrOther,
        ].join(','),
      );
    }
    fs.writeFileSync(reactionsCsvPath, reactionRows.join('\n') + '\n', 'utf8');

    const mdLines: string[] = [
      '# Instagram Direct Message Analytics Report',
      '',
      `- **Generated At**: ${report.generatedAt}`,
      `- **Threads Analyzed**: ${report.threadsAnalyzed}`,
      `- **Total Messages Analyzed**: ${report.totalMessagesAnalyzed}`,
      `- **Total Reels Shared**: ${report.totalReelsShared}`,
      `- **Total Posts Shared**: ${report.totalPostsShared}`,
      `- **Total Reactions Logged**: ${report.totalReactionsLogged}`,
      '',
      '## Global Participant Breakdown',
      '',
      '| Participant | Total Messages | Reels Sent | Posts Sent | Text Messages | Words Sent | Reactions Given | Reactions Received | Reel Reaction Rate |',
      '| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ];

    for (const p of Object.values(report.globalParticipants).sort(
      (a, b) => b.totalMessagesSent - a.totalMessagesSent,
    )) {
      mdLines.push(
        `| ${p.participant} | ${p.totalMessagesSent} | ${p.reelsSent} | ${p.postsSent} | ${p.textMessagesSent} | ${p.totalWordsSent} | ${p.reactionsGiven} | ${p.reactionsReceived} | ${p.reelReactionRatePct}% |`,
      );
    }

    mdLines.push(
      '',
      '## Who Reacted to Whose Messages',
      '',
      '| Thread | Reactor | Message Author | Total Reactions | On Reels | On Posts | On Text/Other |',
      '| :--- | :--- | :--- | ---: | ---: | ---: | ---: |',
    );

    if (report.globalWhoReactedToWhom.length === 0) {
      mdLines.push('| - | - | - | 0 | 0 | 0 | 0 |');
    } else {
      for (const pair of report.globalWhoReactedToWhom) {
        mdLines.push(
          `| ${pair.threadTitle} | ${pair.reactor} | ${pair.messageAuthor} | ${pair.totalReactions} | ${pair.onReels} | ${pair.onPosts} | ${pair.onTextOrOther} |`,
        );
      }
    }

    mdLines.push('', '## Per-Thread Breakdown', '');
    for (const t of report.threads) {
      mdLines.push(
        `### ${t.threadTitle}`,
        `- **Messages Analyzed**: ${t.totalMessagesAnalyzed} | **Reels Shared**: ${t.totalReelsShared} | **Posts Shared**: ${t.totalPostsShared} | **Reactions**: ${t.totalReactionsLogged}`,
        `- **Top Reel Sender**: ${t.topReelSender || 'N/A'} | **Top Post Sender**: ${t.topPostSender || 'N/A'} | **Top Message Sender**: ${t.topMessageSender || 'N/A'}`,
        '',
        '| Participant | Messages | Reels | Posts | Text | Words | Avg Words/Msg | Reactions Given | Reactions Received |',
        '| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      );
      for (const p of Object.values(t.participants)) {
        mdLines.push(
          `| ${p.participant} | ${p.totalMessagesSent} | ${p.reelsSent} | ${p.postsSent} | ${p.textMessagesSent} | ${p.totalWordsSent} | ${p.averageWordsPerMessage} | ${p.reactionsGiven} | ${p.reactionsReceived} |`,
        );
      }
      mdLines.push('');
    }

    fs.writeFileSync(markdownPath, mdLines.join('\n') + '\n', 'utf8');

    return {
      jsonPath,
      participantsCsvPath,
      reactionsCsvPath,
      markdownPath,
    };
  }

  private printConsoleSummary(
    report: FullChatAnalyticsReport,
    savedPaths: {
      jsonPath: string;
      participantsCsvPath: string;
      reactionsCsvPath: string;
      markdownPath: string;
    },
  ): void {
    console.log('\n====================================================');
    console.log('DM Chat Analytics Summary');
    console.log('====================================================');
    console.log(`Threads Analyzed:        ${report.threadsAnalyzed}`);
    console.log(`Total Messages Analyzed: ${report.totalMessagesAnalyzed}`);
    console.log(`Total Reels Shared:      ${report.totalReelsShared}`);
    console.log(`Total Posts Shared:      ${report.totalPostsShared}`);
    console.log(`Total Reactions Found:   ${report.totalReactionsLogged}`);

    console.log('\n--- Per-Participant Totals ---');
    for (const p of Object.values(report.globalParticipants).sort(
      (a, b) => b.totalMessagesSent - a.totalMessagesSent,
    )) {
      console.log(
        `  ${p.participant.padEnd(20)} | Msgs: ${String(p.totalMessagesSent).padStart(4)} | Reels: ${String(p.reelsSent).padStart(3)} | Posts: ${String(p.postsSent).padStart(3)} | Words: ${String(p.totalWordsSent).padStart(5)} | Reacts Given: ${String(p.reactionsGiven).padStart(3)} | Reacts Rcvd: ${String(p.reactionsReceived).padStart(3)}`,
      );
    }

    if (report.globalWhoReactedToWhom.length > 0) {
      console.log('\n--- Who Reacted to Whose Messages ---');
      for (const pair of report.globalWhoReactedToWhom) {
        console.log(
          `  [${pair.threadTitle}] ${pair.reactor} -> ${pair.messageAuthor}: ${pair.totalReactions} total (${pair.onReels} on reels, ${pair.onPosts} on posts, ${pair.onTextOrOther} on text)`,
        );
      }
    }

    console.log('\n--- Exported Files ---');
    console.log(`  JSON Report:      ${savedPaths.jsonPath}`);
    console.log(`  Participant CSV:  ${savedPaths.participantsCsvPath}`);
    console.log(`  Reactions CSV:    ${savedPaths.reactionsCsvPath}`);
    console.log(`  Markdown Summary: ${savedPaths.markdownPath}`);
    console.log('====================================================\n');
  }
}
