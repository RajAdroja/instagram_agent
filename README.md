# Instagram Story Liker, DM Reaction, and Chat Analytics Agent

A Node.js and TypeScript **Playwright** browser automation agent that:
1. **Likes Story Slides**: Opens your Instagram home feed story tray and likes every story slide posted by accounts you follow.
2. **Reacts to Shared Reels and Posts in DMs**: Opens your Direct Messages (`/direct/inbox/`), scans recent conversations for incoming shared Reels and Posts, and reacts to each one with a laughing reaction.
3. **Extracts Comprehensive DM Chat Analytics**: Scrolls through your Direct Message conversations and generates detailed JSON, CSV, and Markdown reports on who sent how many Reels, Posts, text messages, words, voice notes, links, how many reactions each person gave and received, and a directed breakdown of who reacted to whose messages.

## Features

- **Persistent Browser Session (`.browser-profile/`)**: Log into your Instagram account (including 2FA) once in the opened Chrome window; future runs reuse your saved session automatically.
- **Likes Every Story Slide**: Automatically detects the story `Like` button on every slide, skips slides that are already liked (`Unlike`), and skips `Sponsored` ad slides.
- **DM Reel and Post Reaction**:
  - Scans your top DM threads (prioritizing unread chats and shared media snippets).
  - Detects incoming shared Reels and Posts while ignoring messages sent by you.
  - Hovers over each shared Reel or Post, opens the message reaction picker, and selects the laughing reaction.
  - Stores reacted item signatures in `.browser-profile/reacted-dm-items.json` to prevent duplicate reactions.
- **DM Chat Analytics and Data Extractor (`src/chatAnalytics.ts`)**:
  - Scrolls upward through message history in each conversation (`--scroll-passes=12`), harvesting messages on every pass so virtualized messages are never missed.
  - Tracks per-participant counts for:
    - Total messages sent, text messages, total words, and average words per message
    - Shared **Reels** sent and shared **Posts** sent
    - Story interactions/replies, media attachments, voice notes, and external links
    - Total **reactions given** and **reactions received** (broken down by reactions on Reels, Posts, and text messages, plus Reel-to-reaction conversion rate %)
    - **Who reacted to whose messages** (`Reactor -> Message Author` matrix with counts on Reels, Posts, and text, plus breakdown by reaction type)
    - Most frequently shared Instagram creators per thread
  - Exports four files to `./analytics/`:
    - `analytics/chat-analytics-report.json`
    - `analytics/participant-stats.csv`
    - `analytics/who-reacted-to-whom.csv`
    - `analytics/chat-summary.md`
- **In-Browser Floating HUD**: Displays live counters (Story Likes, DM Reactions, Slides viewed, current target) with interactive **Pause / Resume** and **Stop** buttons inside the browser.
- **Human-Like Randomized Delays**: Configurable jittered delays between actions.

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Run the Agent

```bash
# Run Story Liker + DM Reactor
npm start

# Extract DM Chat Analytics (JSON, CSV, and Markdown reports in ./analytics/)
npm run analytics

# Extract deeper DM Chat Analytics (e.g. top 20 chats, 25 scroll passes per chat)
npm run analytics -- --max-threads=20 --scroll-passes=25

# Run only the DM Reel/Post Reactor
npm run dm-react

# Continuously watch DMs for new incoming Reels/Posts
npm run watch-dms

# Run only the Story Liker
npm run stories
```

## Useful Commands and Flags

| Command | Description |
| :--- | :--- |
| `npm start` | Like every story slide in your tray, then react to shared Reels and Posts in DMs |
| `npm run analytics` | Extract DM chat analytics and export JSON/CSV/Markdown reports (`--analytics-only`) |
| `npm run dm-react` | Only scan DMs and react to incoming Reels and Posts (`--dm-only`) |
| `npm run watch-dms` | Keep browser open and periodically check DMs for new Reels and Posts (`--dm-only --watch`) |
| `npm run stories` | Only like story slides in the home feed tray (`--stories-only`) |
| `npm run dry-run` | Highlight target buttons without clicking Like or reacting (`--dry-run`) |
| `npm run login` | Open browser just to log in and save your session, then exit (`--login-only`) |
| `npm start -- --analytics` | Run stories, DM reactions, and chat analytics in a single session |
| `npm run analytics -- --max-threads=15 --scroll-passes=20` | Customize number of threads and scroll depth for chat analytics |

## Configuration (`.env`)

Edit `.env` to customize behavior:

```ini
# Feature toggles
ENABLE_STORIES=true
ENABLE_DM_REACTIONS=true
ENABLE_CHAT_ANALYTICS=false

# DM Reel/Post Reaction & Chat Analytics settings
MAX_DM_THREADS=10
MAX_MESSAGES_PER_THREAD=8
ANALYTICS_SCROLL_PASSES=12
ANALYTICS_OUTPUT_DIR=analytics
DM_WATCH_MODE=false
DM_WATCH_INTERVAL_SEC=45

# Delay settings (in milliseconds)
MIN_LIKE_DELAY_MS=1200
MAX_LIKE_DELAY_MS=2800
MIN_NEXT_DELAY_MS=800
MAX_NEXT_DELAY_MS=1800

# Safety limit: Maximum number of story likes per run (0 = unlimited)
MAX_LIKES_PER_RUN=250

# Optional comma-separated list of usernames to skip
SKIP_USERS=
```
