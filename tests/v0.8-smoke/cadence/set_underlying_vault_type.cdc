/// set_underlying_vault_type.cdc — Set JanusFT underlyingVaultTypeIdentifier via Admin.
/// Use before install_registry.cdc if the type drifted (e.g. after contract upgrade).

import "JanusFT"

transaction(typeIdentifier: String) {
    let admin: &JanusFT.Admin

    prepare(signer: auth(BorrowValue) &Account) {
        self.admin = signer.storage.borrow<&JanusFT.Admin>(
            from: JanusFT.AdminStoragePath
        ) ?? panic("set_underlying_vault_type: signer does not hold JanusFT.Admin")
    }

    execute {
        self.admin.setUnderlyingVaultType(typeIdentifier: typeIdentifier)
        log("set_underlying_vault_type: set to ".concat(typeIdentifier))
    }
}
