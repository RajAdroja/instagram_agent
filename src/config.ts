import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

const DEFAULT_LAUGH_REACTION = '\u{1F602}';

export interface AgentConfig {
  igUsername?: string;
  igPassword?: string;
  minLikeDelayMs: number;
  maxLikeDelayMs: number;
  minNextDelayMs: number;
  maxNextDelayMs: number;
  maxLikesPerRun: number;
  maxSlidesPerRun: number;
  skipUsers: Set<string>;
  includeSeenStories: boolean;
  enableStories: boolean;
  enableDmReactions: boolean;
  enableChatAnalytics: boolean;
  dmReactionEmoji: string;
  maxDmThreadsToCheck: number;
  maxMessagesPerThread: number;
  analyticsScrollPasses: number;
  analyticsOutputDir: string;
  dmWatchMode: boolean;
  dmWatchIntervalSec: number;
  dryRun: boolean;
  loginOnly: boolean;
  userDataDir: string;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['true', '1', 'yes', 'y'].includes(value.trim().toLowerCase());
}

export function loadConfig(argv: string[] = process.argv.slice(2)): AgentConfig {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`
Instagram Story Liker, DM Reaction, and Chat Analytics Agent
Usage:
  npm start [options]

Options:
  --stories-only          Only like stories in the feed tray
  --dm-only               Only react to Reels and Posts in DMs
  --analytics-only        Only extract DM chat analytics (messages, reels, posts, reactions)
  --analytics             Also run DM chat analytics extraction during the run
  --scroll-passes=<num>   Upward scroll passes per DM thread for analytics (default: 12)
  --watch                 Keep running and periodically check DMs for new Reels and Posts
  --max-threads=<number>  Number of recent DM threads to scan (default: 10)
  --dry-run               Simulate actions without clicking Like or reacting
  --login-only            Open browser to log in and save session, then exit
  --include-seen          Also open stories in the tray that were already seen
  --max-likes=<number>    Stop after liking <number> story slides (0 = unlimited)
  --skip=<u1,u2>          Comma-separated usernames to skip
  -h, --help              Show this help message
`);
    process.exit(0);
  }

  const dryRunFlag = argv.includes('--dry-run');
  const loginOnlyFlag = argv.includes('--login-only');
  const includeSeenFlag = argv.includes('--include-seen');
  const storiesOnlyFlag = argv.includes('--stories-only');
  const dmOnlyFlag = argv.includes('--dm-only');
  const analyticsOnlyFlag = argv.includes('--analytics-only');
  const analyticsFlag = argv.includes('--analytics');
  const watchFlag = argv.includes('--watch');

  const maxLikesArg = argv.find((a) => a.startsWith('--max-likes='))?.split('=')[1];
  const maxThreadsArg = argv.find((a) => a.startsWith('--max-threads='))?.split('=')[1];
  const scrollPassesArg = argv.find((a) => a.startsWith('--scroll-passes='))?.split('=')[1];
  const emojiArg = argv.find((a) => a.startsWith('--emoji='))?.split('=')[1];
  const skipArg = argv.find((a) => a.startsWith('--skip='))?.split('=')[1];

  const rawSkip = [process.env.SKIP_USERS || '', skipArg || '']
    .join(',')
    .split(',')
    .map((u) => u.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean);

  const minLikeDelayMs = parseNumber(process.env.MIN_LIKE_DELAY_MS, 1200);
  const maxLikeDelayMs = Math.max(
    minLikeDelayMs,
    parseNumber(process.env.MAX_LIKE_DELAY_MS, 2800),
  );

  const minNextDelayMs = parseNumber(process.env.MIN_NEXT_DELAY_MS, 800);
  const maxNextDelayMs = Math.max(
    minNextDelayMs,
    parseNumber(process.env.MAX_NEXT_DELAY_MS, 1800),
  );

  const userDataDir = path.resolve(
    process.cwd(),
    process.env.USER_DATA_DIR || '.browser-profile',
  );

  const enableStories =
    dmOnlyFlag || analyticsOnlyFlag
      ? false
      : storiesOnlyFlag
        ? true
        : parseBoolean(process.env.ENABLE_STORIES, true);

  const enableDmReactions =
    storiesOnlyFlag || analyticsOnlyFlag
      ? false
      : dmOnlyFlag
        ? true
        : parseBoolean(process.env.ENABLE_DM_REACTIONS, true);

  const enableChatAnalytics =
    storiesOnlyFlag || dmOnlyFlag
      ? false
      : analyticsOnlyFlag || analyticsFlag
        ? true
        : parseBoolean(process.env.ENABLE_CHAT_ANALYTICS, false);

  return {
    igUsername: process.env.IG_USERNAME?.trim() || undefined,
    igPassword: process.env.IG_PASSWORD?.trim() || undefined,
    minLikeDelayMs,
    maxLikeDelayMs,
    minNextDelayMs,
    maxNextDelayMs,
    maxLikesPerRun: parseNumber(maxLikesArg ?? process.env.MAX_LIKES_PER_RUN, 250),
    maxSlidesPerRun: parseNumber(process.env.MAX_SLIDES_PER_RUN, 1000),
    skipUsers: new Set(rawSkip),
    includeSeenStories: includeSeenFlag || parseBoolean(process.env.INCLUDE_SEEN_STORIES, false),
    enableStories,
    enableDmReactions,
    enableChatAnalytics,
    dmReactionEmoji: (emojiArg || process.env.DM_REACTION_EMOJI || DEFAULT_LAUGH_REACTION).trim(),
    maxDmThreadsToCheck: parseNumber(
      maxThreadsArg ?? process.env.MAX_DM_THREADS,
      10,
    ),
    maxMessagesPerThread: parseNumber(process.env.MAX_MESSAGES_PER_THREAD, 8),
    analyticsScrollPasses: parseNumber(
      scrollPassesArg ?? process.env.ANALYTICS_SCROLL_PASSES,
      12,
    ),
    analyticsOutputDir: (process.env.ANALYTICS_OUTPUT_DIR || 'analytics').trim(),
    dmWatchMode: watchFlag || parseBoolean(process.env.DM_WATCH_MODE, false),
    dmWatchIntervalSec: parseNumber(process.env.DM_WATCH_INTERVAL_SEC, 45),
    dryRun: dryRunFlag || parseBoolean(process.env.DRY_RUN, false),
    loginOnly: loginOnlyFlag,
    userDataDir,
  };
}
