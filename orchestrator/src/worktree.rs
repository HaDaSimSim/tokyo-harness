//! Git worktree management for parallel worker execution.
//!
//! Each worker gets an independent git worktree so they can modify code
//! without conflicting. On completion, the orchestrator merges the worker's
//! branch back into the main branch.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Create a git worktree for a worker.
/// Returns the path to the worktree directory.
pub fn create_worktree(project_dir: &Path, worker_id: &str) -> anyhow::Result<PathBuf> {
    let worktree_dir = project_dir.join(".tokyo").join("worktrees").join(worker_id);
    let branch_name = format!("tokyo-worker/{worker_id}");

    // Create branch from current HEAD
    let output = Command::new("git")
        .args(["branch", &branch_name])
        .current_dir(project_dir)
        .output()?;
    if !output.status.success() {
        // Branch might already exist from a previous run, that's fine
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.contains("already exists") {
            anyhow::bail!("git branch failed: {stderr}");
        }
    }

    // Create worktree
    let output = Command::new("git")
        .args(["worktree", "add", worktree_dir.to_str().unwrap(), &branch_name])
        .current_dir(project_dir)
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // If worktree already exists, just return the path
        if stderr.contains("already checked out") || stderr.contains("already exists") {
            return Ok(worktree_dir);
        }
        anyhow::bail!("git worktree add failed: {stderr}");
    }

    Ok(worktree_dir)
}

/// Merge a worker's branch back into the current branch and remove the worktree.
pub fn merge_and_cleanup(project_dir: &Path, worker_id: &str) -> anyhow::Result<String> {
    let worktree_dir = project_dir.join(".tokyo").join("worktrees").join(worker_id);
    let branch_name = format!("tokyo-worker/{worker_id}");

    // Remove the worktree first (required before branch operations)
    let _ = Command::new("git")
        .args(["worktree", "remove", "--force", worktree_dir.to_str().unwrap()])
        .current_dir(project_dir)
        .output();

    // Merge the worker branch (no-ff to keep history clear)
    let output = Command::new("git")
        .args(["merge", "--no-ff", "-m", &format!("Merge tokyo-worker/{worker_id}"), &branch_name])
        .current_dir(project_dir)
        .output()?;

    let merge_result = if output.status.success() {
        format!("merged {branch_name} successfully")
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // If merge conflicts, abort and report
        let _ = Command::new("git")
            .args(["merge", "--abort"])
            .current_dir(project_dir)
            .output();
        format!("merge conflict in {branch_name}: {stderr}")
    };

    // Clean up the branch
    let _ = Command::new("git")
        .args(["branch", "-D", &branch_name])
        .current_dir(project_dir)
        .output();

    Ok(merge_result)
}

/// List active worktrees.
pub fn list_worktrees(project_dir: &Path) -> anyhow::Result<Vec<String>> {
    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(project_dir)
        .output()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let worktrees: Vec<String> = stdout
        .lines()
        .filter(|l| l.starts_with("worktree "))
        .map(|l| l.trim_start_matches("worktree ").to_string())
        .filter(|p| p.contains(".tokyo/worktrees/"))
        .collect();
    Ok(worktrees)
}
