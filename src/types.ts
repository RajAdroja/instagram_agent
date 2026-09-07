/**
 * Parsed route parameters for an active Instagram story slide.
 */
export interface StorySlideInfo {
  username: string;
  storyId: string;
}

/**
 * Classification of an individual message in an Instagram DM thread.
 */
export type DmMessageCategory =
  | 'reel'
  | 'post'
  | 'story_interaction'
  | 'media_attachment'
  | 'voice_note'
  | 'link'
  | 'text';

/**
 * Per-participant message and reaction metrics within a conversation or across all chats.
 */
export interface ParticipantAnalytics {
  participant: string;
  totalMessagesSent: number;
  textMessagesSent: number;
  reelsSent: number;
  postsSent: number;
  storyInteractionsSent: number;
  mediaAttachmentsSent: number;
  voiceNotesSent: number;
  linksSent: number;
  totalWordsSent: number;
  totalCharactersSent: number;
  averageWordsPerMessage: number;
  reactionsGiven: number;
  reactionsReceived: number;
  reactionsReceivedOnReels: number;
  reactionsReceivedOnPosts: number;
  reactionsReceivedOnText: number;
  reelReactionRatePct: number;
}

/**
 * Directed edge tracking how many times one user reacted to another user's messages.
 */
export interface ReactionPairStat {
  reactor: string;
  messageAuthor: string;
  threadTitle: string;
  totalReactions: number;
  onReels: number;
  onPosts: number;
  onTextOrOther: number;
  reactionCountsByType: Record<string, number>;
}

/**
 * Analytics summary for a single DM conversation thread.
 */
export interface ThreadAnalyticsReport {
  threadId: string;
  threadTitle: string;
  isGroupChat: boolean;
  totalMessagesAnalyzed: number;
  totalReelsShared: number;
  totalPostsShared: number;
  totalReactionsLogged: number;
  topReelSender: string | null;
  topPostSender: string | null;
  topMessageSender: string | null;
  mostSharedCreators: Array<{ creator: string; count: number }>;
  participants: Record<string, ParticipantAnalytics>;
  whoReactedToWhom: ReactionPairStat[];
}

/**
 * Full exported analytics payload across all scanned DM threads.
 */
export interface FullChatAnalyticsReport {
  generatedAt: string;
  threadsAnalyzed: number;
  totalMessagesAnalyzed: number;
  totalReelsShared: number;
  totalPostsShared: number;
  totalReactionsLogged: number;
  globalLeaderboards: {
    topReelSenders: Array<{ participant: string; count: number }>;
    topPostSenders: Array<{ participant: string; count: number }>;
    topMessageSenders: Array<{ participant: string; count: number }>;
    topReactors: Array<{ participant: string; count: number }>;
    mostReactedToUsers: Array<{ participant: string; count: number }>;
  };
  globalWhoReactedToWhom: ReactionPairStat[];
  globalParticipants: Record<string, ParticipantAnalytics>;
  threads: ThreadAnalyticsReport[];
}

/**
 * Cumulative statistics for a single agent run.
 */
export interface RunStats {
  likedCount: number;
  alreadyLikedCount: number;
  skippedAdCount: number;
  skippedUserSlidesCount: number;
  noLikeButtonCount: number;
  slidesViewed: number;
  usersVisited: Set<string>;
  dmThreadsChecked: number;
  dmMediaReacted: number;
  dmAlreadyReacted: number;
  analyticsThreadsExtracted: number;
  analyticsMessagesExtracted: number;
  analyticsReportPath?: string;
}
