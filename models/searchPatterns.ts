// Anchored at both ends so a search query that merely *contains* an
// `@username` substring (most notably the trailing `/@user` of a profile
// URL like `https://example.com/@alice`) is not treated as a bare handle.
export const HANDLE_REGEXP = /^@([a-z0-9_]{1,50})$/i;
export const FULL_HANDLE_REGEXP = /^@?([^@]+)@([^@]+)$/;
