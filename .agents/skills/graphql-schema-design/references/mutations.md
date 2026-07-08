# Mutation Design Patterns

Comprehensive reference for designing GraphQL mutations. All examples use pure
GraphQL SDL -- no framework-specific code.

---

## 1. Input Type Design

### Core Rules

- [ ] Every mutation gets a **unique input type** -- never shared across mutations
- [ ] Use a **single required input argument** per mutation (Relay convention)
- [ ] Input types should be **strongly typed** -- avoid all-nullable kitchen-sink inputs
- [ ] Name inputs `{MutationName}Input`: `CreateProductInput`, `AddItemToCheckoutInput`
- [ ] **Never share** input types between create and update mutations

### Why Unique Inputs Per Mutation?

Create mutations need **non-null** fields (you must supply a name to create a product).
Update mutations need **nullable** fields (you only send what changed). Sharing a single
`ProductInput` forces everything nullable, destroying type safety.

```graphql
# CORRECT -- separate inputs with appropriate nullability
input CreateProductInput {
  name: String!
  price: Money!
  categoryId: ID!
}

input UpdateProductInput {
  name: String
  price: Money
  categoryId: ID
}

# WRONG -- shared input, everything nullable
input ProductInput {
  name: String
  price: Money
  categoryId: ID
}
```

### Nested Input Types

Group related fields into sub-inputs for clarity and reuse within a single mutation.

```graphql
input CreateOrderInput {
  items: [OrderItemInput!]!
  shippingAddress: AddressInput!
  billingAddress: AddressInput
}

input AddressInput {
  street: String!
  city: String!
  postalCode: String!
  country: String!
}

input OrderItemInput {
  productId: ID!
  quantity: Int!
}
```

### @oneOf for Exclusive Inputs

When exactly one of several input fields should be provided, use `@oneOf` to express
mutual exclusivity in the schema.

```graphql
input PaymentMethodInput @oneOf {
  creditCard: CreditCardInput
  bankTransfer: BankTransferInput
  digitalWallet: DigitalWalletInput
}
```

### Boolean Arguments

Replace boolean toggles with separate fields or separate mutations.

```graphql
# WRONG
type Query {
  posts(includeArchived: Boolean): [Post!]!
}

# CORRECT -- explicit fields
type Query {
  posts: [Post!]!
  archivedPosts: [Post!]!
}
```

### Input Design Checklist

- [ ] Single required input argument
- [ ] Unique type name matching the mutation name
- [ ] Non-null fields on create inputs, nullable on update inputs
- [ ] Nested sub-inputs for grouped fields (address, line items)
- [ ] `@oneOf` for mutually exclusive options
- [ ] No boolean flags -- use separate mutations or enum arguments instead

---

## 2. Payload Type Design

### Core Rules

- [ ] Every mutation gets a **unique payload type** -- no sharing, no exceptions
- [ ] Name payloads `{MutationName}Payload`: `CreateProductPayload`
- [ ] Return the **mutated entity** so clients can update their cache
- [ ] Return **affected parent entities** that clients may need to refetch
- [ ] Include **typed error information** (via union or errors field)

### Payload Structure

```graphql
type CreateProductPayload {
  product: Product           # The mutated entity (nullable -- null on failure)
  errors: [CreateProductError!]  # Typed errors (null on success, non-null on failure)
}

union CreateProductError =
  | ValidationError
  | DuplicateNameError
  | UnauthorizedError
```

### Returning Affected Parents

When a mutation changes child data, return the parent so the client can refetch
aggregate fields without a separate query.

```graphql
type AddItemToCheckoutPayload {
  checkoutItem: CheckoutItem   # The new item
  checkout: Checkout           # Parent -- totalPrice, itemCount may have changed
  errors: [AddItemToCheckoutError!]
}
```

### Returning the Query Root

For mutations that affect broad application state, include a `query` field pointing
to the root query type. This lets clients refetch anything in a single round-trip.

```graphql
type ImportProductsPayload {
  importedCount: Int!
  query: Query       # Clients can refetch any top-level field
  errors: [ImportProductsError!]
}
```

