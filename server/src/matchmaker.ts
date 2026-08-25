import { Session } from "./session.js";
import { ACTOR_CAP, BOT_MAX } from "./config.js";

/**
 * Dual persistent arenas on ONE server process:
 *   - "classic": constant slither-io style map (the main mode)
 *   - "br":      Battle-Royale collapse rounds
 * Clients pick a mode at join; each arena keeps its own bot population so
 * both stay lively. Health endpoint aggregates both.
 */
export class Matchmaker {
  readonly classic: Session;
  readonly br: Session;

  constructor() {
    this.classic = new Session("classic");
    this.br = new Session("br");
    this.classic.start();
    this.br.start();
    this.adjust(this.classic);
    this.adjust(this.br);
    console.log(
      `[sessions] opened arenas: ${this.classic.id} + ${this.br.id}`,
    );
  }

  /** Route a join to the requested arena ("br" | anything else = classic). */
  getArena(mode: unknown): Session {
    return mode === "br" ? this.br : this.classic;
  }

  onHumanJoined(s: Session): void {
    this.adjust(s);
  }

  onHumanLeft(s: Session): void {
    this.adjust(s);
  }

  private adjust(s: Session): void {
    s.adjustBots(Math.min(BOT_MAX, Math.max(0, ACTOR_CAP - s.humans.size)));
  }

  /** Aggregated health for /health, with per-arena detail for diagnostics. */
  healthStats() {
    const c = this.classic.healthStats();
    const b = this.br.healthStats();
    return {
      humans: c.humans + b.humans,
      bots: c.bots + b.bots,
      alive: c.alive + b.alive,
      food: c.food + b.food,
      tickErrStreak: Math.max(c.tickErrStreak, b.tickErrStreak),
      tickMsAvg:
        c.tickMsAvg >= 0 || b.tickMsAvg >= 0
          ? Math.max(c.tickMsAvg, b.tickMsAvg)
          : -1,
      sinceLastTickMs: Math.max(c.sinceLastTickMs, b.sinceLastTickMs),
      arenas: { classic: c, br: b },
    };
  }
}
