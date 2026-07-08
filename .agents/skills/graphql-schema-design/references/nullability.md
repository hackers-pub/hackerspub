# GraphQL Nullability Reference

Comprehensive reference for nullability decisions in GraphQL schema design.

---

## 1. Nullability Decision Tree

Every field and argument in a GraphQL schema must have a nullability decision.
The correct choice depends on whether the position is **input** or **output**,
and on the runtime characteristics of the data behind it.

```
Is this an INPUT argument or field?
|
+-- YES
|   |
|   +-- Is this argument required for the operation to make sense?
|   |   |
|   |   +-- YES --> Non-null (String!, ID!, Int!)
|   |   |           The operation cannot proceed without this value.
|   |   |
|   |   +-- NO  --> Nullable (String, ID, Int)
|   |               Optional filters, sorting preferences, or arguments
|   |               added after initial release for backwards compatibility.
|   |
|   +-- Are you ADDING a new argument to an existing field?
|       |
|       +-- YES --> Nullable, or non-null with a default value
|       |           Making it required would break all existing clients.
|       |
|       +-- NO  --> Apply the required/optional rule above.
|
+-- NO --> This is an OUTPUT field
    |
    +-- Is it a Boolean?
    |   |
    |   +-- YES --> Non-null (Boolean!)
    |               A nullable Boolean creates a tri-state (true/false/null)
    |               which is almost always a design smell.
    |
    +-- Is it a list field?
    |   |
    |   +-- YES --> See List Nullability Matrix (Section 2)
    |
    +-- Is it a simple scalar on an already-loaded parent object?
    |   |
    |   +-- YES --> Generally safe to make non-null (String!, Int!)
    |   |           The parent is loaded; these fields come with it.
    |   |
    |   +-- NO  --> Continue below
    |
    +-- Is it backed by a database association, network call, or external service?
    |   |
    |   +-- YES --> Almost always NULLABLE
    |               Anything involving I/O can fail: timeouts, transient errors,
    |               rate limits, partial outages. Nullable fields contain the
    |               blast radius.
    |
    +-- Is it an object type you are confident will never be null?
    |   |
    |   +-- YES --> Think twice before making non-null.
    |   |           - Will this type be reused in other contexts?
    |   |           - Could the backing architecture change?
    |   |           - Non-null to nullable is a BREAKING change.
    |   |           If still confident: non-null. Otherwise: nullable.
    |   |
    |   +-- NO  --> NULLABLE
    |
    +-- Is this a mutation payload entity field?
        |
        +-- YES --> NULLABLE
                    Return null when the mutation fails;
                    use a non-null errors field to explain why.
```

---

## 2. List Nullability Matrix

There are four possible list signatures in GraphQL. Each carries different
guarantees about both the list itself and its items.

| Signature | List can be null? | Items can be null? | When to use |
|-----------|-------------------|--------------------|-------------|
| `[T!]!`  | No                | No                 | **Default for most lists.** Empty list means "none." Every item is guaranteed valid. Use this unless you have a specific reason not to. |
| `[T!]`   | Yes               | No                 | When the list itself might not be applicable. `null` means "this concept does not apply here"; `[]` means "applies but empty." Rare. |
| `[T]!`   | No                | Yes                | When individual items might fail to resolve but the list always exists. Useful when loading a batch where some items error independently. Uncommon. |
| `[T]`    | Yes               | Yes                | Maximum flexibility, minimum guarantees. Avoid in almost all cases. Only appropriate when both the list and individual items can independently be absent or fail. |

**Rule of thumb:** Default to `[T!]!` for output types. Only deviate when there
is a genuine semantic distinction between a null list and an empty list, or when
individual items can independently fail.

For input types, `[T!]!` is also the default for required list arguments.
Use `[T!]` (nullable outer) when the list argument is optional.

---

## 3. Null Propagation (Null Bubbling)

When a non-null field resolves to `null` at runtime, GraphQL does not simply
return `null` for that field. Instead, it triggers a **null propagation** chain
that can destroy surrounding data.

### How it works

```
Step 1: A non-null field resolver returns null
        --> GraphQL raises a field error

Step 2: Since the field is non-null, null is not a valid value
        --> The null "bubbles up" to the nearest NULLABLE parent field

Step 3: That nullable parent field becomes null
        --> The error is recorded in the response "errors" array

Step 4: If ALL ancestors up to the root are also non-null
        --> The ENTIRE "data" key becomes null
```

### Example

```graphql
type Query {
  shop(id: ID!): Shop          # nullable -- acts as error boundary
}

type Shop {
  name: String!                 # non-null
  topProduct: Product!          # non-null
}

type Product {
  name: String!                 # non-null -- if this returns null...
  price: Money                  # nullable
}
```

If `Product.name` unexpectedly returns `null`:

1. `Product.name` is non-null, so `Product` cannot be represented.
2. `Shop.topProduct` is non-null, so `Shop` cannot be represented.
3. `Query.shop` is nullable -- **it becomes `null`**, stopping propagation.

Result:
```json
{
  "data": { "shop": null },
  "errors": [{ "message": "Cannot return null for non-nullable field Product.name" }]
}
```

All valid data in `Shop` (including `Shop.name`) is lost because of one bad
field deep in the tree.

### Key consequences

