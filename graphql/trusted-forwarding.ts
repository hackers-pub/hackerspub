import { getXForwardedRequest } from "@hongminhee/x-forwarded-fetch";
import { isIP } from "node:net";

export interface ForwardedRequest<TAddr extends Deno.Addr> {
  readonly request: Request;
  readonly connectionInfo: Deno.ServeHandlerInfo<TAddr>;
}

export async function applyTrustedForwarding<TAddr extends Deno.Addr>(
  request: Request,
  connectionInfo: Deno.ServeHandlerInfo<TAddr>,
  behindProxy: boolean,
): Promise<ForwardedRequest<TAddr>> {
  if (!behindProxy) return { request, connectionInfo };

  const forwardedFor = request.headers.get("x-forwarded-for")?.trim();
  const forwardedRequest = await getXForwardedRequest(request);
  const remoteAddr = connectionInfo.remoteAddr;
  if (
    remoteAddr.transport !== "tcp" || forwardedFor == null ||
    isIP(forwardedFor) === 0
  ) {
    return { request: forwardedRequest, connectionInfo };
  }

  return {
    request: forwardedRequest,
    connectionInfo: {
      ...connectionInfo,
      remoteAddr: { ...remoteAddr, hostname: forwardedFor },
    },
  };
}
