Application architecture
========================

Package dependencies
--------------------

The core packages follow this dependency direction:

| Package                             | Responsibility                                                         | Allowed internal dependencies       |
| ----------------------------------- | ---------------------------------------------------------------------- | ----------------------------------- |
| *@hackerspub/models*                | Application and persistence code, including external service contracts | None                                |
| *@hackerspub/ai*                    | AI SDK implementations of the model-layer service contracts            | *@hackerspub/models*                |
| *@hackerspub/federation*            | Fedify dispatchers, listeners, serialization, and delivery adapters    | *@hackerspub/models*                |
| GraphQL and legacy web entry points | Runtime composition roots                                              | Models, AI, and federation packages |

The models package must not import the AI or federation packages.  Code in the
models package calls external effects through `ApplicationServices`, which the
GraphQL API, GraphQL worker, legacy web server, and tests assemble explicitly.
This keeps the workspace package graph acyclic while preserving the current
Fedify request context until the runtime-neutral application context is
introduced.

The package boundary tests in *test/package-boundaries.test.ts* compare core
package manifests with their production module graphs and reject workspace
dependency cycles.


Transactional side effects
--------------------------

State changes that produce outgoing ActivityPub work use a transactional
outbox.  An application operation opens one database transaction, writes its
domain state, and asks Fedify to enqueue fanout work through the same database
handle.  The transaction therefore commits both changes or neither change.
Network delivery happens later in the GraphQL worker and never keeps an
application transaction open.

The generic persistence and leasing API lives in *@hackerspub/models/outbox*.
It knows stable event names and versioned JSON payloads, but it does not import
Fedify.  *@hackerspub/federation/outbox-queue* adapts Fedify's `MessageQueue`
contract to that storage.  Keeping this split preserves the package direction
above and lets other durable side effects reuse the same table without taking
a dependency on the federation adapter.

Outgoing ActivityPub work that reflects committed application state is
critical.  Failure to store that work rolls back the state change.  AI article
summary generation and remote reply or emoji-reaction backfills are explicitly
best-effort enrichment tasks; they run through `queueAfterCommit` and do not
roll back the user-visible operation.

Delivery is at least once.  Activity IDs and Fedify message IDs must therefore
remain stable across retries, and consumers must tolerate a duplicate request.
See *FEDERATION.md* for worker, retry, retention, and replay details.


Post feature boundaries
-----------------------

The models package exposes post behavior through focused public subpaths.  New
code should import the narrowest applicable module instead of the compatibility
facade at *@hackerspub/models/post*:

| Subpath                              | Responsibility                                      |
| ------------------------------------ | --------------------------------------------------- |
| *@hackerspub/models/post/core*       | Post object guards and persisted post lookup        |
| *@hackerspub/models/post/remote*     | Remote ActivityPub ingestion and deletion           |
| *@hackerspub/models/post/source*     | Local article, note, and question synchronization   |
| *@hackerspub/models/post/visibility* | Visibility, moderation, and interaction policies    |
| *@hackerspub/models/post/sharing*    | Local share and unshare operations                  |
| *@hackerspub/models/post/engagement* | Reply, share, and quote counters and quote revoking |
| *@hackerspub/models/post/lifecycle*  | Local post deletion                                 |
| *@hackerspub/models/link-preview*    | Link scraping, persistence, and repair              |

*models/post.ts* remains an explicit re-export facade for existing consumers.
It contains no post behavior.  Article source rendering helpers live in
*models/article-source.ts* so local post synchronization does not form a cycle
with the article model.

The GraphQL post schema follows the same registration boundaries under
*graphql/post/*.  *core.ts* owns the `Post` interface, shared fields, media, and
link types; *article.ts* owns article and draft types; *note.ts* owns note and
question types; and *mutations.ts* owns post mutations and queries.  Actor post
fields and `Account.articleDrafts` are registered by *actor-fields.ts* and
*article-fields.ts* from the GraphQL composition root after their base types are
available.  This avoids `actor` or `account` importing the post facade.

*graphql/post.ts* is a compatibility facade that preserves the historical
public type references.  Adding a post feature means registering it in a
focused module and importing that registration from *graphql/mod.ts*; schema
generation must remain deterministic and must not change merely because a
registration moved between modules.
