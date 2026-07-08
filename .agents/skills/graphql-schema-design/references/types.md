# Type Design, Abstract Types, Sharing, and Authorization

Reference for GraphQL type design patterns, abstract type usage, type sharing
anti-patterns, authorization strategies, and global identification.

---

## Type Design Patterns

### 1. Avoid Anemic Types

Expose computed fields that clients actually need rather than forcing them to
derive values from raw data.

```graphql
# WRONG -- forces client-side computation
type Product {
  price: Money!
  discounts: [Discount!]!
  taxes: [Tax!]!
}

# RIGHT -- server owns the computation
type Product {
  price: Money!
  discounts: [Discount!]!
  taxes: [Tax!]!
  totalPrice: Money!
}
```

**Why it matters:**
- Client-side logic goes stale when underlying data rules evolve
- Multiple clients reimplement the same formula with subtle differences
- If clients are computing something from multiple fields, that computation
  belongs on the server as its own field

### 2. Group Related Fields (Prefix Smell Detection)

If multiple fields share a prefix, they belong in a nested object type.

```graphql
# SMELL -- shared prefix "creditCard"
type Payment {
  creditCardNumber: String
  creditCardExp: String
  creditCardCvv: String
  giftCardCode: String
}

# BETTER -- grouped into CreditCard type
type Payment {
  creditCard: CreditCard
  giftCardCode: String
}

type CreditCard {
  number: CreditCardNumber!
  expiration: CreditCardExpiration!
}

type CreditCardExpiration {
  isExpired: Boolean!
  month: Int!
  year: Int!
}

scalar CreditCardNumber
```

**Benefits of grouping:**
- Non-null guarantees within the group (if `creditCard` exists, all sub-fields exist)
- Better evolution path -- add fields to the nested type without polluting the parent
- Cleaner, more navigable schema

**Rule of three:** Start flat, group when reaching three related fields with a
shared prefix.

### 3. Custom Scalars

Use custom scalars to add semantic value beyond what `String` or `Int` provide.

| Scalar       | Instead of      | Benefit                              |
|--------------|-----------------|--------------------------------------|
| `DateTime`   | `String`        | Validation, parsing consistency      |
| `Email`      | `String`        | Input validation, semantic clarity   |
| `URL`        | `String`        | Format validation                    |
| `HTML`       | `String`        | Client knows to render as HTML       |
| `Markdown`   | `String`        | Client knows to render as markdown   |
| `Money`      | `Int` / `Float` | Currency handling, precision         |
| `UUID`       | `String`        | Format validation                    |

Custom scalars enable consistent validation across the entire schema and
document format expectations via their descriptions.

### 4. Expressive Schemas -- Make Impossible States Impossible

Design types so the schema itself prevents inconsistent data.

```graphql
# BAD -- allows impossible states (paid=true, amountPaid=null)
type Cart {
  paid: Boolean
  amountPaid: Money
  items: [CartItem!]!
}

# GOOD -- if payment exists, all payment fields are guaranteed present
type Cart {
  payment: Payment
  items: [CartItem!]!
}

type Payment {
  paid: Boolean!
  amountPaid: Money!
}
```

**Additional principles:**

- **Use enums for known value sets.** Never `type: String!` when values are
  `APPAREL | FOOD | TOYS`.
- **Use default values** to document default behavior:
  `products(sort: SortOrder = DESC)` rather than hiding the default in resolver
  logic.
- **Avoid the `JSON` scalar.** Use typed structures. Unstructured data
  forfeits all schema benefits.

### 5. One Field, One Job

Split ambiguous optional arguments into separate fields.

```graphql
# WRONG -- what happens if both are provided? Neither?
type Query {
  findProduct(id: ID, name: String): Product
}

# RIGHT -- each field has a single, required argument
type Query {
  productByID(id: ID!): Product
  productByName(name: String!): Product
}
```

Adding multiple entry points to the same data is not wasteful in GraphQL.
Clients select only the fields they use, so additional fields add zero overhead
for clients that ignore them. A conditional described in a field's documentation
("pass id OR name") is a schema smell.

### 6. Object References over IDs

```graphql
# ANTI-PATTERN -- forces extra round-trip
type Collection {
  imageId: ID
}

# PATTERN -- traverse the graph
type Collection {
  image: Image
}
```

- Clients select only the sub-fields they need -- no over-fetching concern
- This is GraphQL's core strength: traversing the graph in a single request
- Raw ID fields force clients into a second query to resolve the object

---

## Abstract Types

### 7. Interface vs Union -- Decision Tree

