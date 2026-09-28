import { SIM, stepPlayer, type DashState, type GameMap, type InputFrame, type MoveState, type Vec2 } from '@rune/shared';

/**
 * Client-side prediction for the own player. Every sampled input is applied locally and kept until
 * the server acknowledges it; on each snapshot the authoritative state (position and any dash in
 * progress) is taken and the unacknowledged inputs are replayed on top.
 */
export class Predictor {
  private pending: InputFrame[] = [];
  state: MoveState = { x: 0, y: 0, dash: null };
  /** Position before the most recent step, for smoothing render frames between ticks. */
  previous: Vec2 = { x: 0, y: 0 };
  /** Distance between prediction and server-corrected prediction at the last reconcile. */
  lastCorrection = 0;
  /** Offset from the last reconcile, faded out over a few frames so corrections do not pop. */
  lastCorrectionVector: Vec2 = { x: 0, y: 0 };
  frozen = false;

  /** Updated from the server's effective speed (gear can change it) before inputs are replayed. */
  moveSpeed: number;

  constructor(
    moveSpeed: number,
    private readonly map: GameMap,
  ) {
    this.moveSpeed = moveSpeed;
  }

  get position(): Vec2 {
    return this.state;
  }

  reset(pos: Vec2): void {
    this.state = { x: pos.x, y: pos.y, dash: null };
    this.previous = { x: pos.x, y: pos.y };
  }

  apply(input: InputFrame): void {
    this.pending.push(input);
    this.previous = { x: this.state.x, y: this.state.y };
    if (!this.frozen) this.state = this.step(this.state, input);
  }

  reconcile(serverPos: Vec2, serverDash: DashState | null, lastProcessedSeq: number, dead: boolean): void {
    this.pending = this.pending.filter((i) => i.seq > lastProcessedSeq);
    this.frozen = dead;
    let s: MoveState = { x: serverPos.x, y: serverPos.y, dash: serverDash };
    if (!dead) for (const input of this.pending) s = this.step(s, input);
    this.lastCorrectionVector = { x: this.state.x - s.x, y: this.state.y - s.y };
    this.lastCorrection = Math.hypot(this.lastCorrectionVector.x, this.lastCorrectionVector.y);
    this.state = s;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  private step(s: MoveState, input: InputFrame): MoveState {
    return stepPlayer(this.map, s, input.moveDir, this.moveSpeed, SIM.dt, SIM.playerRadius);
  }
}
