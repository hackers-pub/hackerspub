# GraphQL Schema Evolution Reference

A standalone reference for evolving GraphQL schemas without versioning.
Covers change classification, deprecation workflows, communication strategies,
and safe removal procedures.

---

## 1. Change Classification

### Safe (Non-Breaking) Changes

These changes are backward-compatible and can be deployed without risk to
existing clients:

- Add a new type (object, input, enum, union, interface, scalar)
- Add a new field to an existing object type
- Add a new nullable argument to an existing field
- Add a new argument with a default value
- Add a new nullable field to an input type (with default value)
- Make a nullable output field non-null (strengthening the guarantee)
- Make a non-null input argument nullable (relaxing the requirement)
- Add `@deprecated` to a field or enum value
- Add a new directive definition
- Add a new directive usage (on types, fields, etc.)
- Add descriptions or modify existing descriptions on any schema element
- Reorder fields within a type (field order is not semantically meaningful)

### Dangerous Changes (May Break Some Clients)

These are technically additive but can break clients that make assumptions
about completeness:

| Change | Why It Is Dangerous |
|---|---|
| Add a new **enum value** | Clients with exhaustive switch/match statements will hit an unhandled case |
| Add a new **union member** | Clients using inline fragments without a fallback will silently drop the new member |
| Add a new **interface implementation** | Same risk as union member -- clients not handling unknown concrete types break |
| Change a field's type to a **more specific subtype** | Clients relying on the original type shape may not handle the subtype correctly |
| Add a **required (non-null) field** to an input type | All existing operations that construct this input will fail validation |
| Change a **default value** on an argument | Clients relying on the previous default behavior will see different results silently |

### Breaking Changes

These changes will cause existing valid operations to fail:

| Change | Impact |
|---|---|
| Remove a type | Any query referencing the type fails validation |
| Remove a field from an object type | Any query selecting that field fails validation |
| Remove an argument from a field | Any query passing that argument fails validation |
| Remove an enum value | Any query or variable using that value fails validation |
| Remove a union member | Inline fragments on the removed member silently return nothing |
| Remove an interface implementation | Same as union member removal |
| Rename a field | Equivalent to remove + add -- old name breaks, new name is unknown |
| Rename a type | Equivalent to remove + add |
| Make a non-null output field nullable | Clients expecting non-null will encounter unexpected nulls at runtime |
| Make a nullable input argument non-null | Existing operations omitting the argument fail validation |
| Change a field's return type (not to a subtype) | Clients parsing the old type shape will break |
| Change an argument's type | Existing operations passing the old type fail validation |
| Remove a directive that clients depend on | Queries using the directive fail validation |

---

## 2. The Add-Deprecate-Migrate-Remove Workflow

Every non-additive schema change follows a four-step lifecycle:

### Step 1: Add

Introduce the replacement alongside the existing element. Both old and new
must coexist in the schema.

```graphql
type User {
  name: String!       # existing
  firstName: String!  # new replacement
  lastName: String!   # new replacement
}
```

### Step 2: Deprecate

Mark the old element with `@deprecated` including a complete deprecation
message (see Section 3). This signals tooling and developers that the field
is going away.

```graphql
type User {
  name: String! @deprecated(reason: """
    Field `name` is being split into `firstName` and `lastName`.
    Use `firstName` and `lastName` instead.
    Sunset date: 2027-01-15.
    See: https://dev.example.com/changelog/user-name-split
  """)
  firstName: String!
  lastName: String!
}
```

### Step 3: Migrate

Actively help clients move to the replacement:

- Send targeted notifications to affected integrators (identified via query analytics)
- Update documentation and code samples to use the new field
- Provide migration guides with before/after examples
- Monitor usage analytics -- track the decline of deprecated field usage
- Perform brownouts if usage persists past the warning period (see Section 6)

### Step 4: Remove

Once usage has reached zero (or an acceptable breakage threshold), remove the
deprecated element from the schema. Follow the Pre-Removal Verification Steps
(Section 7) before deploying.

```graphql
type User {
  firstName: String!
  lastName: String!
}
```

---

## 3. Deprecation Message Template

Every deprecation message must include four components:

```
@deprecated(reason: """
  {Reason why the field is being removed or changed}.
  Use `{alternative field or approach}` instead.
  Sunset date: {YYYY-MM-DD}.
  See: {URL to migration guide or changelog entry}
""")
```

### Full Example

