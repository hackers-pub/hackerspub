/**
 * @generated SignedSource<<e331df5e60caee1a58e0077d6cf98d1b>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type mediaDeleteOrphanMediaMutation$variables = Record<PropertyKey, never>;
export type mediaDeleteOrphanMediaMutation$data = {
  readonly deleteOrphanMedia: {
    readonly __typename: "DeleteOrphanMediaPayload";
    readonly deletedCount: number;
    readonly failedDiskDeletes: number;
    readonly status: {
      readonly cutoffDate: string;
      readonly orphanMediaCount: number;
    };
  } | {
    readonly __typename: "NotAuthenticatedError";
    readonly notAuthenticated: string;
  } | {
    readonly __typename: "NotAuthorizedError";
    readonly notAuthorized: string;
  } | {
    // This will never be '%other', but we need some
    // value in case none of the concrete values match.
    readonly __typename: "%other";
  };
};
export type mediaDeleteOrphanMediaMutation = {
  response: mediaDeleteOrphanMediaMutation$data;
  variables: mediaDeleteOrphanMediaMutation$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "alias": null,
    "args": null,
    "concreteType": null,
    "kind": "LinkedField",
    "name": "deleteOrphanMedia",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "__typename",
        "storageKey": null
      },
      {
        "kind": "InlineFragment",
        "selections": [
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "deletedCount",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "failedDiskDeletes",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "concreteType": "OrphanMediaStatus",
            "kind": "LinkedField",
            "name": "status",
            "plural": false,
            "selections": [
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "cutoffDate",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "orphanMediaCount",
                "storageKey": null
              }
            ],
            "storageKey": null
          }
        ],
        "type": "DeleteOrphanMediaPayload",
        "abstractKey": null
      },
      {
        "kind": "InlineFragment",
        "selections": [
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "notAuthenticated",
            "storageKey": null
          }
        ],
        "type": "NotAuthenticatedError",
        "abstractKey": null
      },
      {
        "kind": "InlineFragment",
        "selections": [
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "notAuthorized",
            "storageKey": null
          }
        ],
        "type": "NotAuthorizedError",
        "abstractKey": null
      }
    ],
    "storageKey": null
  }
];
return {
  "fragment": {
    "argumentDefinitions": [],
    "kind": "Fragment",
    "metadata": null,
    "name": "mediaDeleteOrphanMediaMutation",
    "selections": (v0/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [],
    "kind": "Operation",
    "name": "mediaDeleteOrphanMediaMutation",
    "selections": (v0/*: any*/)
  },
  "params": {
    "cacheID": "1364fbb899b298804448ce1a4f889d65",
    "id": null,
    "metadata": {},
    "name": "mediaDeleteOrphanMediaMutation",
    "operationKind": "mutation",
    "text": "mutation mediaDeleteOrphanMediaMutation {\n  deleteOrphanMedia {\n    __typename\n    ... on DeleteOrphanMediaPayload {\n      deletedCount\n      failedDiskDeletes\n      status {\n        cutoffDate\n        orphanMediaCount\n      }\n    }\n    ... on NotAuthenticatedError {\n      notAuthenticated\n    }\n    ... on NotAuthorizedError {\n      notAuthorized\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "81a2de26df26cc625848d35c9bd884a5";

export default node;