### Payload Design Checklist

- [ ] Unique payload type per mutation
- [ ] Contains the mutated entity (nullable for failure cases)
- [ ] Contains affected parent entities when relevant
- [ ] Contains typed errors as a nullable list (null = success, non-null = errors)
- [ ] Consider `query: Query` field for broad-impact mutations

---

## 3. Granularity Decision Tree

Use this tree to decide whether a mutation should be coarse-grained (one call does
many things) or fine-grained (one call does one thing).

```
Is the client CREATING a new entity from scratch?
|
+-- YES --> Use a COARSE-GRAINED create mutation
|           (one call creates the entity with all required data)
|           Example: createCheckout(input: { email, items, address })
|
+-- NO --> Is this an UPDATE or ACTION on an existing entity?
    |
    +-- YES --> Use FINE-GRAINED action mutations
    |           (each mutation does one named thing)
    |           Examples: addItemToCheckout, updateCheckoutAddress,
    |                     removeItemFromCheckout
    |
    +-- Do 3+ fine-grained mutations NEED to succeed together?
        |
        +-- YES --> That is a USE CASE. Design a single coarser
        |           mutation for it.
        |           Example: completeCheckout (validates items,
        |                    charges payment, creates order)
        |
        +-- NO --> Keep them separate and fine-grained.

Secondary check:

Does the UI action map to a SINGLE button or form submit?
|
+-- YES --> Consider a single mutation matching that action
|
+-- NO --> Fine-grained mutations per sub-action
```

### Rules of Thumb

1. **Coarse creates, fine-grained updates.** Entities are often created in one step
   but modified incrementally.
2. **Name the action, not the data.** `archiveBook` not `updateBook(archived: true)`.
3. **When clients manage partial failures, you went too fine.** If three mutations
   must all succeed, that is one use case -- one mutation.
4. **Network cost matters.** While fine-grained is ideal, each mutation is a network
   round-trip. Balance purity with practicality.

---

## 4. Anemic Mutations

### What Is an Anemic Mutation?

An anemic mutation exposes raw data modification instead of meaningful domain
actions. It is the GraphQL equivalent of Martin Fowler's "Anemic Domain Model" --
your schema becomes a dumb bag of data rather than expressing behaviors.

### The Problem

```graphql
# ANEMIC -- one giant mutation that sets raw fields
type Mutation {
  updateCheckout(input: UpdateCheckoutInput): UpdateCheckoutPayload
}

input UpdateCheckoutInput {
  email: Email
  address: Address
  items: [ItemInput!]
  creditCard: CreditCard
  billingAddress: Address
}
```

**Why this is harmful:**

- Clients must **guess** which combination of fields to send for a given action
- Everything is nullable, so the schema communicates **nothing** about requirements
- The server cannot return **specific errors** -- any field could have caused failure
- Business logic leaks to clients (e.g., "to add an item, also update totals")
- Adding a field to the input is a **silent contract change** -- existing clients break

### The Fix: Action-Based Mutations

```graphql
# ACTION-BASED -- each mutation is a named domain action
type Mutation {
  addItemToCheckout(input: AddItemToCheckoutInput!): AddItemToCheckoutPayload!
  removeItemFromCheckout(input: RemoveItemFromCheckoutInput!): RemoveItemFromCheckoutPayload!
  updateCheckoutAddress(input: UpdateCheckoutAddressInput!): UpdateCheckoutAddressPayload!
  applyDiscountToCheckout(input: ApplyDiscountInput!): ApplyDiscountPayload!
}

input AddItemToCheckoutInput {
  checkoutId: ID!
  item: ItemInput!        # Non-null -- this field is REQUIRED
}
```

**Benefits of action-based design:**

- Schema is **strongly typed** -- nothing optional that should be required
- Clients know **exactly** what to provide for each action
- Server returns **specific error types** per action
- Impossible for clients to reach an inconsistent state
- Side effects (events, subscriptions) map cleanly to specific mutations