```
Do the types share common BEHAVIOR (actions/contracts)?
  (all can be starred, all can be discounted, all are commentable)
  |
  YES --> Interface
  |        Name as adjective: Starrable, Discountable, Commentable
  |        Interface fields represent the shared behavior contract
  |
  NO
  |
  Do the types merely share some FIELDS but no common behavior?
  |
  YES --> Do NOT use an interface
  |        Use code-level composition/inheritance instead
  |        "ItemFields" or "ItemInterface" naming is a smell
  |
  NO
  |
  Could a field return completely disjoint types?
  (search results: Products, Articles, Users)
  |
  YES --> Union
  |        Union = "bag of possible return types"
  |        No shared fields required
  |
  Is this for error handling (Success | Error1 | Error2)?
  |
  YES --> Union with Error interface
           Combine union for exhaustive matching +
           interface for base error fields
```

**Example -- interface for shared behavior:**
```graphql
interface CatalogEntry {
  id: ID!
  title: String!
}

type PhysicalProduct implements CatalogEntry {
  id: ID!
  title: String!
  weightGrams: Int!
}

type DigitalProduct implements CatalogEntry {
  id: ID!
  title: String!
  downloadUrl: URL!
}

type SubscriptionPlan implements CatalogEntry {
  id: ID!
  title: String!
  billingInterval: BillingInterval!
}
```

This eliminates nullable fields and makes impossible states impossible.
A flat `CatalogEntry` with optional `weightGrams`, `downloadUrl`, and
`billingInterval` allows illegal combinations the abstract version prevents.

### 8. Interface Naming

| Form       | Use when                                    | Examples                          |
|------------|---------------------------------------------|-----------------------------------|
| Adjective  | Behavioral interface (actions/capabilities) | `Starrable`, `Discountable`, `Commentable`, `Assignable`, `Closable` |
| Noun       | Entity-like interface (identity contracts)  | `Node`, `Actor`                   |

**Never use:** `ItemInterface`, `ItemFields`, `ItemInfo`, `ItemBase` --
these names signal the interface exists for field sharing, not behavior.

### 9. When NOT to Use Interfaces

- The interface exists solely for **field sharing** (code reuse), not a
  behavioral contract
- The name is awkward, or includes "Interface", "Fields", "Info", "Base"
- The implementing types will inevitably **diverge** in behavior
- You keep adding fields to the interface just to satisfy one implementor

**Code reuse is not type reuse.** If your implementation language makes it
easy to share field definitions via helpers, composition, or inheritance -- use
those mechanisms. Do not reach for a GraphQL interface to solve a code
organization problem.

### 10. Evolution Implications (Abstract Types are "Dangerous" to Extend)

- Adding a new **union member** is a **dangerous change** -- clients may not
  handle the new case
- Adding a new **interface implementation** is equally dangerous
- GraphQL has no built-in exhaustive matching enforcement
- Clients should always code defensively with a fallback for unknown types
- When using union error types, use an `Error` interface so unknown errors
  still return at least `message`:

```graphql
# Forward-compatible error handling
... on Error { message code }   # Catches current AND future error types
```

Document that new types may be added. Warn clients they must handle
unknown variants gracefully.

---

## Sharing Anti-Patterns

### 11. Never Share Connection Types

```graphql
# WRONG -- shared UserConnection
type Organization {
  users: UserConnection!
}
type Team {
  members: UserConnection!   # Same type -- locked together forever
}

type UserEdge {
  node: User
  # Can't add isTeamLeader here without it appearing on org users
  # Can't add isOrganizationAdmin without it appearing on team members
}
```

```graphql
# RIGHT -- separate connection types per context
type Organization {
  users: OrganizationUserConnection!
}
type Team {
  members: TeamMemberConnection!
}

type TeamMemberEdge {
  node: User
  role: TeamMemberRole!       # Team-specific edge data
}

type OrganizationUserEdge {
  node: User
  isAdmin: Boolean!           # Org-specific edge data
}
```

Connections and edges carry relationship metadata. Different relationships
produce different metadata. Sharing a connection type locks both contexts to
the same edge shape forever.

### 12. Never Share Input Types

```graphql
# WRONG -- shared input
input ProductInput {
  name: String       # Must be nullable for update, but create needs it
  price: MoneyInput
}

type Mutation {
  createProduct(input: ProductInput): CreateProductPayload
  updateProduct(id: ID!, input: ProductInput): UpdateProductPayload
}
```

```graphql
# RIGHT -- separate inputs
input CreateProductInput {
  name: String!             # Required for creation
  price: MoneyInput!        # Required for creation
}

input UpdateProductInput {
  name: String              # Optional for update
  price: MoneyInput         # Optional for update
}
```

Create inputs have more non-null fields because you cannot create without
required data. Sharing forces you to make everything nullable and push
validation to runtime -- exactly what the schema should handle for you.

### 13. Never Share Payload Types

Each mutation gets its own payload type. Always. No exceptions.

Payloads diverge as mutations gain mutation-specific error cases, warnings,
or supplementary data. Sharing payloads creates the same lock-in as shared
connections.

### 14. Code Reuse Does Not Equal Type Reuse

| Reuse level   | Appropriate?  | Mechanism                              |
|---------------|---------------|----------------------------------------|
| Code          | Yes           | Helpers, composition, base classes     |
| GraphQL type  | Almost never  | Separate types per context             |