- **One bad non-null field can destroy an entire subtree of valid data.**
  Sibling fields, parent fields -- all wiped out up to the nearest nullable
  ancestor.

- **Nullable fields act as error boundaries.** They stop null propagation,
  allowing the rest of the response to remain intact.

- **Deeply nested non-null chains are dangerous.** A transient error anywhere
  in the chain nullifies everything above it.

- **Design nullable "checkpoints" at strategic levels.** Entity-level fields
  on queries and connections are good candidates for nullable boundaries.

### Blast radius comparison

```
All non-null from root:     One transient error --> entire data: null
Nullable at entity level:   One transient error --> one entity null, rest intact
Nullable at field level:    One transient error --> one field null, rest intact
```

---

## 4. Breaking Change Matrix

Nullability changes have different compatibility implications depending on
whether the field is in **input position** (arguments, input type fields) or
**output position** (object type fields, payload fields).

### Output position (fields clients READ)

| Change | Safe or Breaking? | Explanation |
|--------|-------------------|-------------|
| Nullable --> Non-null (`String` to `String!`) | **SAFE** | Clients gain a stronger guarantee. Code handling null still works with non-null values. |
| Non-null --> Nullable (`String!` to `String`) | **BREAKING** | Clients may not handle null. Code assuming a value is always present will fail. |
| Add new nullable field | **SAFE** | Existing queries are unaffected; clients opt in by selecting the field. |
| Add new non-null field | **SAFE** | Only affects clients who select it; existing queries unchanged. |
| Remove field | **BREAKING** | Clients selecting the field will get query validation errors. |

### Input position (arguments and input fields clients WRITE)

| Change | Safe or Breaking? | Explanation |
|--------|-------------------|-------------|
| Non-null --> Nullable (`String!` to `String`) | **SAFE** | Clients can still provide the value; it just becomes optional. |
| Nullable --> Non-null (`String` to `String!`) | **BREAKING** | Clients not providing the value will fail validation. |
| Add new nullable argument | **SAFE** | Existing operations continue to work; the argument defaults to null. |
| Add new argument with default value | **SAFE** | Existing operations use the default. |
| Add new required (non-null) argument | **BREAKING** | All existing operations missing this argument will fail. |
| Remove argument | **BREAKING** | Clients providing the argument will get validation errors. |

### Summary rule

```
OUTPUT: strengthening guarantees is safe    (nullable --> non-null)
        weakening guarantees is breaking    (non-null --> nullable)

INPUT:  relaxing requirements is safe       (non-null --> nullable)
        tightening requirements is breaking (nullable --> non-null)
```

The asymmetry exists because **output** is what clients consume (stronger is
better) while **input** is what clients provide (looser is better).

---

## 5. Practical Guidelines Checklist

### Output fields

- [ ] **Boolean fields: always non-null.** A nullable Boolean creates a confusing
      tri-state. If you need tri-state semantics, use an enum instead.

- [ ] **List fields: default to `[T!]!`.** Only use nullable variants when null
      carries distinct meaning from an empty list.

- [ ] **Simple scalars on loaded parents: non-null.** If the parent object is
      already resolved, its scalar attributes (name, title, createdAt) are safe
      as non-null.

- [ ] **Fields backed by I/O: nullable.** Database joins, service calls, network
      fetches -- anything that can fail should be nullable to contain blast radius.
      Entity reference fields resolved via DataLoaders (e.g., `client: Client`)
      are expected nullable by convention and do **not** require a description
      justifying their null semantics. Do not flag these as issues in reviews.

- [ ] **Mutation payload entity fields: nullable.** The entity is null when the
      mutation fails; the errors field explains why.

- [ ] **ID fields: non-null.** An entity always has an identity.

- [ ] **Timestamp fields (createdAt, updatedAt): non-null.** These are set at
      creation/modification and always present.

- [ ] **Connection fields: non-null.** Return an empty connection, not null.
      Null connection signals error or unauthorized; empty means no items.

### Input arguments

- [ ] **Required arguments: non-null.** If the operation cannot proceed without
      the value, mark it non-null.

- [ ] **Optional arguments: nullable with sensible defaults.** Use GraphQL default
      values to document the default: `products(sort: SortOrder = DESC)`.

- [ ] **New arguments on existing fields: always nullable or with defaults.**
      Adding a required argument is a breaking change.

- [ ] **Create input fields: mostly non-null.** A new entity usually requires
      its core fields.

- [ ] **Update input fields: mostly nullable.** Only provided fields are updated;
      null means "do not change."

### Evolutionary safety

- [ ] **When in doubt, start nullable.** You can always strengthen to non-null
      later (safe change). Going the other direction is breaking.

- [ ] **Non-null is a permanent commitment.** Once clients depend on a non-null
      guarantee, removing it breaks them.

- [ ] **Use descriptions to clarify null semantics.** Document whether null means
      "not applicable," "not loaded," "error," or "no value."

- [ ] **Place nullable "checkpoints" strategically.** Entity-level fields in
      queries, connection node fields, and mutation payload entities are good
      places for nullable boundaries that contain null propagation.

- [ ] **Never make a field non-null just because it happens to always have a
      value today.** Consider whether the backing system could evolve to produce
      null in the future (new data sources, architecture changes, partial failures).
