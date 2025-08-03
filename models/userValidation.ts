export const USERNAME_REGEXP = /^[a-z0-9_]{1,15}$/;

export enum UsernameValidationError {
  Required = "USERNAME_REQUIRED",
  TooLong = "USERNAME_TOO_LONG",
  InvalidCharacters = "USERNAME_INVALID_CHARACTERS",
}

export enum DisplayNameValidationError {
  Required = "DISPLAY_NAME_REQUIRED",
  TooLong = "DISPLAY_NAME_TOO_LONG",
}

export enum BioValidationError {
  TooLong = "BIO_TOO_LONG",
}

export function validateUsername(
  username: string,
): UsernameValidationError | null {
  const trimmedUsername = username.trim().toLowerCase();

  if (!trimmedUsername) {
    return UsernameValidationError.Required;
  }

  if (trimmedUsername.length > 15) {
    return UsernameValidationError.TooLong;
  }

  if (!trimmedUsername.match(USERNAME_REGEXP)) {
    return UsernameValidationError.InvalidCharacters;
  }

  return null;
}

export function validateDisplayName(
  name: string,
): DisplayNameValidationError | null {
  const trimmedName = name.trim();

  if (!trimmedName) {
    return DisplayNameValidationError.Required;
  }

  if (trimmedName.length > 50) {
    return DisplayNameValidationError.TooLong;
  }

  return null;
}

export function validateBio(bio: string): BioValidationError | null {
  if (bio.length > 512) {
    return BioValidationError.TooLong;
  }

  return null;
}
