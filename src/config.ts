import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

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
  const dryRunFlag = argv.includes('--dry-run');
  const loginOnlyFlag = argv.includes('--login-only');
  const includeSeenFlag = argv.includes('--include-seen');

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

  return {
    igUsername: process.env.IG_USERNAME?.trim() || undefined,
    igPassword: process.env.IG_PASSWORD?.trim() || undefined,
    minLikeDelayMs,
    maxLikeDelayMs,
    minNextDelayMs,
    maxNextDelayMs,
    maxLikesPerRun: parseNumber(process.env.MAX_LIKES_PER_RUN, 250),
    maxSlidesPerRun: parseNumber(process.env.MAX_SLIDES_PER_RUN, 1000),
    skipUsers: new Set(),
    includeSeenStories: includeSeenFlag || parseBoolean(process.env.INCLUDE_SEEN_STORIES, false),
    dryRun: dryRunFlag || parseBoolean(process.env.DRY_RUN, false),
    loginOnly: loginOnlyFlag,
    userDataDir,
  };
}