```graphql
type Product {
  imageUrl: String @deprecated(reason: """
    Field `imageUrl` is being replaced by the `image` object type
    which supports multiple resolutions and alt text.
    Use `image { url }` instead.
    Sunset date: 2027-06-01.
    See: https://dev.example.com/changelog/product-image-type
  """)
  image: ProductImage
}
```

### Component Breakdown

| Component | Purpose | Example |
|---|---|---|
| **Reason** | Explains *why* the change is happening | "Split into separate fields for i18n support" |
| **Alternative** | Tells the client *what to use instead* | "Use `firstName` and `lastName` instead" |
| **Sunset date** | Gives clients a *concrete deadline* | "Sunset date: 2027-06-01" |
| **Link** | Points to *detailed migration instructions* | "See: https://dev.example.com/changelog/..." |

---

## 4. Enhanced Deprecation Helper Pattern

When many developers contribute to a schema, enforce consistency with a
deprecation helper function. On large schemas with many contributors, this
keeps deprecation quality uniform.

### Concept

Create a helper that requires all four deprecation components and formats
them consistently:

```graphql
# The helper signature (pseudocode -- implement in your language of choice):
#
# deprecationReason(
#   reason: String,
#   alternative: String,
#   sunsetDate: Date,
#   link: String
# ) -> String

# Usage produces a formatted deprecation message:
#
# "Name is going away. Use `username` instead.
#  Sunset date: 2027-05-01.
#  For more information: https://dev.example.com/blog/deprecation-name"
```

### Benefits

- **Enforces completeness**: Developers cannot deprecate without providing all
  four components -- the function signature requires them
- **Consistent formatting**: Every deprecation message follows the same structure
  regardless of who wrote it
- **Machine-parseable**: Automated tools can extract sunset dates and alternatives
  from the structured format
- **Review-friendly**: Pull request reviewers can verify deprecation quality at
  a glance

### Schema Introspection Result

The formatted message appears in the `deprecationReason` field when clients
introspect the schema:

```graphql
{
  __type(name: "User") {
    fields(includeDeprecated: true) {
      name
      isDeprecated
      deprecationReason
      # Returns: "Name is going away. Use `username` instead.
      #           Sunset date: 2027-05-01.
      #           For more information: https://..."
    }
  }
}
```

---

## 5. Communication Strategy

Deprecation directives alone are insufficient. Reach clients through multiple
channels:

### Targeted Emails (Highest Impact)

GraphQL's per-field usage tracking enables targeted communication. Instead of
blasting all integrators, email only those whose queries use the deprecated
field. Include:

- Which field is deprecated and why
- What to use instead (with code examples)
- The sunset date
- A link to the full migration guide

### Changelog

Maintain a public changelog that documents every schema change with:

- Date of change
- Classification (safe / dangerous / breaking)
- Affected types and fields
- Migration instructions

### Documentation Site

- Update all code examples to use the replacement fields
- Add migration guides with before/after query examples
- Mark deprecated fields visually in API reference docs (most GraphQL
  documentation generators handle this automatically via `@deprecated`)

### Blog Posts

For significant changes that affect many clients, publish a detailed blog post:

- Explain the motivation behind the change
- Walk through the migration step by step
- Provide a timeline with key dates
- Offer support channels for questions

### Developer Dashboard

If you operate a developer portal, surface deprecation warnings directly in
the dashboard:

- Show which of the developer's registered queries use deprecated fields
- Display countdown to sunset date
- Provide one-click access to migration guides

---

## 6. Brownout Checklist

Brownouts are temporary, scheduled disruptions to deprecated fields that force
remaining clients to notice and act. Use them as a last resort before permanent
removal.

1. **Identify affected clients** -- Query analytics to find every client still
   using the deprecated field, including frequency and criticality of their usage

2. **Send targeted notifications** -- Contact each affected integrator directly
   with the brownout schedule, migration instructions, and support contacts

3. **Schedule the brownout window** -- Choose a low-traffic period (e.g., 1 hour
   on a weekday morning). Announce the exact time in advance

4. **Disable the field during the window** -- Return a descriptive error message
   instead of data:
   ```json
   {
     "errors": [{
       "message": "Deprecated: Field `name` has been removed. Use `firstName` and `lastName` instead. See: https://dev.example.com/changelog/user-name-split"
     }]
   }
   ```
   Implement via feature flags, schema visibility controls, or resolver-level
   checks

5. **Monitor usage after brownout** -- Check analytics: did usage of the
   deprecated field drop? Did affected clients migrate?

6. **Repeat with increasing duration** -- If usage persists, schedule longer
   brownouts (2 hours, 4 hours, 8 hours, full day) until usage reaches zero
   or an acceptable threshold

