//! Pause/Resume: snapshot orchestrator state and gracefully stop/restart.
//!
//! `tokyo pause` saves the current state (workers, their prime messages, round
//! progress) to .tokyo/snapshot.json, then shuts down all workers + Lead.
//! `tokyo resume` reads the snapshot and re-spawns everything.

use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct OrchestratorSnapshot {
    pub model: String,
    pub extension: Option<String>,
    pub session_dir: Option<String>,
    pub workers: Vec<WorkerSnapshot>,
    pub paused_at: String,
    pub phase: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct WorkerSnapshot {
    pub id: String,
    pub model: String,
    pub prime_message: Option<String>,
}

/// Save orchestrator state to .tokyo/snapshot.json
pub fn save_snapshot(project_dir: &Path, snapshot: &OrchestratorSnapshot) -> anyhow::Result<PathBuf> {
    let path = project_dir.join(".tokyo").join("snapshot.json");
    let json = serde_json::to_string_pretty(snapshot)?;
    std::fs::write(&path, json)?;
    Ok(path)
}

/// Load orchestrator state from .tokyo/snapshot.json
pub fn load_snapshot(project_dir: &Path) -> anyhow::Result<OrchestratorSnapshot> {
    let path = project_dir.join(".tokyo").join("snapshot.json");
    let json = std::fs::read_to_string(&path)?;
    let snapshot: OrchestratorSnapshot = serde_json::from_str(&json)?;
    Ok(snapshot)
}

/// Remove the snapshot file after successful resume.
pub fn clear_snapshot(project_dir: &Path) -> anyhow::Result<()> {
    let path = project_dir.join(".tokyo").join("snapshot.json");
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

/// Check if a snapshot exists (for resume eligibility).
pub fn has_snapshot(project_dir: &Path) -> bool {
    project_dir.join(".tokyo").join("snapshot.json").exists()
}
