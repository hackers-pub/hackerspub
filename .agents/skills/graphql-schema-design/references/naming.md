# GraphQL Naming Conventions Reference

Comprehensive checklist for naming types, fields, mutations, arguments, and enums
in a GraphQL schema. Derived from production conventions used by GitHub, Shopify,
and other large-scale GraphQL APIs.

**Golden rule:** Consistency is king. When names are consistent, discovering new
parts of the API feels natural. When they are not, every new field is a guessing
game.

---

## 1. Type Naming

All type names use **PascalCase**. Suffixes communicate purpose at a glance.

### Checklist

- [ ] Every type name is PascalCase: `Product`, `OrderStatus`, `TeamMember`
- [ ] Input types end with `Input`: `CreateProductInput`, `UpdateAddressInput`
- [ ] Mutation payload types end with `Payload`: `CreateProductPayload`, `DeleteOrderPayload`
- [ ] Connection types end with `Connection`: `ProductConnection`, `TeamMemberConnection`
- [ ] Edge types end with `Edge`: `ProductEdge`, `TeamMemberEdge`
- [ ] Error types end with `Error`: `ProductNotFoundError`, `ValidationError`
- [ ] Interface names describe behavior as adjectives: `Starrable`, `Discountable`, `Commentable`
- [ ] Interface names never include the word "Interface": `Discountable` not `ItemInterface`
- [ ] Names are overly specific rather than generic: `TeamMember` not `User` when context is team membership
- [ ] Namespace types when ambiguity is possible: `BusinessCategory` not `Category`
- [ ] Generic names (`User`, `Event`, `Item`) are reserved for truly generic concepts

### Examples

```graphql
# Good -- specific, suffixed, PascalCase
type Product { ... }
type ProductConnection { ... }
type ProductEdge { ... }
input CreateProductInput { ... }
type CreateProductPayload { ... }
type ProductNotFoundError { ... }
interface Starrable { ... }

# Bad -- vague, missing suffix, wrong casing
type product { ... }
type productInput { ... }
type CreateProductResponse { ... }
type ItemInterface { ... }
```

### Why specificity matters

Using a generic name like `User` early on paints you into a corner. When the
schema needs to distinguish between a logged-in viewer and a team member, you
are forced into a large deprecation:

```graphql
# Before -- too generic
type User {
  name: String!
  email: String!
  permissions: [Permission!]!
}

# After -- specific types that each expose the right fields
interface User {
  name: String!
}

type Viewer implements User {
  name: String!
  email: String!
  permissions: [Permission!]!
}

type TeamMember implements User {
  name: String!
  isAdmin: Boolean!
}
```

Specific naming avoids this migration and makes the API clearer for clients.

### Real-world type naming

| API     | Pattern                    | Example                                      |
|---------|----------------------------|----------------------------------------------|
| GitHub  | Adjective interfaces       | `Starrable`, `Assignable`, `Closable`        |
| GitHub  | Specific connection types  | `TeamMemberConnection`, `IssueCommentConnection` |
| Shopify | Domain-specific types      | `DraftOrder`, `FulfillmentEvent`             |

---

## 2. Field Naming

All field names use **camelCase**. Fields should describe what they return, not
how they fetch it.

### Checklist

- [ ] Every field name is camelCase: `totalPrice`, `createdAt`, `hasNextPage`
- [ ] No `get` or `find` prefix on query fields: `products(ids:)` not `getProducts(ids:)`
- [ ] Fields are not namespaced within their parent type: on `BusinessAddress` use `formatted` not `formattedBusinessAddress`
- [ ] Boolean fields read as predicates with `is`, `has`, or `can` prefix: `isActive`, `hasNextPage`, `canDelete`
- [ ] Default values are used to document defaults: `products(sort: SortOrder = DESC)`
- [ ] Field names describe the returned data, not the implementation: `owner` not `ownerRecord`
- [ ] Plural names for list fields, singular for single-value fields: `tags` not `tag` for a list

### Examples

```graphql
type Product {
  # Good
  title: String!
  isAvailable: Boolean!
  hasVariants: Boolean!
  tags: [String!]!
  createdAt: DateTime!

  # Bad -- namespaced redundantly within parent
  productTitle: String!
  productIsAvailable: Boolean!
}

type Query {
  # Good -- no verb prefix, clean
  products(first: Int, after: String): ProductConnection!
  product(id: ID!): Product

  # Bad -- unnecessary verb prefix
  getProducts(first: Int, after: String): ProductConnection!
  findProduct(id: ID!): Product
}
```

### Consistency trap

```graphql
# Inconsistent -- clients cannot predict the pattern
type Query {
  products(ids: [ID!]): [Product!]!
  findPosts(ids: [ID!]): [Post!]!
}
```

A client using `findPosts` will assume `findProducts` exists. When it does not,
they hit an error and lose trust in the API. Pick one pattern and apply it
everywhere.

