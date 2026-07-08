# GraphQL Error Handling — Typed Errors Pattern

The standard error pattern for all mutation domain errors.

All examples use pure GraphQL SDL — no framework-specific code.

---

## Two Error Categories

Every error falls into one of two categories. Getting this right determines
where the error surfaces.

### Infrastructure Errors → `errors` key (top-level)

Exceptional failures the **client developer** handles. The end user sees
"something went wrong."

Examples: timeout, rate limit, auth failure, malformed query, internal error.

```json
{
  "errors": [
    {
      "message": "Could not connect to product service.",
      "locations": [{ "line": 6, "column": 7 }],
      "path": ["viewer", "products", 1, "name"],
      "extensions": { "code": "SERVICE_CONNECT_ERROR" }
    }
  ]
}
```

- Always present without client opt-in
- The errored field resolves to `null`; null bubbles up to nearest nullable ancestor
- Not part of the type system — not introspectable
- **Never model these in the schema**

### Domain Errors → Typed errors on the mutation payload (in schema)

Expected business-rule failures the **end user** sees and acts on.

Examples: username taken, password too weak, insufficient stock, duplicate name.

- Fully typed, introspectable, discoverable
- Clients query them like any other data
- **Always model these in the schema using the typed errors pattern**

---

## The Typed Errors Pattern

The pattern = **Payload wrapper** + **`errors` union list** + **Error interface**

### Complete SDL

```graphql
type Mutation {
  signUp(input: SignUpInput!): SignUpPayload!
}

input SignUpInput {
  email: String!
  username: String!
  password: String!
}

# Payload wrapper — entity (nullable) + typed error list
type SignUpPayload {
  "The created account. Null when errors is non-null."
  account: Account
  "Domain errors. Null means success; non-null means failure."
  errors: [SignUpError!]
}

# Union makes all possible error types discoverable via introspection
union SignUpError =
  | UsernameTakenError
  | PasswordTooWeakError
  | EmailAlreadyRegisteredError

# Shared interface — ALL union members MUST implement this
interface Error {
  "Human-readable description of what went wrong."
  message: String!
  "Stable machine-readable identifier. Clients match on this, never on message."
  code: ErrorCode!
  """
  Path to the input field that caused the error.
  Example: ["input", "items", "0", "quantity"]
  Null when not attributable to a specific field.
  """
  path: [String!]
}

# Concrete error types: interface fields + case-specific fields
type UsernameTakenError implements Error {
  message: String!
  code: ErrorCode!
  path: [String!]
  suggestedUsername: String!
}

type PasswordTooWeakError implements Error {
  message: String!
  code: ErrorCode!
  path: [String!]
  passwordRules: [String!]!
  minimumLength: Int!
}

type EmailAlreadyRegisteredError implements Error {
  message: String!
  code: ErrorCode!
  path: [String!]
}
```

### Client Query

```graphql
mutation Register($input: SignUpInput!) {
  signUp(input: $input) {
    account {
      id
      username
    }
    errors {
      # Known cases — rich handling
      ... on UsernameTakenError {
        message
        suggestedUsername
      }
      ... on PasswordTooWeakError {
        message
        passwordRules
      }
      # Catch-all — handles ANY error, including future ones
      ... on Error {
        message
        code
        path
      }
    }
  }
}
```

### Why This Pattern

| Property | How |
|---|---|
| **Discoverable** | Union members visible via introspection |
| **Multiple errors** | `errors` is a list |
| **Custom fields per error** | Each concrete type has own fields |
| **Forward compatible** | `... on Error` catch-all for new types |
| **Consistent contract** | Shared `message` + `code` + `path` |
| **Partial data + errors** | Payload has both entity and errors |

---

## Rules Checklist

- [ ] Every mutation uses a unique payload type with `errors: [{MutationName}Error!]`
- [ ] Every error union is unique per mutation: `SignUpError`, `CreateProductError`
- [ ] ALL error union members MUST implement the shared `Error` interface
- [ ] The entity field on the payload is nullable (null when errors present)
- [ ] The errors list is nullable with non-null items: `[T!]` (null = success, non-null = errors)
- [ ] Error types never shared across mutations (they will diverge)
- [ ] Enforce the interface requirement with a linter