When there is any doubt, the downsides of sharing outweigh the benefits.
The cost of splitting later is much higher than starting separate.

---

## Authorization Patterns

### 15. Object-Level vs Field-Level Authorization -- Decision Tree

```
Is this about API scopes (which resources a client can access)?
  |
  YES --> Object-level authorization
  |        Types map well to API scopes
  |        Scalar fields on a type share the same permissions
  |        Prevents the "hidden path" problem
  |
  NO
  |
  Is this about business rules (can this user perform this action)?
  |
  YES --> Domain layer, NOT the GraphQL layer
  |        Business rules must be consistent across all entry points
  |        GraphQL is one of many; rules belong in the application/domain layer
  |
  NO
  |
  Is there a field-specific permission (e.g., salary on Employee)?
  |
  YES --> Field-level authorization (as an exception)
           Prefer restructuring first:
             EmployeeProfile vs EmployeePrivateDetails
           If unavoidable, authorize at field level
           SUPPLEMENTARY to object-level auth, never a replacement
```

### 16. The Hidden Path Problem

```graphql
# DANGEROUS -- field-level auth only
type Query {
  adminThings: AdminOnlyType! @auth(scope: "admin")    # Protected
  product: Product! @auth(scope: "products")            # Less protected
}

type Product {
  settings: AdminOnlyType!   # UNPROTECTED via product path!
}
```

A client with `products` scope can reach `AdminOnlyType` through
`product.settings` without ever hitting the admin auth check.

**Fix:** Authorize at the TYPE level. No matter how a client reaches
`AdminOnlyType`, the authorization check fires.

### 17. Null vs Error for Unauthorized Access

- Return **null** for unauthorized access -- do not leak resource existence
- A `node(id: ID!)` query returning null should be indistinguishable from
  "does not exist"
- Never return `403 Forbidden` or authorization errors that confirm an
  entity exists
- The type must be **nullable** to support this pattern (non-null + auth =
  null propagation disaster that destroys sibling data)

### 18. API Scopes vs Business Rules -- Separation of Concerns

| Layer   | Concern                  | Example                                  |
|---------|--------------------------|------------------------------------------|
| GraphQL | API scope enforcement    | "This API key can read products"         |
| Domain  | Business rule enforcement| "Only team admins can close issues"      |

- API scopes determine what parts of the graph a client can see
- Business rules determine what actions a user can perform
- Business rules belong in the domain/application layer, enforced identically
  regardless of entry point (GraphQL, REST, queue handler, CLI)
- Never implement business authorization as GraphQL-layer checks

---

## Global Identification

### 19. Node Interface Pattern

```graphql
interface Node {
  id: ID!
}

type Product implements Node {
  id: ID!
  name: String!
}

type User implements Node {
  id: ID!
  login: String!
}

type Query {
  node(id: ID!): Node
  nodes(ids: [ID!]!): [Node]!
}
```

- `Node` signals: "this object is persisted, has identity, and is refetchable"
- Major business entities should implement `Node`
- Value objects or transient data should NOT implement `Node`
- Enables client-side normalized caching and single-query refetching

### 20. Opaque ID Design

- IDs must be **opaque** -- clients must not parse, construct, or assume
  structure
- Use Base64 encoding to signal opacity:
  `base64("Product:12345")` produces `UHJvZHVjdDoxMjM0NQ==`
- Include routing info for distributed systems: `shop_id:type:entity_id`
- Consider prefixed opaque IDs for developer ergonomics (Slack pattern):
  `P_abc123` for Products, `U_def456` for Users
- Never expose raw database IDs as the GraphQL `ID`

**What to encode in the ID:**
- At minimum: `type_name:database_id`
- For distributed systems: any routing info needed to globally locate the node
  (e.g., `shop_id:type_name:entity_id`)
- The goal is that `node(id: "...")` can resolve without any additional context

---

## Quick Reference -- Anti-Pattern Table

| Anti-Pattern                                  | Fix                                                  |
|-----------------------------------------------|------------------------------------------------------|
| `findProduct(id: ID, name: String)`           | Split: `productByID(id: ID!)` + `productByName(name: String!)` |
| `creditCardNumber` + `creditCardExp` on type  | Nested `creditCard: CreditCard` object               |
| Shared `UserConnection` across contexts       | `TeamMemberConnection` + `OrganizationUserConnection`|
| `type: String!` for known value set           | `type: ProductType!` with enum                       |
| `imageId: ID` on a type                       | `image: Image` -- traverse the graph                 |
| `ItemInterface` / `ItemFields` naming         | Adjective form: `Purchasable`, `Discountable`        |
| Auth on fields only, not types                | Object-level auth prevents hidden path vulnerabilities|
| Shared `ProductInput` for create and update   | `CreateProductInput` + `UpdateProductInput`           |
| Shared payload types across mutations         | One payload type per mutation, always                 |
| `JSON` scalar for structured data             | Typed structures: `[MetaAttribute!]!`                |