---

## 3. Mutation Naming

Mutation names are **action-based** and read like imperative commands. They
describe what the operation *does*, not what data it touches.

### Checklist

- [ ] Mutations read as verb-first actions: `createBook`, `archiveBook`, `addBookToShelf`
- [ ] Consistent verb prefixes across the schema: if you `create` books, you `create` authors -- never mix `create`/`add`/`new` for the same concept
- [ ] Symmetric actions exist: `publishBook` implies `unpublishBook`; `addBook` implies `removeBook`
- [ ] Fine-grained update mutations name the specific action: `updateBookTitle`, `addBookToShelf`, `removeBookFromShelf` -- not a generic `updateBook`
- [ ] Mutations describe intent, not data shape: `archiveBook` not `updateBook(archived: true)`
- [ ] Batch mutations use plural nouns: `addBooksToShelf` not multiple `addBookToShelf` calls
- [ ] No REST verb leakage: no `postAuthor`, `putBook`, `deleteBookById`

### Examples

```graphql
type Mutation {
  # Good -- action-based, consistent verbs, symmetric
  createProduct(input: CreateProductInput!): CreateProductPayload!
  updateProduct(input: UpdateProductInput!): UpdateProductPayload!
  deleteProduct(input: DeleteProductInput!): DeleteProductPayload!

  publishPost(input: PublishPostInput!): PublishPostPayload!
  unpublishPost(input: UnpublishPostInput!): UnpublishPostPayload!

  addItemToCart(input: AddItemToCartInput!): AddItemToCartPayload!
  removeItemFromCart(input: RemoveItemFromCartInput!): RemoveItemFromCartPayload!

  # Bad -- generic update, REST verbs, inconsistent
  updateCheckout(input: UpdateCheckoutInput!): UpdateCheckoutPayload!
  postUser(input: PostUserInput!): PostUserPayload!
  newProduct(input: NewProductInput!): NewProductPayload!
}
```

### Verb consistency table

Pick one verb per concept and use it everywhere:

| Concept              | Good verb | Avoid mixing with        |
|----------------------|-----------|--------------------------|
| Create new entity    | `create`  | `add`, `new`, `insert`   |
| Modify existing      | `update`  | `edit`, `modify`, `patch` |
| Remove permanently   | `delete`  | `remove`, `destroy`      |
| Add to collection    | `add`     | `create`, `attach`       |
| Remove from collection | `remove` | `delete`, `detach`      |
| Change state         | Named action: `publish`, `archive`, `approve` | generic `update` |

### Real-world mutation naming

| API     | Pattern              | Example                                          |
|---------|----------------------|--------------------------------------------------|
| Shopify | Noun-verb ordering   | `productCreate`, `orderCancel`, `draftOrderComplete` |
| GitHub  | Verb-first ordering  | `createIssue`, `closeIssue`, `addReaction`       |

Both are valid; the key is internal consistency within a single schema.

---

## 4. Argument Naming

Arguments use **camelCase** and follow well-established conventions for pagination,
filtering, and sorting.

### Checklist

- [ ] All arguments are camelCase: `first`, `after`, `includeDeleted`, `orderBy`
- [ ] Pagination arguments follow Relay convention: `first`, `after`, `last`, `before`
- [ ] Filter arguments are descriptive: `where`, `status`, `query`
- [ ] Sort arguments use `orderBy` or `sortBy` consistently
- [ ] Input arguments for mutations are a single required object: `input: CreateProductInput!`
- [ ] ID arguments are named `id` (singular) or `ids` (plural), not `productId` at the query root level
- [ ] Boolean arguments are avoided when a separate field or enum is clearer

### Examples

```graphql
type Query {
  # Good -- Relay pagination, descriptive filter
  products(
    first: Int
    after: String
    last: Int
    before: String
    query: String
    status: ProductStatus
    orderBy: ProductOrderField
  ): ProductConnection!

  # Good -- simple ID lookup
  product(id: ID!): Product

  # Bad -- non-standard pagination, boolean flag
  products(
    limit: Int
    offset: Int
    includeArchived: Boolean
  ): [Product!]!
}
```

### Boolean argument trap

Boolean arguments often signal that two separate fields would be cleaner:

```graphql
# Avoid -- boolean flag creates a branching API
type Query {
  posts(includeArchived: Boolean): [Post!]!
}

# Prefer -- separate fields with clear intent
type Query {
  posts: [Post!]!
  archivedPosts: [Post!]!
}
```

---

## 5. Enum Naming

Enum type names are **PascalCase**. Enum values are **SCREAMING_SNAKE_CASE**.

### Checklist

