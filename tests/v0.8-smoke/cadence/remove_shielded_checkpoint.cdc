transaction {
    prepare(signer: auth(RemoveContract) &Account) {
        signer.contracts.remove(name: "ShieldedCheckpoint")
        log("ShieldedCheckpoint removed")
    }
}
