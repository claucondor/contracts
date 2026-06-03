# Mainnet Deploy Playbook — Janus v0.6.6

## Overview

This playbook covers deploying the Janus confidential token stack to Flow EVM mainnet.
It mirrors the testnet v0.6.6 deploy exactly. Work from openjanus-contracts `main` (after
merge of `fix/v0.6.6-clean-deploy`).

## Pre-requisites

- [ ] Flow mainnet account with 200+ FLOW for deploy gas
- [ ] COA set up on the mainnet admin account
- [ ] `flow.json` with `mainnet-admin` account pointing to a P-256 key
- [ ] Compiled contract artifacts (`npm run compile` in both packages)
- [ ] SDK E2E test passed 4/4 on testnet with these exact artifacts

## Admin account setup

```bash
# 1. Generate key
flow keys generate --sig-algo ECDSA_P256 --output json > /tmp/mainnet_admin_keypair.json
# Save private key to permanent location — NEVER commit
cp /tmp/mainnet_admin_keypair_privkey.hex ~/.flow/mainnet-admin.pkey

# 2. Create account (use an existing funded account as creator)
flow accounts create \
  --key <pubkey> --sig-algo ECDSA_P256 --hash-algo SHA3_256 \
  --signer <funded-mainnet-account> \
  --network mainnet \
  --config-path flow.json

# 3. Fund account (minimum 200 FLOW for deploy gas)

# 4. Set up COA
flow transactions send /tmp/v066_setup_coa.cdc \
  --network mainnet --signer mainnet-admin
```

Document the COA EVM address from the CadenceOwnedAccountCreated event.

## Deployment order (strictly sequential)

### Step 1: Compile contracts
```bash
cd packages/janus-token && npm run compile
cd packages/janus-erc20 && npm run compile
```

### Step 2: Stateless infrastructure (CAN be reused from testnet if same zkeys)
- **BabyJub.sol** — deploy once, reuse forever (stateless curve arithmetic)
- **AmountDiscloseVerifier.sol** — tied to specific zkey; redeploy if ceremony changes
- **ConfidentialTransferVerifier.sol** — tied to specific zkey; redeploy if ceremony changes
- **MemoKeyRegistry.sol** — deploy once (stores user pubkeys, no admin needed)

```bash
# Deploy BabyJub
node scripts/deploy-babyjub.mjs  # adapt from deploy-v0.6.6.mjs

# Deploy verifiers
node scripts/deploy-verifiers.mjs

# Deploy MemoKeyRegistry
node scripts/deploy-registry.mjs
```

### Step 3: Token deployments

For each token (JanusFlow, JanusERC20/WFLOW, JanusERC20/USDC):

```bash
# 3a. Deploy underlying asset (for ERC20 tokens — use official mainnet USDC/WFLOW addresses)
# For JanusFlow: no underlying, native FLOW

# 3b. Deploy impl (uninitialised)
node scripts/deploy-impl.mjs --token flow

# 3c. Deploy proxy + atomic initialize
# initialize args:
#   _babyJub: <BabyJub address>
#   _transferVerifier: <ConfidentialTransferVerifier address>
#   _amountDiscloseVerifier: <AmountDiscloseVerifier address>
#   _owner: <admin COA EVM address>
#   _memoRegistry: <MemoKeyRegistry address>
node scripts/deploy-proxy.mjs --token flow
```

### Step 4: Fee configuration
```bash
# initFees(adminCOA, 10)  — 0.1% fee, recipient = admin COA
node scripts/init-fees.mjs
```

### Step 5: Smoke test
Run the E2E script against mainnet addresses:
```bash
node scripts/e2e-multitoken.mjs  # update addresses to mainnet
```

## MAINNET-SPECIFIC REQUIREMENTS

### OFAC compliance hook (REQUIRED before mainnet)
Per the `mainnet-compliance-ofac` memory: integrate Chainalysis Oracle hook in
wrap() before mainnet. This is NOT in the current contracts. You MUST add this
before deploying to mainnet or accepting real user funds.

Pattern: in `JanusFlow._wrap()` and `JanusERC20._wrap()`, add:
```solidity
// Before _acceptShieldedCredit
require(
    IChainalysisOracle(chainalysisOracle).isSanctioned(msg.sender) == false,
    "JanusToken: sanctioned address"
);
```

### Fee configuration
- testnet: 10 bps (0.1%) to admin COA
- mainnet: operator decides (10-50 bps range recommended)
- feeBps is set once via initFees() and can be changed via setFeeBps() (owner-only)
- feeRecipient should be a multi-sig or governance contract, NOT a single EOA

### Upgrade path
All proxies are UUPS. To upgrade an impl:
```bash
flow transactions send upgrade-impl.cdc \
  "<proxy_address>" "<new_impl_address>" \
  --signer mainnet-admin
```
Upgrade is owner-only (owner = admin COA). Test on testnet fork first.

## Idempotency notes

| Script | Idempotent? | Notes |
|--------|------------|-------|
| deploy-babyjub.mjs | NO — deploys new address each run | Deploy once, record address |
| deploy-verifiers.mjs | NO | Deploy once per ceremony |
| deploy-registry.mjs | NO | Deploy once per network |
| deploy-impl.mjs | YES (deploys to fresh address) | Re-run is safe, just wastes gas |
| deploy-proxy.mjs | NO — initializer runs once | One-shot per proxy |
| init-fees.mjs | NO — initFees reverts if called twice | One-shot |

## Admin COA rotation

If admin key is compromised:
1. Deploy new admin account + set up COA
2. On each proxy: `transferOwnership(newAdminCOA)` via the old admin COA
3. Call setFeeRecipient(newAdminCOA) on each proxy
4. Update flow.json to point to new admin account

## Known issues / leftover concerns

1. **wflow not redeployed**: The wflow (WFLOW9) ERC20 wrapper has no fresh v0.6.6
   proxy. PrivateTip references it for UI, but transactions are disabled. Deploy
   a fresh JanusERC20 proxy with WFLOW9 as underlying before enabling wflow on
   mainnet.

2. **adminResetSlot is testnet-only**: Gated by `block.chainid == 545`. On mainnet
   this function reverts. This is correct — it must not be available on mainnet.
   The function exists in code but is dead on mainnet. Remove it entirely in
   a future upgrade to keep the surface clean.

3. **JanusFT / MockFT (Cadence)**: The testnet deploy reuses the existing JanusFT
   contract at 0x7599043aea001283. On mainnet, JanusFT must be deployed on the
   new admin Cadence account. The mockFT is testnet-only by definition.

4. **MemoKeyRegistry**: Shared, immutable. On mainnet, a new registry should be
   deployed and all proxies should point to it at initialize time.
