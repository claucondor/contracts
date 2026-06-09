/// direct_deposit_to_inbox.cdc — Test helper: deposit a note directly to recipient's inbox.
///
/// Calls ShieldedInbox.Receiver.deposit() directly without going through JanusFT.
/// Used to seed inbox state for drain + ECIES decode tests without requiring a real
/// ZK-proof shieldedTransfer.
///
/// Args:
///   recipient   Address with ShieldedInbox installed
///   ciphertext  [UInt8] opaque ciphertext bytes
///   ephPubkeyX  UInt256 ephemeral public key X
///   ephPubkeyY  UInt256 ephemeral public key Y

import ShieldedInbox from "ShieldedInbox"

transaction(
    recipient:  Address,
    ciphertext: [UInt8],
    ephPubkeyX: UInt256,
    ephPubkeyY: UInt256
) {
    prepare(signer: auth(BorrowValue) &Account) {
        let inbox = getAccount(recipient)
            .capabilities.borrow<&{ShieldedInbox.Receiver}>(/public/shieldedInbox)
            ?? panic("direct_deposit_to_inbox: recipient has no ShieldedInbox installed")

        inbox.deposit(
            ciphertext:  ciphertext,
            ephPubkeyX:  ephPubkeyX,
            ephPubkeyY:  ephPubkeyY,
            depositor:   signer.address
        )
    }
}
