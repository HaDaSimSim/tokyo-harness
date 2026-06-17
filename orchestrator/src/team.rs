//! Team orchestration: Lead session + N persistent workers.
//!
//! The Lead runs the tokyo extension (phase machine, gates, etc.).
//! Workers are bare pi --mode rpc sessions with custom system prompts.
//! The orchestrator dispatches tasks to workers and collects responses.

use crate::rpc::RpcWorker;

pub struct WorkerConfig {
    pub id: String,
    pub model: String,
    pub system_prompt: String,
}

pub struct Team {
    pub lead: RpcWorker,
    pub workers: Vec<Worker>,
}

pub struct Worker {
    pub id: String,
    pub rpc: RpcWorker,
}

impl Team {
    /// Spawn a full team: lead + N workers.
    pub async fn spawn(
        lead_model: &str,
        extension: Option<&str>,
        worker_configs: Vec<WorkerConfig>,
    ) -> anyhow::Result<Self> {
        // Spawn lead with the tokyo extension
        let lead = RpcWorker::spawn(lead_model, extension, None).await?;

        // Spawn workers in parallel
        let mut workers = Vec::with_capacity(worker_configs.len());
        for cfg in worker_configs {
            // Workers get their system prompt as the first message (priming)
            let mut rpc = RpcWorker::spawn(&cfg.model, None, None).await?;

            // Prime the worker with its role via a system-prompt-like first message
            let prime = format!(
                "You are {}. Your role:\n{}\n\nAcknowledge with 'ready'.",
                cfg.id, cfg.system_prompt
            );
            let _ack = rpc.prompt(&prime).await?;

            workers.push(Worker { id: cfg.id, rpc });
        }

        Ok(Team { lead, workers })
    }

    /// Broadcast a task to all workers in parallel and collect responses.
    pub async fn broadcast(&mut self, task: &str) -> anyhow::Result<Vec<(String, String)>> {
        let mut set = tokio::task::JoinSet::new();
        let mut taken: Vec<Worker> = self.workers.drain(..).collect();

        for mut worker in taken {
            let task_owned = task.to_string();
            set.spawn(async move {
                let response = worker.rpc.prompt(&task_owned).await;
                (worker, response)
            });
        }

        let mut results = Vec::new();
        while let Some(res) = set.join_next().await {
            let (worker, response) = res?;
            match response {
                Ok(text) => results.push((worker.id.clone(), text)),
                Err(e) => results.push((worker.id.clone(), format!("[error: {e}]"))),
            }
            self.workers.push(worker);
        }

        Ok(results)
    }

    /// Send a task to a specific worker by id.
    pub async fn send_to(&mut self, worker_id: &str, task: &str) -> anyhow::Result<String> {
        let worker = self.workers.iter_mut()
            .find(|w| w.id == worker_id)
            .ok_or_else(|| anyhow::anyhow!("worker '{}' not found", worker_id))?;
        worker.rpc.prompt(task).await
    }

    /// Shut down all workers and the lead.
    pub async fn shutdown(self) -> anyhow::Result<()> {
        for worker in self.workers {
            worker.rpc.shutdown().await?;
        }
        self.lead.shutdown().await?;
        Ok(())
    }
}
