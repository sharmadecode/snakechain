const DEADZONE = 8;
const MAX_JOY_RADIUS = 55;

export class Input {
  mouseX = 0;
  mouseY = 0;
  hasMouse = false;
  joystickActive = false;
  joyBaseX = 0;
  joyBaseY = 0;
  joyDX = 0;
  joyDY = 0;
  isTouch = false;
  private touchId: number | null = null;
  /** Boost state: left mouse held, boost key held, or on-screen button active. */
  mouseHeld = false;
  boostKey = false;
  boostBtn = false;
  doubleTapBoost = false;
  lastTouchStart = 0;

  private keyX = 0;
  private keyY = 0;

  attach(canvas: HTMLCanvasElement): void {
    canvas.addEventListener("mousemove", (e) => {
      this.hasMouse = true;
      this.isTouch = false;
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    canvas.addEventListener("touchstart", (e) => {
      this.isTouch = true;
      this.hasMouse = false;

      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i]!;
        // Steer touch on left 75% of screen
        if (this.touchId === null && t.clientX < window.innerWidth * 0.75) {
          this.touchId = t.identifier;
          this.joystickActive = true;
          this.joyBaseX = t.clientX;
          this.joyBaseY = t.clientY;
          this.joyDX = 0;
          this.joyDY = 0;

          const now = performance.now();
          if (now - this.lastTouchStart < 280) {
            this.doubleTapBoost = true;
          }
          this.lastTouchStart = now;
          break;
        }
      }
    }, { passive: true });

    canvas.addEventListener("touchmove", (e) => {
      if (!this.joystickActive || this.touchId === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i]!;
        if (t.identifier === this.touchId) {
          const dx = t.clientX - this.joyBaseX;
          const dy = t.clientY - this.joyBaseY;
          const len = Math.hypot(dx, dy);
          if (len > MAX_JOY_RADIUS) {
            this.joyDX = (dx / len) * MAX_JOY_RADIUS;
            this.joyDY = (dy / len) * MAX_JOY_RADIUS;
          } else {
            this.joyDX = dx;
            this.joyDY = dy;
          }
          break;
        }
      }
    }, { passive: true });

    const handleTouchEnd = (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i]!;
        if (t.identifier === this.touchId) {
          this.touchId = null;
          this.joystickActive = false;
          this.joyDX = 0;
          this.joyDY = 0;
          this.doubleTapBoost = false;
          break;
        }
      }
    };

    canvas.addEventListener("touchend", handleTouchEnd, { passive: true });
    canvas.addEventListener("touchcancel", handleTouchEnd, { passive: true });

    window.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.mouseHeld = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseHeld = false;
    });

    window.addEventListener("keydown", (e) => {
      this.updateKeys(e.key, true);
      if (e.key === " " || e.key === "Shift") e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.updateKeys(e.key, false));
    window.addEventListener("blur", () => {
      this.keyX = 0;
      this.keyY = 0;
      this.touchId = null;
      this.joystickActive = false;
      this.joyDX = 0;
      this.joyDY = 0;
      this.mouseHeld = false;
      this.boostKey = false;
      this.boostBtn = false;
      this.doubleTapBoost = false;
    });
  }

  get boosting(): boolean {
    return this.mouseHeld || this.boostKey || this.boostBtn || this.doubleTapBoost;
  }

  private updateKeys(key: string, down: boolean): void {
    const v = down ? 1 : 0;
    switch (key.toLowerCase()) {
      case "w": case "arrowup": this.keyY = -v; break;
      case "s": case "arrowdown": this.keyY = v; break;
      case "a": case "arrowleft": this.keyX = -v; break;
      case "d": case "arrowright": this.keyX = v; break;
      case " ": this.boostKey = down; break;
      case "shift": this.boostKey = down; break;
    }
  }

  /** Angle in world space, or null if the player should keep its current heading. */
  getAngle(selfScreenX: number, selfScreenY: number): number | null {
    if (this.keyX !== 0 || this.keyY !== 0) {
      return Math.atan2(this.keyY, this.keyX);
    }
    if (this.joystickActive) {
      const len = Math.hypot(this.joyDX, this.joyDY);
      if (len < DEADZONE) return null;
      return Math.atan2(this.joyDY, this.joyDX);
    }
    if (this.hasMouse) {
      return Math.atan2(this.mouseY - selfScreenY, this.mouseX - selfScreenX);
    }
    return null;
  }
}
