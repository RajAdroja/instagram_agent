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
