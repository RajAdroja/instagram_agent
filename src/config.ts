import dotenv from 'dotenv';

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
