//! Integration tests using mock-pi.js (no real LLM needed).
//!
//! Set PI_BIN env to point to mock-pi.js before running.

use std::path::PathBuf;

fn mock_pi_path() -> String {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests/mock-pi.mjs");
    p.to_string_lossy().into_owned()
}

#[tokio::test]
async fn test_single_prompt() {
    unsafe { std::env::set_var("PI_BIN", mock_pi_path()); }
    let mut worker = tokyo_orchestrator::rpc::RpcWorker::spawn("mock", None, None)
        .await
        .expect("spawn mock");
    let resp = worker.prompt("Hello").await.expect("prompt");
    assert!(resp.contains("[mock response #1"));
    worker.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn test_persistence_across_rounds() {
    unsafe { std::env::set_var("PI_BIN", mock_pi_path()); }
    let mut worker = tokyo_orchestrator::rpc::RpcWorker::spawn("mock", None, None)
        .await
        .expect("spawn mock");

    let r1 = worker.prompt("Remember this secret code: MANGO77.").await.expect("r1");
    assert_eq!(r1.trim(), "stored");

    let r2 = worker.prompt("What was the secret code I told you?").await.expect("r2");
    assert_eq!(r2.trim(), "MANGO77");

    worker.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn test_team_broadcast() {
    unsafe { std::env::set_var("PI_BIN", mock_pi_path()); }

    let workers = vec![
        tokyo_orchestrator::team::WorkerConfig {
            id: "w1".into(),
            model: "mock".into(),
            system_prompt: "You are w1.".into(),
        },
        tokyo_orchestrator::team::WorkerConfig {
            id: "w2".into(),
            model: "mock".into(),
            system_prompt: "You are w2.".into(),
        },
    ];

    let mut team = tokyo_orchestrator::team::Team::spawn("mock", None, workers)
        .await
        .expect("spawn team");

    let results = team.broadcast("What is 2+2?").await.expect("broadcast");
    assert_eq!(results.len(), 2);
    // Mock returns "4" for 2+2
    for (_, text) in &results {
        assert_eq!(text.trim(), "4");
    }

    team.shutdown().await.expect("shutdown");
}
