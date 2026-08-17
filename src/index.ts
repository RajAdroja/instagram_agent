import { loadConfig } from './config.js';
import { InstagramStoryAgent } from './storyAgent.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const agent = new InstagramStoryAgent(config);

  const handleSignal = () => {
    console.log('\nInterrupt received; stopping agent gracefully...');
    agent.stop();
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  await agent.run();
}

main().catch((err) => {
  console.error('Fatal error in Instagram Agent:', err);
  process.exit(1);
});
