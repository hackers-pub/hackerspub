<!-- deno-fmt-ignore-file -->

Federation
==========

Hackers' Pub is an ActivityPub server built with [Fedify].  This document
describes the federation behavior of the Hackers' Pub application.  For the
lower-level protocol and vocabulary features supplied by the framework, see
the [Fedify 2.3.1 federation documentation].

Fedify exposes APIs and vocabulary types for more FEPs than an application
necessarily uses.  Therefore, the presence of a feature in Fedify's own
`FEDERATION.md` does not by itself constitute a claim that Hackers' Pub
implements the corresponding application-level behavior.  The lists below
cover features that are active in Hackers' Pub.

[Fedify]: https://fedify.dev/
[Fedify 2.3.1 federation documentation]: https://github.com/fedify-dev/fedify/blob/2.3.1/FEDERATION.md


Supported federation protocols and standards
--------------------------------------------

 -  [ActivityPub] server-to-server federation.  The ActivityPub client-to-server
    protocol is not implemented.
 -  [Activity Streams 2.0] vocabulary and JSON-LD serialization.
 -  [WebFinger] (RFC 7033) actor discovery.
 -  [HTTP Message Signatures] (RFC 9421).
 -  [HTTP Signatures] (draft-cavage-http-signatures-12) for compatibility with
    widely deployed Fediverse software.
 -  [Linked Data Signatures] for compatibility with relay implementations and
    older Fediverse software.
 -  [NodeInfo] 2.1 server metadata.

[ActivityPub]: https://www.w3.org/TR/activitypub/
[Activity Streams 2.0]: https://www.w3.org/TR/activitystreams-core/
[WebFinger]: https://datatracker.ietf.org/doc/html/rfc7033
[HTTP Message Signatures]: https://www.rfc-editor.org/rfc/rfc9421
[HTTP Signatures]: https://datatracker.ietf.org/doc/html/draft-cavage-http-signatures-12
[Linked Data Signatures]: https://web.archive.org/web/20170923124140/https://w3c-dvcg.github.io/ld-signatures/
[NodeInfo]: https://nodeinfo.diaspora.software/


Supported FEPs
--------------

The following FEPs have application-level behavior in Hackers' Pub:

 -  [FEP-67ff][]: FEDERATION.md.  This document is the implementation.
 -  [FEP-044f][]: Consent-respecting quote posts.  Hackers' Pub publishes quote
    policies, sends and receives `QuoteRequest` activities, issues and revokes
    `QuoteAuthorization` objects, and handles `Accept` and `Reject` responses.
 -  [FEP-c0e0][]: Emoji reactions.  Hackers' Pub sends and undoes standard
    emoji reactions as `Like` or `EmojiReact` activities.  It receives both
    standard and custom emoji reactions and exposes them in `emojiReactions`
    collections.  Locally created custom emoji reactions are stored and
    exposed, but are not currently delivered or undone over federation.
 -  [FEP-e232][]: Object Links.  Quotes include an ActivityPub object link in
    `tag` for compatibility in addition to the quote-specific properties.
 -  [FEP-f1d5][]: NodeInfo in Fediverse Software.  Hackers' Pub publishes a
    NodeInfo 2.1 document and advertises ActivityPub support.
 -  [FEP-8fcf][]: Followers collection synchronization across servers.  The
    followers collection implements the server side of synchronization by
    providing origin-filtered views.  Outgoing delivery does not currently
    request synchronization from receiving servers.
 -  [FEP-ae0c][]: Fediverse Relay Protocols: Mastodon and LitePub (partial).
    The instance actor can initiate and cancel LitePub/Pleroma-style relay
    subscriptions with `Follow` and `Undo(Follow)`, and can process `Accept`
    and `Reject` responses.  Its ID does not end in `/relay`, and reciprocal
    `Follow` requests from a relay are not currently handled, so full LitePub
    relay interoperability is not claimed.  The Mastodon-style relay protocol
    is not implemented.

The following protocol mechanisms are implemented by Fedify and are active in
Hackers' Pub's federation configuration:

 -  [FEP-8b32][]: Object Integrity Proofs.  Fedify creates and verifies proofs;
    local account actors have Ed25519 keys for signing.
 -  [FEP-521a][]: Representing actor's public keys.  Actor documents expose
    `Multikey` values through `assertionMethod` while retaining the legacy RSA
    `publicKey` representation for interoperability.
 -  [FEP-fe34][]: Origin-based security model (partial).  Fedify enforces origin
    checks during document loading and activity processing, and Hackers' Pub
    performs additional ownership and origin checks in many inbox handlers.
    However, incoming `Follow` and `Block` activities do not currently require
    their activity IDs to have the same origin as their actors, so Hackers' Pub
    does not claim full compliance.

