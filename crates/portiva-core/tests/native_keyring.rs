//! Opt-in OS integration. Uses a generated data directory and synthetic secrets only.
use anyhow::Result;
use portiva_core::*;

#[test]
#[ignore = "writes and removes a disposable credential in the current user's OS credential store"]
fn native_credential_roundtrip_and_cleanup() -> Result<()> {
    let data = tempfile::tempdir()?;
    let profile = Profile {
        name: "Portiva2 disposable credential test".into(),
        host: "synthetic.invalid".into(),
        remember_secret: true,
        ..Default::default()
    };
    let store = Store::open(data.path())?;
    let result = (|| -> Result<()> {
        store.save_connection(
            profile.clone(),
            &Credentials::password("synthetic-portiva2-test-only".into()),
        )?;
        let reopened = Store::open(data.path())?;
        let restored = reopened.profiles()?.remove(0);
        assert_eq!(
            &*reopened
                .resolve_credentials(&restored, Credentials::default())?
                .password,
            "synthetic-portiva2-test-only"
        );
        assert!(
            !std::fs::read_to_string(data.path().join("profiles.json"))?
                .contains("synthetic-portiva2-test-only")
        );
        reopened.forget_secret(&profile.id)?;
        assert!(
            reopened
                .resolve_credentials(&profile, Credentials::default())
                .is_err()
        );
        Ok(())
    })();
    let cleanup = store.delete_profile(&profile.id);
    result?;
    cleanup?;
    Ok(())
}