7. **Proceed to final removal** -- Once brownouts confirm usage has ceased,
   follow the Pre-Removal Verification Steps (Section 7) and remove the field
   permanently

---

## 7. Pre-Removal Verification Steps

Before removing a deprecated field from the schema, complete every step:

1. **Verify the deprecation period** -- Confirm the field has been deprecated
   for at least the full committed sunset period (e.g., 6 months). Do not
   shorten this without explicit stakeholder approval

2. **Check query analytics** -- Pull current usage data. Is any client still
   sending queries that reference this field? Look at the last 30 days minimum

3. **Confirm notification was sent** -- Verify that all affected integrators
   were notified (targeted emails, brownout announcements). If any were missed,
   notify them and extend the sunset period

4. **Run schema diff** -- Use a schema comparison tool to confirm the change is
   classified correctly (breaking vs. safe). Review the diff output to ensure
   no unintended changes are included

5. **Update schema snapshot tests** -- Run snapshot tests and update the
   committed snapshots to reflect the removal. Review the diff to confirm only
   the expected elements are removed

6. **Update changelog and documentation** -- Add the removal to the changelog
   with the date, reason, and replacement. Remove the deprecated field from all
   code examples and migration guides

7. **Deploy and monitor** -- Deploy the schema change and monitor error rates,
   support tickets, and client health metrics for at least 24 hours. Have a
   rollback plan ready

---

## 8. Decision Tree: Avoiding Breaking Changes

When you need to change existing schema behavior, walk through this decision
tree before resorting to deprecation and removal:

```
Need to change existing schema behavior?
|
+--> Can you ADD a new field/type alongside the existing one?
|    |
|    +--> YES: Add the new element. Deprecate the old one.
|    |         This is the safest and most common path.
|    |
|    +--> NO: Continue below.
|
+--> Can you add an ARGUMENT with a default value?
|    |
|    +--> YES: Add the argument with a default that preserves
|    |         current behavior. New clients pass the argument
|    |         to get the new behavior. Non-breaking.
|    |
|    +--> NO: Continue below.
|
+--> Can you WRAP the result in a new type?
|    |
|    +--> YES: Introduce a new type that contains both the old
|    |         shape and the new shape. Deprecate the old field,
|    |         point clients to the new type.
|    |
|    +--> NO: Continue below.
|
+--> Can you introduce a NEW FIELD with a different name?
|    |
|    +--> YES: This is a variant of "add alongside". Use a more
|    |         specific name for the new field. Deprecate the old.
|    |
|    +--> NO: The change is truly breaking. Enter the full
|              Add-Deprecate-Migrate-Remove workflow (Section 2).
```

### Common Scenarios and Solutions

| Scenario | Breaking Approach | Non-Breaking Alternative |
|---|---|---|
| Rename a field | Remove `name`, add `username` | Add `username`, deprecate `name` |
| Change return type | Change `image: String` to `image: Image` | Add `imageDetails: Image`, deprecate `image` |
| Split a field | Remove `name` | Add `firstName` + `lastName`, deprecate `name` |
| Add required input | Make `currency` non-null | Add `currency` as nullable with default, or add new input type |
| Remove enum value | Remove `LEGACY_STATUS` | Deprecate the value, map it to replacement server-side |
| Change argument type | Change `id: Int` to `id: ID` | Add new argument `entityId: ID`, deprecate `id` argument |
| Restructure a type | Rewrite `Address` fields | Add `addressV2: StructuredAddress`, deprecate old fields |

### When Breaking Changes Are Unavoidable

Some situations genuinely require breaking changes with no additive workaround:

- **Security vulnerabilities**: A field leaks private data and must be removed
  immediately
- **Performance emergencies**: An unpaginated list returns millions of records,
  causing outages
- **Non-null contract violations**: A non-null field can actually return null at
  runtime, causing client crashes
- **Authentication/authorization changes**: Fundamental auth mechanisms must
  change (e.g., removing basic auth)

In these cases, proceed directly to the deprecation workflow but with an
accelerated timeline. Communicate urgently and broadly. Security issues may
justify immediate removal without the standard sunset period.

---

## Summary: The Evolution Mindset

1. **Additive changes first** -- always look for a way to add rather than modify
2. **Deprecate before removing** -- never surprise clients with a removal
3. **Communicate through every channel** -- deprecation directives alone are not enough
4. **Measure before removing** -- query analytics are your source of truth
5. **Brownout before sunsetting** -- give stragglers one last chance
6. **Design for evolution from day one** -- overly specific names, nullable by default for outputs you are unsure about, object types over scalars for extensibility
