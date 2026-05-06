/**
 * @generated SignedSource<<5e87f5442bb1266c72280e12384e85c8>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type mediaPageQuery$variables = Record<PropertyKey, never>;
export type mediaPageQuery$data = {
  readonly orphanMediaStatus: {
    readonly cutoffDate: string;
    readonly orphanMediaCount: number;
  } | null | undefined;
  readonly viewer: {
    readonly moderator: boolean;
  } | null | undefined;
};
export type mediaPageQuery = {
  response: mediaPageQuery$data;
  variables: mediaPageQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "moderator",
  "storageKey": null
},
v1 = {
  "alias": null,
  "args": null,
  "concreteType": "OrphanMediaStatus",
  "kind": "LinkedField",
  "name": "orphanMediaStatus",
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
};
return {
  "fragment": {
    "argumentDefinitions": [],
    "kind": "Fragment",
    "metadata": null,
    "name": "mediaPageQuery",
    "selections": [
      {
        "alias": null,
        "args": null,
        "concreteType": "Account",
        "kind": "LinkedField",
        "name": "viewer",
        "plural": false,
        "selections": [
          (v0/*: any*/)
        ],
        "storageKey": null
      },
      (v1/*: any*/)
    ],
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [],
    "kind": "Operation",
    "name": "mediaPageQuery",
    "selections": [
      {
        "alias": null,
        "args": null,
        "concreteType": "Account",
        "kind": "LinkedField",
        "name": "viewer",
        "plural": false,
        "selections": [
          (v0/*: any*/),
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "id",
            "storageKey": null
          }
        ],
        "storageKey": null
      },
      (v1/*: any*/)
    ]
  },
  "params": {
    "cacheID": "3bba66a6c9dc34af6623b5ba9d445450",
    "id": null,
    "metadata": {},
    "name": "mediaPageQuery",
    "operationKind": "query",
    "text": "query mediaPageQuery {\n  viewer {\n    moderator\n    id\n  }\n  orphanMediaStatus {\n    cutoffDate\n    orphanMediaCount\n  }\n}\n"
  }
};
})();

(node as any).hash = "1d406e46be173f2d8925fde32de62d4e";

export default node;
