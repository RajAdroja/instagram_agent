import { loadConfig } from './config.js';
import { InstagramStoryAgent } from './storyAgent.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const agent = new InstagramStoryAgent(config);

  console.log('====================================================');
  console.log('Instagram Story Liker, DM Reactor & Chat Analytics');
  console.log('====================================================');
  console.log(
    `Mode:              ${
      config.loginOnly
        ? 'Login Only'
        : config.dryRun
          ? 'DRY RUN (no likes/reactions sent)'
          : 'LIVE'
    }`,
  );
  console.log(
    `Story Liker:       ${
      config.enableStories
        ? `Enabled (max ${config.maxLikesPerRun > 0 ? config.maxLikesPerRun : 'unlimited'} likes)`
        : 'Disabled'
    }`,
  );
  console.log(
    `DM Media Reactor:  ${
      config.enableDmReactions
        ? `Enabled (Reels/Posts in top ${config.maxDmThreadsToCheck} threads)`
        : 'Disabled'
    }`,
  );
  console.log(
    `Chat Analytics:    ${
      config.enableChatAnalytics
        ? `Enabled (${config.maxDmThreadsToCheck} threads, ${config.analyticsScrollPasses} scroll passes/thread)`
        : 'Disabled'
    }`,
  );
  if (config.dmWatchMode) {
    console.log(
      `DM Watch Mode:     Every ${config.dmWatchIntervalSec}s`,
    );
  }
  console.log(
    `Action Delay:      ${config.minLikeDelayMs}ms - ${config.maxLikeDelayMs}ms`,
  );
  if (config.skipUsers.size > 0) {
    console.log(`Skipping Users:    ${Array.from(config.skipUsers).join(', ')}`);
  }
  console.log('====================================================\n');

  const handleSignal = () => {
    console.log('\nInterrupt received; stopping agent gracefully...');
    agent.stop();
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  const stats = await agent.run();

  console.log('\n====================================================');
  console.log('Session Summary');
  console.log('====================================================');
  console.log(`Story accounts visited:   ${stats.usersVisited.size}`);
  console.log(`Story slides viewed:      ${stats.slidesViewed}`);
  console.log(
    `Story slides liked:       ${stats.likedCount}${config.dryRun ? ' (dry run)' : ''}`,
  );
  console.log(`Already liked stories:    ${stats.alreadyLikedCount}`);
  console.log(`Sponsored ads skipped:    ${stats.skippedAdCount}`);
  console.log(`DM threads checked:       ${stats.dmThreadsChecked}`);
  console.log(
    `DM Reels/Posts reacted:   ${stats.dmMediaReacted}${
      config.dryRun ? ' (dry run)' : ''
    }`,
  );
  console.log(`DM already reacted:       ${stats.dmAlreadyReacted}`);
  console.log(`Analytics chats scanned:  ${stats.analyticsThreadsExtracted}`);
  console.log(`Analytics msgs extracted: ${stats.analyticsMessagesExtracted}`);
  if (stats.analyticsReportPath) {
    console.log(`Analytics summary report: ${stats.analyticsReportPath}`);
  }
  console.log('====================================================\n');
}

main().catch((err) => {
  console.error('Fatal error in Instagram Agent:', err);
  process.exit(1);
});