---

## Error Interface Design

The shared interface is what makes this pattern forward-compatible. Define it once;
all error types across all mutations implement it.

```graphql
interface Error {
  "Human-readable description."
  message: String!
  "Stable machine-readable identifier. Clients switch on this."
  code: ErrorCode!
  "Path to the input field that caused the error. Null if not field-specific."
  path: [String!]
}
```

Concrete types implement the interface and add case-specific fields:

```graphql
type ProductNameTakenError implements Error {
  message: String!
  code: ErrorCode!
  path: [String!]
  suggestedName: String!
}

type InsufficientStockError implements Error {
  message: String!
  code: ErrorCode!
  path: [String!]
  availableQuantity: Int!
  requestedQuantity: Int!
}
```

---

## Error Code Enum

Error codes are **stable identifiers** that client code switches on. Messages
are for humans; codes are for machines.

```graphql
enum ErrorCode {
  # Generic
  VALIDATION_ERROR
  NOT_FOUND
  UNAUTHORIZED
  FORBIDDEN
  CONFLICT

  # Identity / Auth
  EMAIL_ALREADY_REGISTERED
  PASSWORD_TOO_WEAK
  USERNAME_TAKEN

  # Catalog
  PRODUCT_NAME_TAKEN
  INSUFFICIENT_STOCK

  # Billing
  QUOTA_EXCEEDED
  PAYMENT_DECLINED
}
```

- Use `SCREAMING_SNAKE_CASE`
- Group by domain area with comments when the enum grows
- Never reuse a code for a different meaning. Deprecate, don't rename.
- Generic codes cover broad cases; add domain-specific codes only when
  clients need distinct handling

---

## Validation Errors

Validation errors point the client at the exact input field that failed.
They are a specialized concrete type implementing the `Error` interface.

```graphql
type ValidationError implements Error {
  message: String!
  code: ErrorCode!
  "Path from input root to the invalid field. e.g. ['input', 'email']"
  path: [String!]!
  "Machine-readable constraint violated. e.g. 'maxLength:255', 'format:email'"
  constraint: String
}
```

Guidelines:

- `path` starts from the mutation input root so clients can map to form fields
- Return ALL validation errors at once — don't fail on the first one
- `constraint` is optional metadata for rich UI (e.g., showing max length)

### Example Response

```json
{
  "data": {
    "createProduct": {
      "product": null,
      "errors": [
        {
          "message": "Name must be at most 255 characters.",
          "code": "VALIDATION_ERROR",
          "path": ["input", "name"]
        },
        {
          "message": "Price must be a positive integer.",
          "code": "VALIDATION_ERROR",
          "path": ["input", "price"]
        }
      ]
    }
  }
}
```

---

## Partial Success (Batch Mutations)

Batch mutations may succeed for some items and fail for others. Return both.

```graphql
type BatchCreateProductsPayload {
  "Products that were successfully created."
  products: [Product!]!
  "Errors for items that failed, with index references."
  errors: [BatchItemError!]!
}

type BatchItemError implements Error {
  message: String!
  code: ErrorCode!
  path: [String!]
  "Zero-based index of the failed item in the input list."
  index: Int!
}
```

Guidelines:

- Never fail an entire batch because one item is invalid
- `index` lets clients map errors back to specific input items
- For ID-keyed operations, use `itemId: ID!` instead of `index`
- Document whether successful items are committed when some fail

---

## Forward Compatibility

Adding a new error type to a union is a **dangerous schema change**. Clients
that exhaustively match known types get an empty response for new types.

### The Interface Catch-All

The `Error` interface solves this. Clients include one catch-all fragment:

```graphql
errors {
  ... on UsernameTakenError { message  suggestedUsername }
  # Catches ANY error type, including ones added later
  ... on Error { message  code  path }
}
```

If `AccountSuspendedError` is added next month, existing clients match it
through `... on Error` and display the message without a client update.

### Guidelines

- [ ] All error types implement the `Error` interface — no exceptions
- [ ] Document that clients MUST include `... on Error { message code }` as catch-all
- [ ] Never remove or change the meaning of an existing `ErrorCode` value
- [ ] When adding a new union member, announce it and give clients time for
  richer handling if they want it
