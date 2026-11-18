# One plan across deployment units

A workspace plan combines several project and workspace pairs. Each pair keeps its CREATE2 salts, mixer derivations, resource IDs, state path and journal scope. Only the execution graph uses namespaced IDs. One apply reserves nonces, accounts for spending and checks finality across the combined graph.

Use two plans when an off-chain result is required between phases. For example, the first phase deploys a factory while L2 tokens deploy. The second phase starts after the locked token addresses are available. A locked token is an input to the second plan; the plan cannot infer or bypass that gate.

## Manifest

Paths are relative to the manifest. A local unit needs `projectDirectory` and `workspace`. Optional `varFiles` and `vars` have the same meaning as ordinary project inputs. Local `stateFile` and `journalFile` overrides are optional. The defaults remain the selected project's workspace directory.

```json
{
  "units": [
    {"key":"portal_dai","projectDirectory":"../etherplan/portal","workspace":"prod__brg-dai","varFiles":["dai-portal.ethpvars"]},
    {"key":"bridge_dai","projectDirectory":"../etherplan/bridge","workspace":"prod__brg-dai","varFiles":["dai-bridge.ethpvars"]}
  ],
  "links": [
    {"consumer":{"unit":"bridge_dai","resource":"external:oxidePortal"},"producer":{"unit":"portal_dai","resource":"call:deployPortal"}}
  ]
}
```

A linked external must have a runtime hash. Its address must equal the producer contract's address or the separate check address of a creator call with `before_absent`. An absent linked external gets a read-only verification action after the producer. Its dependents cannot sign before that verification succeeds. The verification action uses no nonce and creates no receipt wait. An absent external without a reviewed producer remains unverified.

A literal cross-unit reference can name an exact prepared input location, such as `inputs.0.3.0.1` or `args.0`. The value at that location must equal the producer address. The link adds an execution edge. This supports a forwarding-table constructor that reads each Portal and a call that approves a table. References that only store an address can be reviewed separately when reducing execution edges.

```sh
etherplan plan --workspace-manifest prepared/phase-b.json --pipeline \
  --deployers 0x... --named-signers '{"portalOwner":"0x...","nameOwner":"0x..."}' \
  --max-spend-wei 1000000000000000000 --out prepared/phase-b-plan.json
etherplan apply --plan prepared/phase-b-plan.json --pipeline --signer-module ./signers.mjs --json
```

Apply can run outside a project directory. It reloads each saved source project, variable file and artifact. A changed source, backend identity, unit scope or foreign state stops before signatures. The saved plan pins signer addresses and the spend ceiling per distinct signer across all units. Aliased roles share that ceiling and one nonce lane.

## Durability and recovery

All unit writer locks and distinct signer locks stay held through finality and state writes. Local applies register every real unit journal in the host signer registry. Remote units must use the same signer coordination store and confirmation policy. Each remote unit uses its own deployment scope, hash chain, encryption context and real lease fence.

Journal records keep local action IDs. A workspace sequence reconstructs the combined reservation order after interruption. Signed bytes, receipts and pinned-child commitments remain readable from the original unit journal. A later standalone plan can verify and reuse those resources.

State is partitioned back into local IDs only after all desired checks and finality pass. If a later unit state write fails, the same saved workspace plan resumes the partial write. It does not sign completed actions again. Save and retry that plan; do not replace it with a new plan while signatures remain unresolved. Unit publication must wait for the whole apply to succeed.

## Programmatic API

`createWorkspacePlan({units, links, client, pipeline, maxSpendWei})` accepts compiled specs and artifact maps. Each local unit supplies `key`, `project`, `workspace`, `stateFile` and `journalFile`. `applyWorkspacePlan` reloads those units and uses the ordinary apply options and signer providers.

A remote unit supplies `backend` instead of local paths. Its backend includes the ordinary stores, cipher and deployment scope, plus an explicit confirmation policy, a stable backend `identity`, and a shared `coordinationId`. The latter identifies the chain-wide signer-history and lease service. The CLI derives both identities from backend configuration and requires each unit's existing backend initialization marker. It never creates or initializes a production backend implicitly.
