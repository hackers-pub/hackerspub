# Connections & Pagination Reference

Comprehensive reference for designing paginated lists in GraphQL using the
Relay Connection specification. All examples use pure GraphQL SDL with no
framework-specific details.

---

## 1. When to Use Connections vs Simple Lists

Not every list needs pagination. Use this decision tree:

```
Could this list grow unbounded over the lifetime of the API?
  YES --> Connection pagination. Always.
  NO  -->
    Is the maximum count small and guaranteed (<= ~20 items)?
      YES --> Simple list [T!]! is acceptable.
      NO  --> Use Connection pagination to be safe.
```

**Simple list examples** (bounded, small, stable):
- Enum-like value sets (e.g., available currencies)
- Tags on an entity (typically bounded by policy)
- Rule definitions or configuration entries with hard caps

**Connection examples** (unbounded, growing, queryable):
- Products, orders, users, comments
- Audit logs, events, notifications
- Search results of any kind

When in doubt, use a connection. Converting a simple list to a connection later
is a breaking change. Converting a connection to a simple list (if you somehow
need to) is also breaking. Start with the connection if growth is plausible.

---

## 2. Relay Connection Structure

The Relay Connection specification defines three types that work together:
the Connection, the Edge, and PageInfo.

### Full SDL

```graphql
type Query {
  products(
    first: Int
    after: String
    last: Int
    before: String
  ): ProductConnection!
}

type ProductConnection {
  """The list of edges (items with cursor and relationship metadata)."""
  edges: [ProductEdge!]!

  """Pagination metadata."""
  pageInfo: PageInfo!
}

Both `[T!]!` (non-null outer) and `[T!]` (nullable outer) are valid conventions
for `edges` and `nodes`. Some frameworks and projects prefer the nullable outer
form. Either is correct — do **not** flag one as an issue when reviewing. Only
flag it if the choice is inconsistent within the same schema.

type ProductEdge {
  """Opaque cursor for this item's position in the list."""
  cursor: String!

  """The item at the end of this edge."""
  node: Product!
}

type PageInfo {
  """Whether more items exist when paginating forward."""
  hasNextPage: Boolean!

  """Whether more items exist when paginating backward."""
  hasPreviousPage: Boolean!

  """Cursor of the first item in the current page. Null when empty."""
  startCursor: String

  """Cursor of the last item in the current page. Null when empty."""
  endCursor: String
}
```

### Why each piece exists

| Type | Purpose |
|------|---------|
| `Connection` | Container for the paginated result. Holds edges, pageInfo, and optional aggregate fields. |
| `Edge` | Wraps each item with its cursor and any relationship-specific metadata. |
| `PageInfo` | Tells the client whether more pages exist and provides cursors for the next request. |

---

## 3. Connection Type Naming

Connection and Edge types should be **unique per context**, never shared across
unrelated fields.

```graphql
# CORRECT -- unique connection types per relationship context
type Team {
  members(first: Int, after: String): TeamMemberConnection!
}

type Organization {
  users(first: Int, after: String): OrganizationUserConnection!
}

# WRONG -- shared UserConnection hides context-specific differences
type Team {
  members(first: Int, after: String): UserConnection!
}
type Organization {
  users(first: Int, after: String): UserConnection!
}
```

Why: each connection context may need different edge fields (e.g., `role` on
`TeamMemberEdge` vs `joinedAt` on `OrganizationUserEdge`). A shared connection
type prevents this evolution.

**Naming convention:**
- Connection type: `{Context}{Entity}Connection` (e.g., `TeamMemberConnection`)
- Edge type: `{Context}{Entity}Edge` (e.g., `TeamMemberEdge`)
- PageInfo: shared `PageInfo` type (standard across all connections)

---

## 4. Edge Fields for Relationship Metadata

Relationship-specific data belongs on the **edge**, not on the node. The node
represents the entity itself; the edge represents its membership in this
particular collection.

```graphql
# CORRECT -- role describes the relationship, not the user
type TeamMemberEdge {
  cursor: String!
  node: User!
  role: TeamMemberRole!
  joinedAt: DateTime!
}

# WRONG -- pollutes the User type with context-specific fields
type User {
  id: ID!
  name: String!
  teamRole: TeamMemberRole   # Only meaningful in team context
}
```

More examples of edge fields:
- `CollectionProductEdge.position` -- sort position within that collection
- `RepositoryCollaboratorEdge.permission` -- READ, WRITE, ADMIN
- `StargazerEdge.starredAt` -- when the user starred the repository

This keeps node types clean, reusable, and free from contextual pollution.

---

## 5. totalCount Considerations

`totalCount` tells clients how many items exist in total (before pagination).
It seems useful but carries real costs.

```graphql
type ProductConnection {
  edges: [ProductEdge!]!
  pageInfo: PageInfo!
  totalCount: Int            # Nullable -- intentionally
}
```

### Guidelines

- **Do not add totalCount by default.** Only add it when there is a concrete
  client need (e.g., displaying "Showing 1-10 of 342").
- **Make it nullable** if you add it. This allows the server to omit it when
  computation is too expensive (very large collections, distributed data).
- **Computing count is expensive.** A `COUNT(*)` on large tables can be slow.
  For distributed or sharded data, it may require fan-out queries.
- **Once added, it is nearly impossible to remove.** Removing a field is a
  breaking change. Clients will depend on it.
- **Consider alternatives:** `hasNextPage` is sufficient for infinite-scroll UIs.
  An estimated count may work for display purposes without exact guarantees.

---

## 6. Empty Connection Behavior

A connection with no results is **not null**. It is a non-null connection with
empty edges and null cursors.

