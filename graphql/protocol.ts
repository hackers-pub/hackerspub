import { isMain } from "@hackerspub/runtime/main";
import { main } from "./main.ts";

if (isMain(import.meta)) await main("protocol");
