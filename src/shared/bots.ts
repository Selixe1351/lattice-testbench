/** What the Bots extension shows. Plain data, structured-cloned over IPC. */

export interface BotView {
    name: string;
    serverId: string;
    state: "connecting" | "online" | "disconnected";
    health?: number;
    food?: number;
    position?: { x: number; y: number; z: number };
    /** What the bot is doing right now, e.g. "wandering" or "walking to 10 64 -3". */
    activity: string;
    /** Why it disconnected, if it did. */
    reason?: string;
}

export type BotAction =
    | { kind: "chat"; text: string }
    | { kind: "goto"; x: number; y: number; z: number }
    | { kind: "follow"; player: string }
    | { kind: "wander" }
    | { kind: "stop" }
    | { kind: "jump" }
    | { kind: "sneak"; on: boolean }
    | { kind: "look"; yaw: number; pitch: number }
    | { kind: "attack" }
    | { kind: "use" }
    | { kind: "useBlock" }
    | { kind: "hotbar"; slot: number }
    /** Keeps fishing with the rod in hand until stop. */
    | { kind: "fish" }
    | { kind: "disconnect" };

export interface BotEvent {
    bot: string;
    serverId: string;
    text: string;
}
