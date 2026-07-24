import { getXForwardedRequest } from "@hongminhee/x-forwarded-fetch";
import { isIP } from "node:net";

export interface ConnectionAddress {
  readonly transport: string;
  readonly hostname?: string;
  readonly port?: number;
}

export interface ConnectionInfo<TAddr extends ConnectionAddress> {
  readonly remoteAddr: TAddr;
  readonly completed: Promise<void>;
}

export interface ForwardedRequest<TAddr extends ConnectionAddress> {
  readonly request: Request;
  readonly connectionInfo: ConnectionInfo<TAddr>;
}

export async function applyTrustedForwarding<TAddr extends ConnectionAddress>(
  request: Request,
  connectionInfo: ConnectionInfo<TAddr>,
  behindProxy: boolean,
): Promise<ForwardedRequest<TAddr>> {
  if (!behindProxy) return { request, connectionInfo };

  const forwardedFor = request.headers.get("x-forwarded-for")?.trim();
  const forwardedRequest = await getXForwardedRequest(request);
  const remoteAddr = connectionInfo.remoteAddr;
  if (
    remoteAddr.transport !== "tcp" ||
    forwardedFor == null ||
    isIP(forwardedFor) === 0
  ) {
    return { request: forwardedRequest, connectionInfo };
  }

  return {
    request: forwardedRequest,
    connectionInfo: {
      ...connectionInfo,
      remoteAddr: { ...remoteAddr, hostname: forwardedFor } as TAddr,
    },
  };
}
