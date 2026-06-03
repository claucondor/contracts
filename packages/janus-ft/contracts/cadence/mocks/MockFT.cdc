// MockFT.cdc — Generic FungibleToken for testnet use alongside JanusMockFT.
//
// Implements the full Cadence FungibleToken + ViewResolver interface.
// At mainnet, swap the JanusMockFT import to FUSD or any real FT.
//
// Token: "MockFT" / "MFT" — 8 decimal places (same scaling as FlowToken).
// Minting: only the Minter resource at /storage/mockFTMinter may mint tokens.

import "FungibleToken"
import "MetadataViews"
import "FungibleTokenMetadataViews"
import "ViewResolver"

access(all) contract MockFT: FungibleToken {

    // -----------------------------------------------------------------------
    // FungibleToken.totalSupply
    // -----------------------------------------------------------------------

    access(all) var totalSupply: UFix64

    // -----------------------------------------------------------------------
    // Storage paths
    // -----------------------------------------------------------------------

    access(all) let VaultStoragePath:   StoragePath
    access(all) let ReceiverPublicPath: PublicPath
    access(all) let BalancePublicPath:  PublicPath
    access(all) let MinterStoragePath:  StoragePath
    access(all) let AdminStoragePath:   StoragePath

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    access(all) event TokensInitialized(initialSupply: UFix64)
    access(all) event TokensWithdrawn(amount: UFix64, from: Address?)
    access(all) event TokensDeposited(amount: UFix64, to: Address?)
    access(all) event TokensMinted(amount: UFix64)
    access(all) event TokensBurned(amount: UFix64)

    // -----------------------------------------------------------------------
    // Vault Resource
    // -----------------------------------------------------------------------

    access(all) resource Vault: FungibleToken.Vault {

        access(all) var balance: UFix64

        init(balance: UFix64) {
            self.balance = balance
        }

        // ---- FungibleToken.Provider ----

        access(FungibleToken.Withdraw) fun withdraw(amount: UFix64): @{FungibleToken.Vault} {
            pre {
                self.balance >= amount: "MockFT.Vault.withdraw: insufficient balance"
            }
            self.balance = self.balance - amount
            emit TokensWithdrawn(amount: amount, from: self.owner?.address)
            return <- create Vault(balance: amount)
        }

        // ---- FungibleToken.Receiver ----

        access(all) fun deposit(from: @{FungibleToken.Vault}) {
            let vault <- from as! @MockFT.Vault
            let amount = vault.balance
            self.balance = self.balance + amount
            vault.balance = 0.0
            destroy vault
            emit TokensDeposited(amount: amount, to: self.owner?.address)
        }

        access(all) view fun getSupportedVaultTypes(): {Type: Bool} {
            return {self.getType(): true}
        }

        access(all) view fun isSupportedVaultType(type: Type): Bool {
            return type == self.getType()
        }

        // ---- FungibleToken.Balance ----

        access(all) view fun isAvailableToWithdraw(amount: UFix64): Bool {
            return self.balance >= amount
        }

        // ---- ViewResolver.Resolver (delegated to contract) ----

        access(all) view fun getViews(): [Type] {
            return MockFT.getContractViews(resourceType: nil)
        }

        access(all) fun resolveView(_ view: Type): AnyStruct? {
            return MockFT.resolveContractView(resourceType: nil, viewType: view)
        }

        // ---- Burner.Burnable ----

        access(contract) fun burnCallback() {
            if self.balance > 0.0 {
                MockFT.totalSupply = MockFT.totalSupply - self.balance
                emit TokensBurned(amount: self.balance)
            }
            self.balance = 0.0
        }

        // ---- FungibleToken.Vault factory ----

        access(all) fun createEmptyVault(): @{FungibleToken.Vault} {
            return <- MockFT.createEmptyVault(vaultType: Type<@MockFT.Vault>())
        }
    }

    // -----------------------------------------------------------------------
    // ViewResolver contract interface implementation
    // -----------------------------------------------------------------------

    access(all) view fun getContractViews(resourceType: Type?): [Type] {
        return [
            Type<FungibleTokenMetadataViews.FTView>(),
            Type<FungibleTokenMetadataViews.FTDisplay>(),
            Type<FungibleTokenMetadataViews.FTVaultData>(),
            Type<FungibleTokenMetadataViews.TotalSupply>()
        ]
    }

    access(all) fun resolveContractView(resourceType: Type?, viewType: Type): AnyStruct? {
        switch viewType {
            case Type<FungibleTokenMetadataViews.FTView>():
                return FungibleTokenMetadataViews.FTView(
                    ftDisplay: self.resolveContractView(
                        resourceType: nil,
                        viewType: Type<FungibleTokenMetadataViews.FTDisplay>()
                    ) as! FungibleTokenMetadataViews.FTDisplay?,
                    ftVaultData: self.resolveContractView(
                        resourceType: nil,
                        viewType: Type<FungibleTokenMetadataViews.FTVaultData>()
                    ) as! FungibleTokenMetadataViews.FTVaultData?
                )

            case Type<FungibleTokenMetadataViews.FTDisplay>():
                let media = MetadataViews.Media(
                    file: MetadataViews.HTTPFile(url: "https://openjanus.xyz/mockft.png"),
                    mediaType: "image/png"
                )
                return FungibleTokenMetadataViews.FTDisplay(
                    name: "MockFT",
                    symbol: "MFT",
                    description: "MockFT — testnet fungible token for JanusMockFT privacy testing",
                    externalURL: MetadataViews.ExternalURL("https://openjanus.xyz"),
                    logos: MetadataViews.Medias([media]),
                    socials: {}
                )

            case Type<FungibleTokenMetadataViews.FTVaultData>():
                return FungibleTokenMetadataViews.FTVaultData(
                    storagePath:        MockFT.VaultStoragePath,
                    receiverPath:       MockFT.ReceiverPublicPath,
                    metadataPath:       MockFT.BalancePublicPath,
                    receiverLinkedType: Type<&{FungibleToken.Receiver}>(),
                    metadataLinkedType: Type<&{FungibleToken.Balance, ViewResolver.Resolver, FungibleToken.Vault}>(),
                    createEmptyVaultFunction: (fun(): @{FungibleToken.Vault} {
                        return <- MockFT.createEmptyVault(vaultType: Type<@MockFT.Vault>())
                    })
                )

            case Type<FungibleTokenMetadataViews.TotalSupply>():
                return FungibleTokenMetadataViews.TotalSupply(totalSupply: MockFT.totalSupply)
        }
        return nil
    }

    // -----------------------------------------------------------------------
    // Minter Resource
    // -----------------------------------------------------------------------

    access(all) resource Minter {
        access(all) fun mintTokens(amount: UFix64): @MockFT.Vault {
            pre { amount > 0.0: "MockFT.Minter: amount must be > 0" }
            MockFT.totalSupply = MockFT.totalSupply + amount
            emit TokensMinted(amount: amount)
            return <- create Vault(balance: amount)
        }
    }

    // -----------------------------------------------------------------------
    // Admin Resource
    // -----------------------------------------------------------------------

    access(all) resource Admin {
        access(all) fun createMinter(): @Minter {
            return <- create Minter()
        }
    }

    // -----------------------------------------------------------------------
    // FungibleToken interface: createEmptyVault
    // -----------------------------------------------------------------------

    access(all) fun createEmptyVault(vaultType: Type): @{FungibleToken.Vault} {
        return <- create Vault(balance: 0.0)
    }

    // -----------------------------------------------------------------------
    // Init
    // -----------------------------------------------------------------------

    init() {
        self.totalSupply = 0.0

        self.VaultStoragePath   = /storage/mockFTVault
        self.ReceiverPublicPath = /public/mockFTReceiver
        self.BalancePublicPath  = /public/mockFTBalance
        self.MinterStoragePath  = /storage/mockFTMinter
        self.AdminStoragePath   = /storage/mockFTAdmin

        // Deployer gets Minter and Admin
        self.account.storage.save(<- create Minter(), to: self.MinterStoragePath)
        self.account.storage.save(<- create Admin(),  to: self.AdminStoragePath)

        // Deployer gets an empty vault
        let vault <- create Vault(balance: 0.0)
        self.account.storage.save(<- vault, to: self.VaultStoragePath)

        let receiverCap = self.account.capabilities.storage.issue<&{FungibleToken.Receiver}>(
            self.VaultStoragePath
        )
        self.account.capabilities.publish(receiverCap, at: self.ReceiverPublicPath)

        let balanceCap = self.account.capabilities.storage.issue<&{FungibleToken.Balance}>(
            self.VaultStoragePath
        )
        self.account.capabilities.publish(balanceCap, at: self.BalancePublicPath)

        emit TokensInitialized(initialSupply: 0.0)
    }
}
