import { createDefine } from "fresh";
import { Session } from "./models/session.ts";

export interface State {
  session?: Session;
}

export const define = createDefine<State>();