### Detection Checklist

Your mutation may be anemic if:

- [ ] The input type has more than 5 nullable fields
- [ ] The mutation name starts with `update` and the input mirrors the entity shape
- [ ] Clients must send unrelated fields together to achieve one action
- [ ] You cannot describe what the mutation "does" in one sentence without saying "updates"
- [ ] The same mutation handles conceptually different operations (add, remove, modify)

---

## 5. Batch and Transaction Patterns

### The Problem with Sequential Mutations

GraphQL executes root mutation fields sequentially, but there is **no transaction
boundary** across them. If a client sends:

```graphql
mutation {
  op1: addProductToCheckout(...) { id }
  op2: addProductToCheckout(...) { id }
  op3: addProductToCheckout(...) { id }
}
```

Then `op1` may succeed, `op2` may fail, and `op3` may succeed -- leaving the
client in an inconsistent state. Additionally, this requires dynamic query string
construction, which defeats static analysis tooling.

### Solution A: Plural Mutations

For operations on multiple items of the **same type**, design a plural mutation.

```graphql
type Mutation {
  addProductsToCheckout(
    input: AddProductsToCheckoutInput!
  ): AddProductsToCheckoutPayload!
}

input AddProductsToCheckoutInput {
  checkoutId: ID!
  items: [CheckoutItemInput!]!
}

input CheckoutItemInput {
  productId: ID!
  quantity: Int!
}
```

This solves both the transaction problem (all-or-nothing on the server) and the
static query problem (one mutation, variable number of items via input list).

### Solution B: Operations List

For **mixed operations** (add + remove + update in one call), use an operations
list with an enum discriminator.

```graphql
type Mutation {
  updateCartItems(
    input: UpdateCartItemsInput!
  ): UpdateCartItemsPayload!
}

input UpdateCartItemsInput {
  cartId: ID!
  operations: [CartItemOperationInput!]!
}

input CartItemOperationInput {
  operation: CartItemOperation!
  ids: [ID!]!
}

enum CartItemOperation {
  ADD
  REMOVE
}
```

Usage:

```graphql
mutation {
  updateCartItems(input: {
    cartId: "abc123"
    operations: [
      { operation: ADD, ids: ["item1", "item2"] }
      { operation: REMOVE, ids: ["item3"] }
    ]
  }) {
    cart {
      items { name }
    }
  }
}
```

### Solution C: Typed Operation Variants

When different operations require **different inputs**, use separate optional fields
per operation type. Pair with `@oneOf` when available.

```graphql
input CartItemOperationInput @oneOf {
  add: CartItemAddInput
  remove: CartItemRemoveInput
  updateQuantity: CartItemUpdateQuantityInput
}

input CartItemAddInput {
  productId: ID!
  quantity: Int!
}

input CartItemRemoveInput {
  itemId: ID!
}

input CartItemUpdateQuantityInput {
  itemId: ID!
  quantity: Int!
}
```

### Batch Decision Checklist

- [ ] Multiple items of same type? --> Plural mutation with list input
- [ ] Mixed operations that must be atomic? --> Operations list with enum discriminator
- [ ] Different input shapes per operation? --> Typed operation variants with `@oneOf`
- [ ] Clients building dynamic query strings? --> Redesign as single mutation with variables

---

## 6. Async Mutation Patterns

### When to Use

Use async patterns when a mutation triggers work that takes longer than a
typical HTTP request timeout (bulk imports, payment processing, report generation,
external system orchestration).

### The Job Pattern

Return a `Job` type that clients can poll or subscribe to for completion.

```graphql
type Mutation {
  importProducts(input: ImportProductsInput!): ImportProductsPayload!
}

type ImportProductsPayload {
  job: Job
  errors: [ImportProductsError!]!
}

type Job {
  id: ID!
  status: JobStatus!
  result: JobResult
  createdAt: DateTime!
  completedAt: DateTime
  query: Query            # Root query for post-completion refetching
}

enum JobStatus {
  PENDING
  IN_PROGRESS
  COMPLETED
  FAILED
  CANCELED
}

union JobResult = ImportProductsResult | JobFailure

type ImportProductsResult {
  importedCount: Int!
  skippedCount: Int!
}

type JobFailure {
  message: String!
  code: String
}
```

