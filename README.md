# claucondor/contracts

Token standards and high-level contracts built on [@claucondor/primitives](https://github.com/claucondor/primitives).

---

## What this repo is

`claucondor/contracts` is **TIER 2** — it consumes primitives (BabyJub, Pedersen,
Groth16) and composes them into deployable token contracts with full Cadence and
EVM support on Flow.

```
TIER 1  claucondor/primitives   -- BabyJub.sol, Pedersen, Groth16 verifier infrastructure
  |
TIER 2  claucondor/contracts    -- this repo: JanusToken, JanusFlow, JanusERC20
  |
TIER 3  apps                    -- PrivateTip, LetheOrderbook, AuroraReveal, etc.
```

The privacy primitive in every contract is the same: **Pedersen commitments** on
BabyJubJub, gated by **Groth16** ZK proofs for wrap, shielded transfer, and
unwrap.

---

## Packages

| Package | Description |
|---|---|
| [`@claucondor/janus-token`](./packages/janus-token) | Abstract base SDK class (Pedersen-commit confidential token with Groth16-gated wrap/transfer/unwrap) |
| [`@claucondor/janus-flow`](./packages/janus-flow) | Native FLOW concrete token via Cadence cross-VM |
| [`@claucondor/janus-erc20`](./packages/janus-erc20) | ERC20-wrapping confidential token on Flow EVM |
| [`@claucondor/janus-ft`](./packages/janus-ft) | Any Cadence FungibleToken vault |

All four packages are also re-exported by [`@claucondor/sdk`](https://github.com/claucondor/sdk)
as `@claucondor/sdk/tokens` — most apps should import from the SDK rather than
from individual package paths.

---

## Roman mythology naming convention

Every contract in this repo takes the name of a Roman deity associated with
**doors, transitions, keys, and thresholds** — reflecting the cross-VM nature
of the Janus privacy stack (Cadence + EVM). Janus: the two-faced god of beginnings
who stands at every threshold, looking simultaneously inward (Cadence) and
outward (EVM).

| Name | Deity / Association | Contract | Status |
|---|---|---|---|
| **Janus** | Dual-faced god of beginnings and thresholds | `JanusToken` — Pedersen commitments + Groth16 | Current |
| Cardea | Goddess of door hinges | `CardeaVault` — time-locked vault | future |
| Portunus | God of keys and ports | `PortunusKey` — multisig key manager | future |
| Limen | God of thresholds | `LimenBridge` — cross-VM router | future |
| Iris | Rainbow messenger of the gods | `IrisStream` — streaming payments | future |
| Forculus | God of doors | `ForculusGate` — NFT-gated access | future |
| Vesta | Goddess of the hearth / treasury | `VestaTreasury` — fee router | future |
| Minerva | Goddess of wisdom | `MinervaProof` — ZK proof toolkit | future |
| Lethe | River of forgetting | `LetheOrderbook` — sealed-bid orderbook | future |
| Proteus | Shape-shifting sea-god | `ProteusShuffle` — verifiable shuffle | future |
| Aurora | Goddess of dawn | `AuroraReveal` — time-released reveal | future |
| Vesper | Evening star | `VesperVault` — concealed storage | future |
| Hekate | Goddess of crossroads and keys | `HekateMixer` — mixer pattern | future |
| Mercurius | Messenger of the gods | `MercuriusTransfer` — generic transfer | future |

Package names use lowercase + hyphen: `@claucondor/janus-token`,
`@claucondor/cardea-vault`, etc.

---

## Quick start

```bash
npm install @claucondor/sdk
```

```typescript
import { JanusFlow } from "@claucondor/sdk/tokens";

const flow = new JanusFlow();
await flow.connectWithSigner(wallet);

// Read the caller's on-chain Pedersen commitment (opaque 256-bit point)
const commitment = await flow.balanceOfCommitment(coaEvmAddress);
// { x: bigint, y: bigint } — BabyJubJub point, not cleartext

// Full wrap / shieldedTransfer / unwrap: see @claucondor/sdk README
```

---

> **Status — testnet only.** These contracts are deployed on Flow EVM testnet
> for demonstration and integration testing. **Not recommended for production
> use until a third-party audit completes** (audit pending). Use at your own
> risk on testnet.

> **Fee model (v0.5.5+)**: `wrap` and `unwrap` each carry a **0.1% boundary
> fee** (10 bps, hard cap 100 bps). Shielded transfers are **free**. Fee
> recipient is configurable by the admin and accumulates as native FLOW in the
> recipient's EVM balance.

## Deployed contracts (testnet)

> **v0.6.4** — Multi-token sprint. MemoKeyRegistry unification, JanusFT generic wrapper,
> all three EVM proxies at feeBps=10.

### TIER 1 — Primitive contracts (shared, canonical)

| Contract | Network | Address |
|---|---|---|
| BabyJub.sol | Flow EVM testnet | `0x27139AFda7425f51F68D32e0A38b7D43BcB0f870` |
| AmountDiscloseVerifier | Flow EVM testnet | `0xD0ED3936530258C278f5357C1dB709ad34768352` |
| ConfidentialTransferVerifier | Flow EVM testnet | `0x84852aF72D2EF2A0A937e8Dae0BFA482E707E39B` |
| MemoKeyRegistry | Flow EVM testnet | `0x05D104962ff087441f26BA11A1E1C3b9E091D663` |

### TIER 2 — Token contracts (v0.6.4)

| Contract | Network | Address |
|---|---|---|
| JanusFlow proxy (ERC1967 UUPS) | Flow EVM testnet | `0x2458ae2d26797c2ffa3B4f6612Bdc4aDf22b7156` |
| JanusWFLOW proxy | Flow EVM testnet | `0x00129E94d5340bd19d0b4ed9CDf718BB6e0A9400` |
| JanusMockUSDC proxy | Flow EVM testnet | `0xd45FDa099Cf67eD842eA379865AB08E18D62BAf3` |
| Fee recipient (admin COA) | Flow EVM testnet | `0x0000000000000000000000022f6b30Af48A94787` |
| JanusFlow.cdc router | Flow Cadence testnet | `0x5dcbeb41055ec57e` |
| JanusFT (generic Cadence wrapper) | Flow Cadence testnet | `0x7599043aea001283` |

All EVM tokens: feeBps=10 (0.1%). All Cadence tokens: same fee model.

Trusted setup: Hermez pot18 (200+ contributors) + one named phase-2
contributor + Flow VRF beacon at testnet block `324,226,714`. Full provenance in
`circuits/CEREMONY-RECORD.json` in the SDK package.

### TIER 3 — Reference app

| Contract | Network | Address |
|---|---|---|
| PrivateTip.cdc (router + impl) | Flow Cadence testnet | `0xb9ac529c14a4c5a1` |

---

## Development

```bash
npm install
npm run build
npm run test
npm run typecheck
```

Requires Node 20+.

---

## License

MIT
