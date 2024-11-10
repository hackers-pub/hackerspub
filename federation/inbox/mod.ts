import { federation } from "../federation.ts";

federation.setInboxListeners("/ap/actors/{identifier}/inbox", "/ap/inbox");
