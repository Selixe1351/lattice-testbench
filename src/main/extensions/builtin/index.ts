import type { Extension } from "../types";
import { bots } from "./bots";
import { lattice } from "./lattice";
import { mcp } from "./mcp";
import { publishing } from "./publishing";

/** Shipped with the app and off until a person turns them on. */
export const builtins: Extension[] = [publishing, mcp, bots, lattice];
