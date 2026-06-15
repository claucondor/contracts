import ShieldedInbox from "../contracts/cadence/ShieldedInbox.cdc"

/// Deposit a note to `recipient`'s inbox via their public Receiver capability.
///
/// Parameters
/// ----------
/// recipient   - Address of the inbox owner.
/// ciphertext  - Opaque encrypted payload (max MAX_CIPHERTEXT_BYTES).
/// ephPubkeyX  - X-coordinate of sender's ephemeral public key.
/// ephPubkeyY  - Y-coordinate of sender's ephemeral public key.
transaction(
    recipient:  Address,
    ciphertext: [UInt8],
    ephPubkeyX: UInt256,
    ephPubkeyY: UInt256
) {
    prepare(depositor: &Account) {
        let cap = getAccount(recipient)
            .capabilities
            .borrow<&{ShieldedInbox.Receiver}>(/public/shieldedInbox)
            ?? panic("ShieldedInbox: recipient has no inbox")

        cap.deposit(
            ciphertext:  ciphertext,
            ephPubkeyX:  ephPubkeyX,
            ephPubkeyY:  ephPubkeyY,
            depositor:   depositor.address
        )
    }
}
