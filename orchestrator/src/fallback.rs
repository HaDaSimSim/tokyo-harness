//! Model fallback: retry with alternative models on provider errors.
//!
//! When a prompt fails with a rate limit, quota, or unavailability error,
//! automatically retry with the next model in the fallback chain.

/// Default fallback chain (tried in order after the primary fails).
pub const FALLBACK_CHAIN: &[&str] = &[
    "relay/claude-opus-4.8",
    "relay/claude-sonnet-4.5",
    "relay/claude-opus-4.5",
    "relay/gpt-5.1",
];

/// Classify an error as retriable (rate limit, overloaded, network).
pub fn is_retriable_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("rate limit")
        || lower.contains("429")
        || lower.contains("overloaded")
        || lower.contains("529")
        || lower.contains("503")
        || lower.contains("unavailable")
        || lower.contains("timeout")
        || lower.contains("connection")
        || lower.contains("quota")
}

/// Retry config.
pub struct RetryConfig {
    pub max_retries: usize,
    pub initial_delay_ms: u64,
    pub backoff_factor: f64,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_retries: 3,
            initial_delay_ms: 2000,
            backoff_factor: 2.0,
        }
    }
}
