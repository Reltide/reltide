use reltide_capacity_probe::protocol::{
    ProbeConfig, ProbeEvent, ProbeInput, decode_input, validate,
};

fn input() -> ProbeInput {
    ProbeInput {
        run_id: "test-1".into(),
        sequence: 1,
        payload: "synthetic".into(),
        hold_seconds: 0,
    }
}

#[test]
fn rejects_unsafe_run_id() {
    for run_id in ["", "UPPER", "a/b", "test_1", &"a".repeat(65)] {
        assert!(
            validate(&ProbeInput {
                run_id: run_id.into(),
                ..input()
            })
            .is_err()
        );
    }
}

#[test]
fn rejects_sequence_above_pg_bigint() {
    assert!(
        validate(&ProbeInput {
            sequence: u64::MAX,
            ..input()
        })
        .is_err()
    );
}

#[test]
fn rejects_payload_above_1024_bytes() {
    assert!(
        validate(&ProbeInput {
            payload: "x".repeat(1025),
            ..input()
        })
        .is_err()
    );
}

#[test]
fn rejects_hold_above_60_seconds() {
    assert!(
        validate(&ProbeInput {
            hold_seconds: 61,
            ..input()
        })
        .is_err()
    );
}

#[test]
fn accepts_boundary_input() {
    assert!(
        validate(&ProbeInput {
            run_id: "a".repeat(64),
            sequence: i64::MAX as u64,
            payload: "x".repeat(1024),
            hold_seconds: 60
        })
        .is_ok()
    );
}

#[test]
fn rejects_multibyte_payload_above_byte_limit() {
    assert!(
        validate(&ProbeInput {
            payload: "é".repeat(513),
            ..input()
        })
        .is_err()
    );
}

#[test]
fn rejects_unknown_request_fields() {
    assert!(
        decode_input(
            br#"{"run_id":"test-1","sequence":1,"payload":"x","hold_seconds":0,"secret":"dsn"}"#
        )
        .is_err()
    );
}

#[test]
fn redacts_database_and_address_from_debug() {
    let config = ProbeConfig {
        temporal_address: "http://secret:7233".into(),
        namespace: "reltide-capacity-test-1".into(),
        task_queue: "reltide-capacity-test-1".into(),
        application_database_url: "postgres://secret@localhost/probe".into(),
    };
    let debug = format!("{config:?}");
    assert!(!debug.contains("secret"));
}

#[test]
fn rejects_namespace_outside_run() {
    let config = ProbeConfig {
        temporal_address: "http://localhost:7233".into(),
        namespace: "default".into(),
        task_queue: "reltide-capacity-test-1".into(),
        application_database_url: "postgres://localhost/probe".into(),
    };
    assert!(config.validate_for("test-1").is_err());
}

#[test]
fn encodes_versioned_committed_watermark() {
    let event = ProbeEvent::Watermark {
        sequence: 1,
        sha256: "abc".into(),
        post_commit_time: "2026-09-27T12:00:00.000000Z".into(),
    };
    let encoded = serde_json::to_value(event.envelope("test-1").unwrap()).unwrap();
    assert_eq!(
        (
            encoded["protocol_version"].as_u64(),
            encoded["event"].as_str(),
            encoded["run_id"].as_str(),
            encoded["sequence"].as_u64()
        ),
        (Some(1), Some("watermark"), Some("test-1"), Some(1))
    );
}

#[test]
fn hashes_exact_payload_bytes() {
    assert_eq!(
        reltide_capacity_probe::ledger::checksum("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn rejects_seed_that_is_not_the_approved_fixture() {
    assert!(reltide_capacity_probe::ledger::validate_seed(&input()).is_err());
}