```graphql
# Correct response for an empty connection
{
  "products": {
    "edges": [],
    "pageInfo": {
      "hasNextPage": false,
      "hasPreviousPage": false,
      "startCursor": null,
      "endCursor": null
    }
  }
}
```

### Rules

- The connection field itself is **non-null** (`ProductConnection!`).
- `edges` returns an empty list `[]`, never null.
- `pageInfo.startCursor` and `endCursor` are null (no items = no cursors).
- `hasNextPage` and `hasPreviousPage` are both `false`.

**Semantic distinction:**
- `null` connection = error or unauthorized access (the field itself failed)
- Empty connection = zero matching items (valid, successful result)

---

## 7. Cursor Design

Cursors are opaque tokens that identify a position in a paginated list. Clients
must never construct or parse them.

### Principles

1. **Opaque to clients.** Use Base64 encoding as a convention that signals
   "do not parse this." Clients treat cursors as opaque strings.

2. **Stable across inserts.** Inserting new items should not invalidate
   existing cursors. Cursor-based pagination avoids the duplicate/skip
   problems of offset pagination precisely because cursors point to a
   specific position, not a numeric offset.

3. **Self-contained.** A cursor should contain enough information for the
   server to resume pagination without additional context. Typical internal
   format: `base64("type:id:sort_key")`.

4. **Include routing info for distributed systems.** If data is sharded or
   partitioned, encode the shard/partition identifier in the cursor so the
   server can route the next request correctly.

```graphql
# Example cursor values (Base64-encoded, opaque to client)
# Internal: "product:42:2024-01-15T10:30:00Z"
# Encoded:  "cHJvZHVjdDo0MjoyMDI0LTAxLTE1VDEwOjMwOjAwWg=="
```

**Never** document the cursor format in your API documentation. The moment
clients parse cursors, you lose the ability to change the format.

---

## 8. Bidirectional Pagination

The Relay spec supports pagination in both directions using two pairs of
arguments.

### Forward pagination

```graphql
products(first: 10, after: "cursor_abc")
```
- `first`: how many items to return from the front
- `after`: return items after this cursor

### Backward pagination

```graphql
products(last: 10, before: "cursor_xyz")
```
- `last`: how many items to return from the end
- `before`: return items before this cursor

### Rules

- Clients should **not combine** `first` with `last` in a single request.
  The behavior is undefined or confusing in most implementations.
- `first`/`after` is the primary pattern for infinite-scroll and "load more" UIs.
- `last`/`before` enables reverse navigation (e.g., "show most recent first"
  when the natural sort is ascending).
- `hasNextPage` is meaningful for `first`/`after` pagination.
- `hasPreviousPage` is meaningful for `last`/`before` pagination.

```graphql
type Query {
  """
  Paginate forward with first/after, backward with last/before.
  Do not combine first with last in the same request.
  """
  messages(
    first: Int
    after: String
    last: Int
    before: String
  ): MessageConnection!
}
```

---

## 9. Filter & Sort Arguments on Connections

Filter and sort arguments go on the **connection field**, alongside the
pagination arguments.

### Simple filters: inline arguments

When filtering is simple (one or two fields), use inline arguments with
default values:

```graphql
type Query {
  products(
    first: Int
    after: String
    status: ProductStatus = ACTIVE
    orderBy: ProductSortKey = CREATED_AT_DESC
  ): ProductConnection!
}

enum ProductSortKey {
  CREATED_AT_ASC
  CREATED_AT_DESC
  NAME_ASC
  NAME_DESC
  PRICE_ASC
  PRICE_DESC
}
```

### Complex filters: dedicated input type

When filtering involves multiple fields or nested conditions, use a dedicated
input type:

```graphql
type Query {
  products(
    first: Int
    after: String
    filter: ProductFilter
    orderBy: ProductSortKey = CREATED_AT_DESC
  ): ProductConnection!
}

input ProductFilter {
  status: ProductStatus
  categoryId: ID
  minPrice: Float
  maxPrice: Float
  searchTerm: String
}
```

### Guidelines

- **Always provide default sort values** via GraphQL default syntax so clients
  get deterministic ordering without specifying it.
- **Document what the default filter is.** If `status` defaults to `ACTIVE`,
  say so in the field description.
- Filter/sort arguments should not affect cursor stability -- the same cursor
  under the same filter/sort should return the same position.

---

## 10. Custom Connection Fields

Beyond the standard `edges` and `pageInfo`, connections can expose additional
convenience fields.

### The `nodes` shortcut

Many APIs provide a `nodes` field that returns items directly, skipping the
edge wrapper. This is useful when edge metadata is not needed.

```graphql
type ProductConnection {
  edges: [ProductEdge!]!
  nodes: [Product!]!          # Convenience: skips edge wrapper
  pageInfo: PageInfo!
}

# Client can query either way:
query {
  # When edge metadata is needed
  products(first: 10) {
    edges {
      cursor
      node { name }
      addedAt           # Edge-specific field
    }
  }
}

query {
  # When only the items matter
  products(first: 10) {
    nodes { name }
    pageInfo { hasNextPage endCursor }
  }
}
```

**Always provide both `edges` and `nodes`** if you add the shortcut. The
`edges` pattern remains essential for relationship metadata.

### Other custom fields

- `totalCount: Int` -- covered in section 5
- Domain-specific aggregations (use sparingly):

```graphql
type OrderConnection {
  edges: [OrderEdge!]!
  nodes: [Order!]!
  pageInfo: PageInfo!
  totalCount: Int
  """Sum of all order totals matching the current filter."""
  totalAmount: Money
}
```

Be cautious with aggregate fields. They have the same performance and
removal concerns as `totalCount`. Only add them when there is a proven
client need.