[FEP-67ff]: https://w3id.org/fep/67ff
[FEP-044f]: https://w3id.org/fep/044f
[FEP-c0e0]: https://w3id.org/fep/c0e0
[FEP-e232]: https://w3id.org/fep/e232
[FEP-f1d5]: https://w3id.org/fep/f1d5
[FEP-8fcf]: https://w3id.org/fep/8fcf
[FEP-ae0c]: https://w3id.org/fep/ae0c
[FEP-8b32]: https://w3id.org/fep/8b32
[FEP-521a]: https://w3id.org/fep/521a
[FEP-fe34]: https://w3id.org/fep/fe34


ActivityPub actors and addressing
---------------------------------

Local accounts are published as `Person` or `Organization` actors.  Hackers'
Pub also publishes an `Application` actor for instance-level operations such
as relay subscriptions.  Actor handles are discoverable through WebFinger,
and each actor advertises a per-actor inbox, the shared inbox, an outbox,
followers and following collections, and a featured collection.

Deleted local accounts resolve to `Tombstone` objects.  Their former actor type
and deletion time are preserved, and their former public keys remain available
so remote servers can continue to verify previously received activities.


Activities
----------

Hackers' Pub processes the following incoming activity types:

 -  `Accept` and `Reject` for follows, quote requests, and relay subscriptions.
 -  `Follow` and `Undo(Follow)` for social graph changes.
 -  `Create`, `Update`, and `Delete` for `Article`, `Note`, and `Question`
    objects, including poll votes represented as `Create(Note)`.
 -  `Announce` and `Undo(Announce)` for boosts.
 -  `Like`, `EmojiReact`, and their `Undo` activities for reactions.
 -  `QuoteRequest` for consent-respecting quotes.
 -  `Add` and `Remove` for featured posts.
 -  `Block` and `Undo(Block)` for remote blocking state.
 -  `Move` for account migration when the target actor declares the source in
    `alsoKnownAs`.
 -  `Flag` for moderation reports.

Hackers' Pub sends `Accept`, `Add`, `Announce`, `Block`, `Create`, `Delete`,
`EmojiReact` (for standard non-default emoji), `Flag`, `Follow`, `Like`,
`QuoteRequest`, `Reject`, `Remove`, `Undo`, and `Update` activities as needed by
local user actions and federation workflows.

Activities whose type is recognized by Fedify but which have no Hackers' Pub
inbox handler are not claimed as supported application behavior.


Objects and collections
-----------------------

Hackers' Pub publishes and consumes `Article`, `Note`, and `Question` objects.
Locally published post objects can include `Document` attachments, `Mention`,
`Hashtag`, and `Link` tags, language-tagged strings, polls, replies, and quotes.
Hackers' Pub also consumes remote `Image` attachments and `summary` and
`sensitive` content-warning fields.  `Emoji` tags are consumed and exposed on
custom emoji reaction activities, but are not emitted on locally authored post
objects.

The server exposes the standard followers, following, outbox, and featured
collections.  Public and unlisted posts are available from outboxes.  Replies
are exposed as paginated `OrderedCollection` objects, and emoji reactions are
exposed as paginated `Collection` objects.  Access to posts and their related
collections follows the post's visibility and local moderation state.


Delivery and relays
-------------------

Outgoing activities are delivered asynchronously through Fedify's message
queue.  Public and unlisted posts are delivered to their intended public,
followers, and mentioned recipients; followers-only and direct posts are sent
only to their explicit audiences.  Shared inbox delivery is used where
appropriate.

Administrators can initiate partial LitePub/Pleroma-style relay subscriptions
for the instance actor, subject to the interoperability limitations described
above.  An installation can also enable [tags.pub] integration: public tagged
posts are sent to its relay unless the author opts out, and announcements from
tags.pub hashtag actors can populate local hashtag timelines.

[tags.pub]: https://tags.pub/


Security and moderation
-----------------------

Fedify verifies supported HTTP signatures and object integrity proofs before
verified activities reach the application inbox handlers.  Hackers' Pub
additionally validates activity ownership and same-origin relationships before
persisting remote actors, posts, reactions, follows, migrations, and other
state changes.

Federation blocks applied to individual cached remote actors are enforced
during ingestion and remote fetching.  Instance-wide blocking by hostname or
origin is not currently implemented.  Content hidden by a local moderation
sanction is not served through actor outboxes, featured collections, object
endpoints, reply collections, or reaction collections.


Additional documentation
------------------------

 -  [Setting up federation] for a development installation.
 -  [Fedify's federation documentation][Fedify federation] for framework-level
    protocol support.  The version linked near the top of this document matches
    the current Hackers' Pub dependency; the main-branch document may describe
    features not yet available here.

[Setting up federation]: CONTRIBUTING.md#setting-up-federation
[Fedify federation]: https://github.com/fedify-dev/fedify/blob/main/FEDERATION.md
