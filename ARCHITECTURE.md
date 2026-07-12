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