### Discriminated State Pattern

Model async states as a union of explicit types rather than a status enum.
Each state carries only the fields relevant to it.

```graphql
union PaymentState =
  | PendingPayment
  | ProcessingPayment
  | CompletedPayment
  | FailedPayment

type PendingPayment {
  id: ID!
  amount: Money!
  createdAt: DateTime!
}

type ProcessingPayment {
  id: ID!
  amount: Money!
  processorTransactionId: String!
}

type CompletedPayment {
  id: ID!
  amount: Money!
  receipt: Receipt!
  completedAt: DateTime!
}

type FailedPayment {
  id: ID!
  amount: Money!
  failureReason: String!
  canRetry: Boolean!
}
```

### Async Mutation Checklist

- [ ] Operation takes > 5 seconds? --> Return a Job, not the result
- [ ] Clients need to poll? --> Expose `job(id: ID!): Job` query field
- [ ] Clients need push updates? --> Expose `jobStatusChanged(jobId: ID!)` subscription
- [ ] Job completion triggers broad state change? --> Include `query: Query` on Job type
- [ ] States have different data shapes? --> Use discriminated union over status enum

---

## 7. Anti-Pattern Reference

| Anti-Pattern | Problem | Fix |
|---|---|---|
| **Kitchen-sink update** `updateCheckout(email, address, items, card)` | All fields nullable, clients guess which to send, no clear action semantics | Split into action-based mutations: `addItemToCheckout`, `updateCheckoutAddress` |
| **Shared input types** `ProductInput` for both create and update | Create needs non-null, update needs nullable -- shared type forces all nullable | Unique inputs: `CreateProductInput` (non-null) + `UpdateProductInput` (nullable) |
| **Generic CRUD update** `updateBook(archived: true)` | Hides domain actions behind data manipulation, weak error modeling | Action-based: `archiveBook`, `renameBook` |
| **Sequential dependent mutations** 3 mutations that must all succeed | Partial failures, client manages retries, inconsistent state | Single coarser mutation for the combined use case |
| **Dynamic query construction** Generating mutation aliases in a loop | Defeats static analysis, unpredictable at runtime, hard to cache | Plural mutation: `addProductsToCheckout(items: [ItemInput!]!)` |
| **Bare entity return** `createProduct: Product` | Cannot evolve return type, no error field, no affected-parent fields | Payload type: `CreateProductPayload { product, errors }` |
| **Void mutations** `deleteProduct: Boolean` | No entity to update in cache, no error detail, no undo info | Payload: `DeleteProductPayload { deletedProductId, errors }` |
| **Symmetric nullable CRUD** Same input for create/read/update/delete | Schema communicates nothing; each operation has different requirements | Separate mutation per action with appropriately typed inputs |

---

## Quick Reference: Mutation Anatomy

```graphql
# Complete well-designed mutation
type Mutation {
  addItemToCheckout(
    input: AddItemToCheckoutInput!      # 1. Unique, required input
  ): AddItemToCheckoutPayload!           # 2. Unique payload
}

input AddItemToCheckoutInput {           # 3. Strongly typed, nothing optional
  checkoutId: ID!                        #    that should be required
  item: CheckoutItemInput!
}

input CheckoutItemInput {                # 4. Nested input for grouped fields
  productId: ID!
  quantity: Int! = 1                     # 5. Defaults document behavior
}

type AddItemToCheckoutPayload {
  checkoutItem: CheckoutItem             # 6. Mutated entity (nullable on failure)
  checkout: Checkout                     # 7. Affected parent
  errors: [AddItemToCheckoutError!]      # 8. Typed errors (null on success)
}

union AddItemToCheckoutError =           # 9. Specific error types
  | CheckoutNotFoundError
  | ProductNotFoundError
  | OutOfStockError
  | ValidationError
```
