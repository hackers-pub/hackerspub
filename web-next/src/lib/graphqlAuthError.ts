const AUTH_REQUIRED_CODE = "AUTHENTICATION_REQUIRED";

export function isExpectedAuthError(errors: ReadonlyArray<unknown>): boolean {
  if (errors.length === 0) return false;
  return errors.every((error) => {
    if (error == null || typeof error !== "object") return false;
    const extensions = (error as { extensions?: unknown }).extensions;
    if (extensions == null || typeof extensions !== "object") return false;
    return (extensions as { code?: unknown }).code === AUTH_REQUIRED_CODE;
  });
}

function isExpectedAuthResponseItem(response: unknown): boolean {
  if (response == null || typeof response !== "object") return false;
  const errors = (response as { errors?: unknown }).errors;
  return Array.isArray(errors) && isExpectedAuthError(errors);
}

export function isExpectedAuthResponse(response: unknown): boolean {
  return Array.isArray(response)
    ? response.some(isExpectedAuthResponseItem)
    : isExpectedAuthResponseItem(response);
}