- [ ] Enum type names are PascalCase: `ProductStatus`, `SortOrder`, `OrderState`
- [ ] Enum values are SCREAMING_SNAKE_CASE: `IN_PROGRESS`, `SORT_DESC`, `ACTIVE`
- [ ] Enum type names do not include "Enum" suffix: `ProductStatus` not `ProductStatusEnum`
- [ ] Enum values are not prefixed with the type name: `ACTIVE` not `PRODUCT_STATUS_ACTIVE`
- [ ] Enum type names describe the dimension: `SortOrder` not `Sort`, `ProductStatus` not `Status`

### Examples

```graphql
# Good
enum OrderStatus {
  PENDING
  IN_PROGRESS
  SHIPPED
  DELIVERED
  CANCELLED
}

enum SortDirection {
  ASC
  DESC
}

# Bad -- wrong casing, redundant prefix
enum orderStatus {
  orderStatusPending
  orderStatusShipped
}

enum Sort {
  Ascending
  Descending
}
```

---

## 6. Consistency Rules

These rules apply across every naming decision and are the most common source of
client frustration when violated.

### Checklist

- [ ] Same verb for the same concept everywhere: if `create` is used for one entity, it is used for all entities
- [ ] Same suffix for the same structural role: all inputs end with `Input`, all payloads end with `Payload`
- [ ] Symmetric operations exist in pairs: `publish`/`unpublish`, `add`/`remove`, `enable`/`disable`
- [ ] Domain terms are used consistently: if it is called `Post` in one place, it is not `BlogPost` or `Article` in another unless they are different concepts
- [ ] Field names for the same concept match across types: `createdAt` everywhere, not `createdAt` on one type and `dateCreated` on another
- [ ] Casing rules are never mixed: no `totalPrice` alongside `total_count`
- [ ] New names follow established patterns: before adding a field, check what similar fields are called

### Consistency audit questions

Before adding any new name to the schema, ask:

1. Is there an existing name for this concept? Use it.
2. Does this follow the same casing and suffix rules as similar items?
3. If a client knows the pattern for entity A, can they predict this name for entity B?
4. Does this name have a symmetric counterpart that should also exist?

---

## 7. Anti-Pattern Quick Reference

| Anti-Pattern | Problem | Fix |
|---|---|---|
| `getProducts`, `findPosts` | Unnecessary verb prefix on queries | `products`, `posts` |
| `products` and `findPosts` in same schema | Inconsistent query naming | Pick one pattern for all |
| `addProduct` and `createPost` | Inconsistent mutation verbs | Use `create` or `add` consistently |
| `User` for both viewer and team member | Too-generic name blocks future evolution | `Viewer`, `TeamMember` with `User` interface |
| `formattedBusinessAddress` on `BusinessAddress` | Redundant namespace within parent type | `formatted` |
| `publishPost` without `unpublishPost` | Missing symmetric action | Add the symmetric mutation |
| `updateCheckout(email, items, card)` | God mutation that does everything | `updateCheckoutEmail`, `addItemToCheckout`, etc. |
| `postUser`, `putProduct` | REST verb leakage in mutations | `createUser`, `updateProduct` |
| `orderStatus_PENDING` | Enum value prefixed with type name | `PENDING` |
| `product_status` (snake_case enum type) | Wrong casing for enum type | `ProductStatus` |
| `isActive: String` | Boolean-sounding name with non-boolean type | Use `Boolean` or rename the field |
| `items` and `itemsList` in same schema | Inconsistent pluralization | Pick one pattern |
| `ItemInterface` | "Interface" in interface name | `Item` or adjective like `Purchasable` |
| `Status` (too generic enum name) | Name collision risk as schema grows | `OrderStatus`, `ProductStatus` |
| `updateBook(archived: true)` | Generic update hiding a state change | `archiveBook` named mutation |
| `Category` without namespace | Ambiguous when multiple domains have categories | `BusinessCategory`, `ProductCategory` |

---

## Quick Reference Card

| Element            | Casing               | Suffix / Convention              | Example                    |
|--------------------|----------------------|----------------------------------|----------------------------|
| Object type        | PascalCase           | None                             | `Product`                  |
| Input type         | PascalCase           | `Input`                          | `CreateProductInput`       |
| Payload type       | PascalCase           | `Payload`                        | `CreateProductPayload`     |
| Connection type    | PascalCase           | `Connection`                     | `ProductConnection`        |
| Edge type          | PascalCase           | `Edge`                           | `ProductEdge`              |
| Error type         | PascalCase           | `Error`                          | `ProductNotFoundError`     |
| Interface          | PascalCase           | Adjective form                   | `Starrable`, `Commentable` |
| Enum type          | PascalCase           | Descriptive dimension            | `OrderStatus`              |
| Enum value         | SCREAMING_SNAKE_CASE | No type prefix                   | `IN_PROGRESS`              |
| Field              | camelCase            | Predicate prefix for booleans    | `isActive`, `totalPrice`   |
| Argument           | camelCase            | Relay names for pagination       | `first`, `after`           |
| Mutation           | camelCase            | Verb-first action                | `createProduct`            |
