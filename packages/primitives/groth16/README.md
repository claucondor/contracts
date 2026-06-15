# @claucondor/groth16

Groth16 verifier infrastructure on Flow EVM.

Generic Groth16 proof verification using BN254 pairing precompiles. Includes the `ConfidentialTransfer` circuit as a reference implementation and the `proofToEVMFormat` SDK function that handles the critical pi_b Fp2 swap.

## Deployed verifier

| Contract | Address |
|----------|---------|
| `ConfidentialTransferVerifier.sol` | `0x70FA331534619DBd4051b22b7fb19e647be141b0` |

## What is Groth16?

Groth16 is the most widely deployed ZK proof system (Tornado Cash, Zcash Sapling).
Key properties:
- **Constant proof size** (~200 bytes) regardless of circuit complexity
- **Fast verification** via BN254 pairing precompiles on EVM
- **Zero-knowledge** — the proof reveals nothing beyond validity

## The pi_b swap (IMPORTANT)

snarkJS emits `pi_b` in `(real, imaginary)` order. EIP-197 expects `(imaginary, real)`.
Without the swap, `verifyProof` returns `false` for valid proofs — no error, just silent failure.

The SDK handles this automatically:
```typescript
import { proofToEVMFormat } from "@claucondor/groth16";
const { pA, pB, pC } = proofToEVMFormat(snarkjsProof);
// pB is already swapped — safe to pass to verifyProof()
```

See [research/PIB_SWAP.md](./research/PIB_SWAP.md) for the full explanation.

## Installation

```bash
npm install @claucondor/groth16 snarkjs
```

## TypeScript SDK

### Verify a proof on-chain

```typescript
import { verifyOnChain } from "@claucondor/groth16";

// proof and publicSignals come from snarkjs.groth16.fullProve()
const valid = await verifyOnChain(proof, publicSignals);
// Automatically applies pi_b swap, calls 0x70FA33...
```

### Verify locally (no network)

```typescript
import { verifyLocally } from "@claucondor/groth16";
import { readFileSync } from "fs";

const vk = JSON.parse(readFileSync("setup/verification_key.json", "utf8"));
const valid = await verifyLocally(vk, proof, publicSignals);
```

### Manual proof formatting (for custom verifiers)

```typescript
import { proofToEVMFormat, pubSignalsToArray } from "@claucondor/groth16";

const { pA, pB, pC } = proofToEVMFormat(snarkjsProof);
const pub = pubSignalsToArray(parsePublicSignals(rawSignals));

// Call your own verifier contract
await myVerifier.verifyProof(pA, pB, pC, pub);
```

## Calling from Cadence

```cadence
import "EVM"

access(all) fun main(
    pi_a: [UInt256; 2],
    pi_b: [[UInt256; 2]; 2],   // NOTE: pi_b Fp2 already swapped
    pi_c: [UInt256; 2],
    pubSignals: [UInt256; 6]
): Bool {
    let verifierAddress = EVM.addressFromString(
        "70FA331534619DBd4051b22b7fb19e647be141b0"
    )
    let calldata = EVM.encodeABIWithSignature(
        "verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[6])",
        [pi_a, pi_b, pi_c, pubSignals]
    )
    let result = EVM.dryCall(
        from: EVM.addressFromString("0000000000000000000000000000000000000000"),
        to: verifierAddress,
        data: calldata,
        value: EVM.Balance(attoflow: 0),
        gasLimit: 400_000
    )
    let decoded = EVM.decodeABI(types: [Type<Bool>()], data: result.data)
    return decoded[0] as! Bool
}
```

## ConfidentialTransfer circuit (reference)

The `ConfidentialTransfer v2` circuit proves:
1. `old_commit == Pedersen(old_value, old_blinding)`
2. `transfer_commit == Pedersen(transfer_value, transfer_blinding)`
3. `new_commit == Pedersen(old_value - transfer_value, new_blinding)`
4. `transfer_value in [0, 2^64)`
5. `transfer_value <= old_value`

Public inputs (6): three BabyJubJub commitment points × 2 coordinates each.

```
pubSignals[0] = old_commit.x
pubSignals[1] = old_commit.y
pubSignals[2] = transfer_commit.x
pubSignals[3] = transfer_commit.y
pubSignals[4] = new_commit.x
pubSignals[5] = new_commit.y
```

## Performance (Flow EVM testnet)

| Operation | Time | Gas |
|-----------|------|-----|
| Commitment computation | ~312ms | — |
| Proof generation (snarkjs) | ~1,700ms | — |
| Local verification (snarkjs) | ~62ms | — |
| On-chain `verifyProof` | ~546ms | ~253,531 |

## Using as base for your own circuit

1. Design and compile your circuit with circom
2. Run the trusted setup (use Hermez Powers of Tau for phase 1)
3. Generate the verifier: `snarkjs generateverifier --verification_key vk.json`
4. Deploy your generated verifier to Flow EVM
5. Use the `@claucondor/groth16` SDK with a custom `address` override

## Testing

```bash
# Unit tests (no network, no proof artifacts)
npm test

# Integration tests (requires WASM + zkey + live testnet)
RUN_INTEGRATION=1 WASM_PATH=... ZKEY_PATH=... VK_PATH=... npm run test:integration
```

## Security

EXPERIMENTAL — not audited. Single-contributor trusted setup (NOT for production).

## License

MIT
