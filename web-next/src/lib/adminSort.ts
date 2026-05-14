// Valid values for the AdminAccountOrderBy GraphQL enum.  Kept here so both
// the route preload (admin/index.tsx) and the table component
// (admin/AdminAccountsTable.tsx) can share the same validation set without
// duplicating the list.
export const ADMIN_SORT_FIELDS = new Set([
  "FOLLOWING",
  "FOLLOWERS",
  "POSTS",
  "INVITATIONS_LEFT",
  "INVITED",
  "LAST_ACTIVITY",
  "CREATED",
]);
