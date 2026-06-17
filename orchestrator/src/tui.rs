//! TUI Dashboard: shows Lead phase, worker status, and streaming output.
//!
//! Layout:
//! ┌─────────────────────────────────────────┐
//! │ TOKYO — phase: EXECUTE  model: relay/.. │  (header)
//! ├────────────────────┬────────────────────┤
//! │ Workers            │ Lead Output        │
//! │ ● skeptic: ready   │ (streaming text)   │
//! │ ● validator: busy  │                    │
//! │ ● researcher: done │                    │
//! │ ● architect: ready │                    │
//! │ ● creative: ready  │                    │
//! ├────────────────────┴────────────────────┤
//! │ > input area                            │  (footer)
//! └─────────────────────────────────────────┘

use std::io::{self, Stdout};
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    ExecutableCommand,
};
use ratatui::{
    prelude::*,
    widgets::{Block, Borders, List, ListItem, Paragraph, Wrap},
};

/// Worker display state.
#[derive(Clone)]
pub struct WorkerState {
    pub id: String,
    pub status: WorkerDisplayStatus,
}

#[derive(Clone, PartialEq)]
pub enum WorkerDisplayStatus {
    Spawning,
    Ready,
    Thinking,
    Done,
    Error,
}

impl WorkerDisplayStatus {
    fn symbol(&self) -> &str {
        match self {
            Self::Spawning => "◌",
            Self::Ready => "●",
            Self::Thinking => "◉",
            Self::Done => "✓",
            Self::Error => "✗",
        }
    }

    fn color(&self) -> Color {
        match self {
            Self::Spawning => Color::DarkGray,
            Self::Ready => Color::Green,
            Self::Thinking => Color::Yellow,
            Self::Done => Color::Cyan,
            Self::Error => Color::Red,
        }
    }
}

/// Full dashboard state.
pub struct DashboardState {
    pub phase: String,
    pub model: String,
    pub workers: Vec<WorkerState>,
    pub output_lines: Vec<String>,
    pub input: String,
    pub should_quit: bool,
}

impl DashboardState {
    pub fn new(model: &str) -> Self {
        Self {
            phase: "IDLE".to_string(),
            model: model.to_string(),
            workers: Vec::new(),
            output_lines: Vec::new(),
            input: String::new(),
            should_quit: false,
        }
    }

    pub fn push_output(&mut self, text: &str) {
        for line in text.lines() {
            self.output_lines.push(line.to_string());
        }
        // Keep last 500 lines
        if self.output_lines.len() > 500 {
            self.output_lines.drain(0..self.output_lines.len() - 500);
        }
    }

    pub fn set_worker_status(&mut self, id: &str, status: WorkerDisplayStatus) {
        if let Some(w) = self.workers.iter_mut().find(|w| w.id == id) {
            w.status = status;
        } else {
            self.workers.push(WorkerState { id: id.to_string(), status });
        }
    }
}

pub struct Dashboard {
    terminal: Terminal<CrosstermBackend<Stdout>>,
}

impl Dashboard {
    pub fn new() -> anyhow::Result<Self> {
        enable_raw_mode()?;
        io::stdout().execute(EnterAlternateScreen)?;
        let backend = CrosstermBackend::new(io::stdout());
        let terminal = Terminal::new(backend)?;
        Ok(Self { terminal })
    }

    pub fn draw(&mut self, state: &DashboardState) -> anyhow::Result<()> {
        self.terminal.draw(|frame| {
            let area = frame.area();

            // Layout: header (3) + body + footer (3)
            let vertical = Layout::vertical([
                Constraint::Length(3),
                Constraint::Min(5),
                Constraint::Length(3),
            ]).split(area);

            // Header
            let header_text = format!(
                " TOKYO │ phase: {} │ model: {} │ workers: {}",
                state.phase, state.model, state.workers.len()
            );
            let header = Paragraph::new(header_text)
                .block(Block::default().borders(Borders::ALL).title(" tokyo-orchestrator "));
            frame.render_widget(header, vertical[0]);

            // Body: workers (left) + output (right)
            let body = Layout::horizontal([
                Constraint::Length(24),
                Constraint::Min(40),
            ]).split(vertical[1]);

            // Worker list
            let items: Vec<ListItem> = state.workers.iter().map(|w| {
                let line = Line::from(vec![
                    Span::styled(
                        format!("{} ", w.status.symbol()),
                        Style::default().fg(w.status.color()),
                    ),
                    Span::raw(&w.id),
                ]);
                ListItem::new(line)
            }).collect();
            let worker_list = List::new(items)
                .block(Block::default().borders(Borders::ALL).title(" Workers "));
            frame.render_widget(worker_list, body[0]);

            // Output area (scrolled to bottom)
            let visible_height = body[1].height.saturating_sub(2) as usize;
            let start = state.output_lines.len().saturating_sub(visible_height);
            let visible: String = state.output_lines[start..].join("\n");
            let output = Paragraph::new(visible)
                .block(Block::default().borders(Borders::ALL).title(" Output "))
                .wrap(Wrap { trim: false });
            frame.render_widget(output, body[1]);

            // Footer (input)
            let footer = Paragraph::new(format!(" > {}_", state.input))
                .block(Block::default().borders(Borders::ALL).title(" Input (Enter to send, Esc to quit) "));
            frame.render_widget(footer, vertical[2]);
        })?;
        Ok(())
    }

    /// Poll for keyboard input (non-blocking, 50ms timeout).
    pub fn poll_input(&self, state: &mut DashboardState) -> anyhow::Result<Option<String>> {
        if event::poll(std::time::Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                if key.kind != KeyEventKind::Press {
                    return Ok(None);
                }
                match key.code {
                    KeyCode::Esc => {
                        state.should_quit = true;
                    }
                    KeyCode::Enter => {
                        if !state.input.is_empty() {
                            let msg = state.input.clone();
                            state.input.clear();
                            return Ok(Some(msg));
                        }
                    }
                    KeyCode::Backspace => {
                        state.input.pop();
                    }
                    KeyCode::Char(c) => {
                        state.input.push(c);
                    }
                    _ => {}
                }
            }
        }
        Ok(None)
    }

    pub fn shutdown(self) -> anyhow::Result<()> {
        disable_raw_mode()?;
        io::stdout().execute(LeaveAlternateScreen)?;
        Ok(())
    }
}
