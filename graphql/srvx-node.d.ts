import type { IncomingMessage, Server, ServerResponse } from "node:http";

export interface SrvxNodeRequest extends Request {
  readonly runtime?: {
    readonly node?: {
      readonly req?: IncomingMessage;
      readonly res?: ServerResponse;
    };
  };
}

export interface SrvxNodeServer {
  readonly node?: {
    readonly server?: Server;
  };
  ready(): Promise<void>;
  close(): Promise<void>;
}

export declare function serve(options: {
  readonly hostname: string;
  readonly port: number;
  readonly silent: boolean;
  readonly gracefulShutdown: false;
  readonly fetch: (request: SrvxNodeRequest) => Response | Promise<Response>;
  readonly error: (error: unknown) => Response | Promise<Response>;
}): SrvxNodeServer;
