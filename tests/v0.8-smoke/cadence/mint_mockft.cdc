/// mint_mockft.cdc — Mint MockFT tokens to a recipient address.
/// Signer must hold MockFT.Minter at MockFT.MinterStoragePath.

import "MockFT"
import "FungibleToken"

transaction(amount: UFix64, recipient: Address) {
    prepare(signer: auth(BorrowValue) &Account) {
        let minter = signer.storage.borrow<&MockFT.Minter>(from: MockFT.MinterStoragePath)
            ?? panic("mint_mockft: no Minter at MockFT.MinterStoragePath — signer is not MockFT admin")

        let minted <- minter.mintTokens(amount: amount)

        let receiverCap = getAccount(recipient)
            .capabilities.borrow<&{FungibleToken.Receiver}>(MockFT.ReceiverPublicPath)
            ?? panic("mint_mockft: recipient has no MockFT Receiver at MockFT.ReceiverPublicPath")

        receiverCap.deposit(from: <-minted)
        log("mint_mockft: minted ".concat(amount.toString()).concat(" MockFT to ").concat(recipient.toString()))
    }
}
