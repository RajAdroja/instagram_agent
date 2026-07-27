import type { Page } from 'playwright';

export interface HudState {
  status: 'starting' | 'waiting_login' | 'running' | 'paused' | 'dry_run' | 'stopped' | 'completed';
  currentUser: string;
  likedCount: number;
  alreadyLikedCount: number;
  slidesViewed: number;
  usersVisited: number;
  dmReactedCount: number;
  maxLikes: number;
  lastAction: string;
}

export interface HudCallbacks {
  onTogglePause: () => boolean;
  onStop: () => void;
}

export async function setupHud(page: Page, callbacks: HudCallbacks): Promise<void> {
  try {
    await page.exposeFunction('__igAgentTogglePause', () => {
      return callbacks.onTogglePause();
    });
    await page.exposeFunction('__igAgentStop', () => {
      callbacks.onStop();
    });
  } catch {
    // Functions may already be exposed on this page context
  }
}

export async function updateHud(page: Page, state: HudState): Promise<void> {
  try {
    await page.evaluate((s: HudState) => {
      const HUD_ID = '__ig_story_agent_hud__';
      let container = document.getElementById(HUD_ID);

      if (!container) {
        container = document.createElement('div');
        container.id = HUD_ID;
        container.style.cssText = [
          'position: fixed',
          'bottom: 18px',
          'left: 18px',
          'z-index: 2147483647',
          'width: 280px',
          'background: rgba(18, 18, 22, 0.92)',
          'backdrop-filter: blur(12px)',
          '-webkit-backdrop-filter: blur(12px)',
          'border: 1px solid rgba(255, 255, 255, 0.14)',
          'border-radius: 14px',
          'padding: 12px 14px',
          'color: #f5f5f7',
          'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          'font-size: 12px',
          'line-height: 1.4',
          'box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45)',
          'user-select: none',
          'pointer-events: auto',
        ].join(';');

        container.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <div style="display:flex;align-items:center;gap:6px;font-weight:700;font-size:13px;">
              <span>IG Agent</span>
            </div>
            <span id="__ig_hud_badge" style="padding:2px 8px;border-radius:999px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;"></span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;background:rgba(255,255,255,0.05);border-radius:8px;padding:8px;margin-bottom:8px;">
            <div>
              <div style="color:#9ca3af;font-size:10px;">LIKED</div>
              <div id="__ig_hud_likes" style="font-size:14px;font-weight:700;color:#fb7185;">0</div>
            </div>
            <div>
              <div style="color:#9ca3af;font-size:10px;">DM REACTS</div>
              <div id="__ig_hud_dms" style="font-size:14px;font-weight:700;color:#facc15;">0</div>
            </div>
            <div>
              <div style="color:#9ca3af;font-size:10px;">SLIDES</div>
              <div id="__ig_hud_slides" style="font-size:14px;font-weight:700;color:#f3f4f6;">0</div>
            </div>
          </div>
          <div style="margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            <span style="color:#9ca3af;">Target: </span>
            <span id="__ig_hud_user" style="font-weight:600;color:#fff;">-</span>
          </div>
          <div id="__ig_hud_action" style="color:#d1d5db;font-size:11px;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            Initializing...
          </div>
          <div style="display:flex;gap:6px;">
            <button id="__ig_hud_pause_btn" style="flex:1;padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.1);color:#fff;font-weight:600;font-size:11px;cursor:pointer;">
              Pause
            </button>
            <button id="__ig_hud_stop_btn" style="flex:1;padding:6px 10px;border-radius:8px;border:none;background:#ef4444;color:#fff;font-weight:600;font-size:11px;cursor:pointer;">
              Stop
            </button>
          </div>
        `;

        document.body.appendChild(container);

        const pauseBtn = document.getElementById('__ig_hud_pause_btn');
        const stopBtn = document.getElementById('__ig_hud_stop_btn');

        pauseBtn?.addEventListener('click', async (e) => {
          e.stopPropagation();
          const fn = (window as unknown as Record<string, () => Promise<boolean>>).__igAgentTogglePause;
          if (typeof fn === 'function') {
            const isPaused = await fn();
            if (pauseBtn) pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
          }
        });

        stopBtn?.addEventListener('click', async (e) => {
          e.stopPropagation();
          const fn = (window as unknown as Record<string, () => Promise<void>>).__igAgentStop;
          if (typeof fn === 'function') {
            await fn();
          }
        });
      }

      const badge = document.getElementById('__ig_hud_badge');
      const likesEl = document.getElementById('__ig_hud_likes');
      const dmsEl = document.getElementById('__ig_hud_dms');
      const slidesEl = document.getElementById('__ig_hud_slides');
      const userEl = document.getElementById('__ig_hud_user');
      const actionEl = document.getElementById('__ig_hud_action');
      const pauseBtn = document.getElementById('__ig_hud_pause_btn');

      if (badge) {
        const badgeStyles: Record<HudState['status'], { text: string; bg: string; fg: string }> = {
          starting: { text: 'Starting', bg: 'rgba(59,130,246,0.25)', fg: '#93c5fd' },
          waiting_login: { text: 'Login Needed', bg: 'rgba(245,158,11,0.25)', fg: '#fcd34d' },
          running: { text: 'Running', bg: 'rgba(16,185,129,0.25)', fg: '#6ee7b7' },
          paused: { text: 'Paused', bg: 'rgba(245,158,11,0.25)', fg: '#fcd34d' },
          dry_run: { text: 'Dry Run', bg: 'rgba(168,85,247,0.25)', fg: '#d8b4fe' },
          stopped: { text: 'Stopped', bg: 'rgba(239,68,68,0.25)', fg: '#fca5a5' },
          completed: { text: 'Done', bg: 'rgba(16,185,129,0.25)', fg: '#6ee7b7' },
        };
        const style = badgeStyles[s.status];
        badge.textContent = style.text;
        badge.style.background = style.bg;
        badge.style.color = style.fg;
      }

      if (likesEl) {
        likesEl.textContent =
          s.maxLikes > 0 ? `${s.likedCount}/${s.maxLikes}` : `${s.likedCount}`;
      }
      if (dmsEl) {
        dmsEl.textContent = `${s.dmReactedCount}`;
      }
      if (slidesEl) {
        slidesEl.textContent = `${s.slidesViewed}`;
      }
      if (userEl) {
        userEl.textContent = s.currentUser ? `${s.currentUser}` : '-';
      }
      if (actionEl) {
        actionEl.textContent = s.lastAction;
      }
      if (pauseBtn) {
        pauseBtn.textContent = s.status === 'paused' ? 'Resume' : 'Pause';
      }
    }, state);
  } catch {
    // Ignore errors during page navigation or after browser closes
  }
}
