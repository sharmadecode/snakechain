import { Session } from "./session.js";
import { ACTOR_CAP, BOT_MAX } from "./config.js";

/**
 * Single persistent arena: one world, no session splitting. Seeded at boot
 * with food + a bot population that FILLS the actor cap: `bots = min(BOT_MAX,
 * ACTOR_CAP - humans)`. 0 humans -> 12 bots; 50 humans -> 0 bots. This keeps
 * the empty-server case lively without turning it into a CPU farm.
 */
export class Matchmaker {
  private arena: Session;

  constructor() {
    this.arena = new Session();
    this.arena.start();
    this.adjust(this.arena);
    console.log(`[sessions] opened arena ${this.arena.id} (halfW=${this.arena.halfW})`);
  }

  getArena(): Session {
    return this.arena;
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
}
