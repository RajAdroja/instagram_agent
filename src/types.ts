export interface StorySlideInfo {
  username: string;
  storyId: string;
}

export interface RunStats {
  likedCount: number;
  alreadyLikedCount: number;
  skippedAdCount: number;
  skippedUserSlidesCount: number;
  noLikeButtonCount: number;
  slidesViewed: number;
  usersVisited: Set<string>;
}
