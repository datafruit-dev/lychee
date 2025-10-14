use clap::{Parser, Subcommand};
use crossterm::{
    cursor,
    style::{Color, Print, ResetColor, SetForegroundColor},
    terminal::{self, ClearType},
    ExecutableCommand,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{stdout, Write as IoWrite};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::RwLock;
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Parser)]
#[command(name = "lychee")]
#[command(about = "Web-based Claude Code client", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the lychee client
    Up {
        /// Enable debug logging
        #[arg(long)]
        debug: bool,
    },
}

// Embedded animation frames
const CAT_FRAME_1: &str = include_str!("animation/cat1.txt");
const CAT_FRAME_2: &str = include_str!("animation/cat2.txt");
const CAT_FRAME_3: &str = include_str!("animation/cat3.txt");
const CAT_AWAKE_FRAME_1: &str = include_str!("animation/catawake1.txt");
const CAT_AWAKE_FRAME_2: &str = include_str!("animation/catawake2.txt");
const CAT_AWAKE_FRAME_3: &str = include_str!("animation/catawake3.txt");

// Message protocol
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
enum WsMessage {
    #[serde(rename = "client_connected")]
    ClientConnected {
        working_dir: String,
        repo_name: String,
        sessions: Vec<SessionInfo>,
    },
    #[serde(rename = "create_session")]
    CreateSession {
        repo_path: String,
    },
    #[serde(rename = "session_created")]
    SessionCreated {
        repo_path: String,
        session: SessionInfo,
    },
    #[serde(rename = "message")]
    Message {
        payload: String,
        repo_path: String,
        session_id: Option<String>,
    },
    #[serde(rename = "claude_stream")]
    ClaudeStream { payload: Value },
    #[serde(rename = "load_session")]
    LoadSession {
        session_id: String,
        repo_path: String,
    },
    #[serde(rename = "session_history")]
    SessionHistory {
        session_id: String,
        messages: Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionInfo {
    id: String,  // branch name like "session-abc123"
    created_at: String,
}

// Shared state for TUI
struct AppState {
    connected: bool,
    session_id: Option<String>,
    messages_processed: u64,
    start_time: Instant,
    animation_frame: u8,
    is_claude_running: bool,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Up { debug } => {
            run_client(debug).await;
        }
    }
}

async fn run_client(debug: bool) {
    let relay_url =
        std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3001/ws".to_string());
    let working_dir = std::env::var("LYCHEE_WORKING_DIR")
        .unwrap_or_else(|_| std::env::current_dir().unwrap().display().to_string());

    let state = Arc::new(RwLock::new(AppState {
        connected: false,
        session_id: None,
        messages_processed: 0,
        start_time: Instant::now(),
        animation_frame: 0,
        is_claude_running: false,
    }));

    // Clear screen and hide cursor
    if !debug {
        let mut stdout = stdout();
        stdout.execute(terminal::Clear(ClearType::All)).ok();
        stdout.execute(cursor::Hide).ok();
        stdout.execute(cursor::MoveTo(0, 0)).ok();
        stdout.flush().ok();
    }

    // Spawn TUI updater task
    if !debug {
        let state_clone = state.clone();
        tokio::spawn(async move {
            loop {
                render_tui(&state_clone).await;
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        });
    } else {
        println!("🚀 Lychee × Claude Code client starting (debug mode)...");
        println!("📡 Relay: {}", relay_url);
        println!("📁 Working directory: {}", working_dir);
    }

    // Connect to relay server
    let (ws_stream, _) = match connect_async(&relay_url).await {
        Ok(stream) => {
            state.write().await.connected = true;
            if debug {
                println!("✓ Connected to relay server\n");
            }
            stream
        }
        Err(e) => {
            if debug {
                eprintln!("✗ Failed to connect: {}", e);
            }
            return;
        }
    };

    let (mut write, mut read) = ws_stream.split();

    // Scan for existing worktrees
    let sessions = scan_worktrees(&working_dir, debug);
    let repo_name = std::path::Path::new(&working_dir)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();

    // Send registration message with sessions
    let register_msg = WsMessage::ClientConnected {
        working_dir: working_dir.clone(),
        repo_name,
        sessions,
    };
    let register_json = serde_json::to_string(&register_msg).unwrap();
    write
        .send(Message::Text(register_json))
        .await
        .expect("Failed to send registration");

    // Listen for messages
    while let Some(msg) = read.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                // Check for error messages from relay
                if let Ok(error_msg) = serde_json::from_str::<serde_json::Value>(&text) {
                    if error_msg.get("type").and_then(|t| t.as_str()) == Some("error") {
                        if let Some(message) = error_msg.get("message").and_then(|m| m.as_str()) {
                            if !debug {
                                // Show cursor before exiting
                                let mut stdout = stdout();
                                stdout.execute(cursor::Show).ok();
                                stdout.execute(terminal::Clear(ClearType::All)).ok();
                            }
                            eprintln!("Error: {}", message);
                            eprintln!("Another lychee client is already running in this directory.");
                            eprintln!("Please close it before starting a new one.");
                            std::process::exit(1);
                        }
                    }
                }

                if let Ok(ws_msg) = serde_json::from_str::<WsMessage>(&text) {
                    match ws_msg {
                        WsMessage::Message { payload, session_id, .. } => {
                            if debug {
                                println!("📥 User: {}", payload);
                            }

                            // Mark Claude as running
                            state.write().await.is_claude_running = true;

                            let state_clone = state.clone();
                            spawn_claude(
                                &payload,
                                session_id.as_deref(),
                                &mut write,
                                &working_dir,
                                debug,
                                state_clone,
                            )
                            .await;
                        }
                        WsMessage::CreateSession { repo_path } => {
                            if debug {
                                println!("📥 Create session in: {}", repo_path);
                            }

                            let session = create_worktree(&repo_path, debug).await;
                            if let Some(session) = session {
                                let response = WsMessage::SessionCreated {
                                    repo_path,
                                    session,
                                };
                                let _ = write
                                    .send(Message::Text(serde_json::to_string(&response).unwrap()))
                                    .await;
                            }
                        }
                        WsMessage::LoadSession { session_id, repo_path } => {
                            if debug {
                                println!("📥 Load session: {} from {}", session_id, repo_path);
                            }

                            let (messages, error) = load_session_history(&repo_path, &session_id, debug);

                            // Send error message if loading failed
                            if let Some(error_msg) = error {
                                let error_response = serde_json::json!({
                                    "type": "error",
                                    "message": error_msg
                                });
                                let _ = write
                                    .send(Message::Text(error_response.to_string()))
                                    .await;
                            }

                            let response = WsMessage::SessionHistory {
                                session_id,
                                messages,
                            };
                            let _ = write
                                .send(Message::Text(serde_json::to_string(&response).unwrap()))
                                .await;
                        }
                        _ => {}
                    }
                }
            }
            Ok(Message::Close(_)) => {
                if debug {
                    println!("✗ Connection closed by server");
                }
                state.write().await.connected = false;
                break;
            }
            Err(e) => {
                if debug {
                    eprintln!("✗ Error: {}", e);
                }
                state.write().await.connected = false;
                break;
            }
            _ => {}
        }
    }

    // Show cursor on exit
    if !debug {
        let mut stdout = stdout();
        stdout.execute(cursor::Show).ok();
    }
}

async fn render_tui(state: &Arc<RwLock<AppState>>) {
    // Cycle animation frame
    {
        let mut state_mut = state.write().await;
        state_mut.animation_frame = (state_mut.animation_frame + 1) % 3;
    }

    let state_read = state.read().await;
    let mut stdout = stdout();

    stdout.execute(cursor::MoveTo(0, 0)).ok();
    stdout.execute(terminal::Clear(ClearType::All)).ok();

    // Check terminal width
    let (term_width, _) = terminal::size().unwrap_or((80, 24));
    let show_animation = term_width > 82;

    // Cat ASCII art animation
    let cat_frame = if state_read.is_claude_running {
        // Awake animation when Claude is working
        match state_read.animation_frame {
            0 => CAT_AWAKE_FRAME_1,
            1 => CAT_AWAKE_FRAME_2,
            2 => CAT_AWAKE_FRAME_3,
            _ => CAT_AWAKE_FRAME_1,
        }
    } else {
        // Sleeping animation when idle
        match state_read.animation_frame {
            0 => CAT_FRAME_1,
            1 => CAT_FRAME_2,
            2 => CAT_FRAME_3,
            _ => CAT_FRAME_1,
        }
    };

    let cat_lines: Vec<String> = if show_animation {
        cat_frame.lines().map(|s| s.to_string()).collect()
    } else {
        vec![]
    };

    let left_col_width = 50;
    let right_col_start = if show_animation { left_col_width + 10 } else { 0 };

    // Prepare right column content
    let uptime = state_read.start_time.elapsed();
    let uptime_str = format_duration(uptime);

    let connection_status = if state_read.connected {
        "● Connected"
    } else {
        "● Disconnected"
    };

    let session_count = if state_read.session_id.is_some() { 1 } else { 0 };

    let right_lines = vec![
        "Lychee Client".to_string(),
        "━━━━━━━━━━━━━".to_string(),
        "".to_string(),
        connection_status.to_string(),
        "".to_string(),
        format!("Sessions: {}", session_count),
        format!("Messages: {}", state_read.messages_processed),
        format!("Uptime:   {}", uptime_str),
        "".to_string(),
        "Press Ctrl+C to exit".to_string(),
    ];

    // Render line by line (with 2 line offset from top)
    let line_offset = 2;
    let max_lines = cat_lines.len().max(right_lines.len());

    for i in 0..max_lines {
        stdout.execute(cursor::MoveTo(0, (i + line_offset) as u16)).ok();

        // Left column: cat animation
        if i < cat_lines.len() {
            stdout.execute(SetForegroundColor(Color::Rgb { r: 128, g: 128, b: 128 })).ok();
            stdout.execute(Print(&cat_lines[i])).ok();
            stdout.execute(ResetColor).ok();
        }

        // Right column: info
        if i < right_lines.len() {
            stdout.execute(cursor::MoveTo(right_col_start, (i + line_offset) as u16)).ok();

            // Apply colors for specific lines
            if i == 0 {
                // Title
                stdout.execute(SetForegroundColor(Color::Cyan)).ok();
                stdout.execute(Print(&right_lines[i])).ok();
                stdout.execute(ResetColor).ok();
            } else if i == 1 {
                // Separator
                stdout.execute(SetForegroundColor(Color::Cyan)).ok();
                stdout.execute(Print(&right_lines[i])).ok();
                stdout.execute(ResetColor).ok();
            } else if i == 3 {
                // Connection status
                if state_read.connected {
                    stdout.execute(SetForegroundColor(Color::Green)).ok();
                } else {
                    stdout.execute(SetForegroundColor(Color::Red)).ok();
                }
                stdout.execute(Print(&right_lines[i])).ok();
                stdout.execute(ResetColor).ok();
            } else if i == 9 {
                // Exit message
                stdout.execute(SetForegroundColor(Color::DarkGrey)).ok();
                stdout.execute(Print(&right_lines[i])).ok();
                stdout.execute(ResetColor).ok();
            } else {
                stdout.execute(Print(&right_lines[i])).ok();
            }
        }
    }

    stdout.flush().ok();
}

fn format_duration(duration: Duration) -> String {
    let secs = duration.as_secs();
    let hours = secs / 3600;
    let minutes = (secs % 3600) / 60;
    let seconds = secs % 60;

    if hours > 0 {
        format!("{}h {}m {}s", hours, minutes, seconds)
    } else if minutes > 0 {
        format!("{}m {}s", minutes, seconds)
    } else {
        format!("{}s", seconds)
    }
}

async fn spawn_claude(
    prompt: &str,
    session_id: Option<&str>,
    write: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        Message,
    >,
    working_dir: &str,
    debug: bool,
    state: Arc<RwLock<AppState>>,
) {
    // Build claude command
    let mut cmd = Command::new("claude");
    cmd.arg("-p")
        .arg(prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--dangerously-skip-permissions");

    // Determine actual working directory
    let actual_dir = if let Some(sid) = session_id {
        // Use worktree directory if session specified
        let worktree_path = format!("{}/.lychee/{}", working_dir, sid);
        if std::path::Path::new(&worktree_path).exists() {
            if debug {
                println!("🔄 Working in session: {} ({})", sid, worktree_path);
            }
            worktree_path
        } else {
            if debug {
                println!("⚠️  Worktree not found for {}, using main dir", sid);
            }
            working_dir.to_string()
        }
    } else {
        if debug {
            println!("🆕 Starting new session in main directory");
        }
        working_dir.to_string()
    };

    cmd.current_dir(&actual_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // Spawn process
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            if debug {
                eprintln!("✗ Failed to spawn claude: {}", e);
            }
            state.write().await.is_claude_running = false;
            let error_msg = WsMessage::ClaudeStream {
                payload: serde_json::json!({
                    "type": "error",
                    "message": format!("Failed to spawn claude: {}. Make sure Claude Code is installed.", e)
                }),
            };
            let _ = write
                .send(Message::Text(serde_json::to_string(&error_msg).unwrap()))
                .await;
            return;
        }
    };

    let stdout = child.stdout.take().expect("Failed to capture stdout");
    let mut reader = BufReader::new(stdout).lines();

    // Stream each line as JSON
    while let Ok(Some(line)) = reader.next_line().await {
        if line.trim().is_empty() {
            continue;
        }

        // Parse line as JSON
        match serde_json::from_str::<Value>(&line) {
            Ok(json_value) => {
                // Debug logging
                if debug {
                    println!("\n┌─ Claude Stream ─────────────────────");
                    if let Ok(pretty) = serde_json::to_string_pretty(&json_value) {
                        println!("{}", pretty);
                    }
                    println!("└─────────────────────────────────────\n");
                }

                // Update state
                if let Some(stream_type) = json_value.get("type").and_then(|v| v.as_str()) {
                    if stream_type == "result" {
                        if let Some(claude_sid) = json_value.get("session_id").and_then(|v| v.as_str()) {
                            state.write().await.session_id = Some(claude_sid.to_string());

                            // Store the Claude session ID mapping if we have a Lychee session
                            if let Some(lychee_sid) = session_id {
                                let mapping_file = format!("{}/.lychee/{}/.claude_session_id", working_dir, lychee_sid);
                                if let Err(e) = std::fs::write(&mapping_file, claude_sid) {
                                    if debug {
                                        eprintln!("Failed to save Claude session ID mapping: {}", e);
                                    }
                                }
                            }
                        }
                        state.write().await.messages_processed += 1;
                        state.write().await.is_claude_running = false;
                    }
                }

                let stream_msg = WsMessage::ClaudeStream {
                    payload: json_value,
                };
                let msg_json = serde_json::to_string(&stream_msg).unwrap();

                if write.send(Message::Text(msg_json)).await.is_err() {
                    if debug {
                        eprintln!("✗ Failed to send stream message");
                    }
                    return;
                }
            }
            Err(e) => {
                if debug {
                    eprintln!("⚠️  Invalid JSON from claude: {} - {}", e, line);
                }
            }
        }
    }

    // Check for errors
    let status = child.wait().await.expect("Failed to wait for claude");

    if !status.success() {
        if debug {
            eprintln!("✗ Claude exited with status: {}", status);
        }

        state.write().await.is_claude_running = false;

        // Try to capture stderr
        if let Some(stderr) = child.stderr {
            let mut stderr_reader = BufReader::new(stderr).lines();
            if let Ok(Some(error_line)) = stderr_reader.next_line().await {
                let error_msg = WsMessage::ClaudeStream {
                    payload: serde_json::json!({
                        "type": "error",
                        "message": error_line
                    }),
                };
                let _ = write
                    .send(Message::Text(serde_json::to_string(&error_msg).unwrap()))
                    .await;
            }
        }
    } else if debug {
        println!("✓ Claude completed successfully");
    }
}

fn load_session_history(repo_path: &str, session_id: &str, debug: bool) -> (Value, Option<String>) {
    // First, read the Claude session ID mapping
    let mapping_file = format!("{}/.lychee/{}/.claude_session_id", repo_path, session_id);
    let claude_session_id = match std::fs::read_to_string(&mapping_file) {
        Ok(id) => id.trim().to_string(),
        Err(_) => {
            if debug {
                println!("No Claude session ID mapping found for {}", session_id);
            }
            // This is expected for new sessions that haven't had any messages yet
            return (serde_json::json!([]), None);
        }
    };

    // Claude saves sessions based on the worktree path, not the main repo path
    // Convert worktree path to Claude's format: /path/to/repo/.lychee/session-abc -> -path-to-repo--lychee-session-abc
    let worktree_path = format!("{}/.lychee/{}", repo_path, session_id);
    // Replace / with - and also handle the dot in .lychee
    let claude_dir = worktree_path.replace("/", "-").replace("-.lychee", "--lychee");

    // Build file path using the actual Claude session ID
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let file_path = format!("{}/.claude/projects/{}/{}.jsonl", home, claude_dir, claude_session_id);

    if debug {
        println!("Reading session file: {} (Claude ID: {})", file_path, claude_session_id);
        println!("Using Claude project dir: {}", claude_dir);
    }

    // Read file
    let content = match std::fs::read_to_string(&file_path) {
        Ok(c) => c,
        Err(e) => {
            if debug {
                eprintln!("Failed to read session file: {}", e);
            }
            // Check if it's just that Claude hasn't saved yet
            if e.kind() == std::io::ErrorKind::NotFound {
                // This is normal right after the first message - Claude saves asynchronously
                return (serde_json::json!([]), None); // Don't show error for this normal case
            }
            return (serde_json::json!([]), Some(format!("Failed to load session history: {}", e)));
        }
    };

    let mut messages = Vec::new();

    // Parse each line
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }

        let parsed: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Get message type
        let msg_type = parsed.get("type").and_then(|t| t.as_str());

        match msg_type {
            Some("user") => {
                // Extract user message
                if let Some(message) = parsed.get("message") {
                    if let Some(content) = message.get("content") {
                        let text = if content.is_string() {
                            content.as_str().unwrap_or("").to_string()
                        } else {
                            // Skip tool_result messages
                            continue;
                        };

                        messages.push(serde_json::json!({
                            "role": "user",
                            "content": text
                        }));
                    }
                }
            }
            Some("assistant") => {
                // Extract assistant message text only
                if let Some(message) = parsed.get("message") {
                    if let Some(content_blocks) = message.get("content").and_then(|c| c.as_array()) {
                        let mut text_parts = Vec::new();

                        for block in content_blocks {
                            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                    text_parts.push(text);
                                }
                            }
                        }

                        if !text_parts.is_empty() {
                            messages.push(serde_json::json!({
                                "role": "assistant",
                                "content": text_parts.join("")
                            }));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    (serde_json::json!(messages), None)
}

fn scan_worktrees(working_dir: &str, debug: bool) -> Vec<SessionInfo> {
    let lychee_dir = format!("{}/.lychee", working_dir);

    if debug {
        println!("Scanning worktrees in: {}", lychee_dir);
    }

    let mut sessions = Vec::new();

    // Check if .lychee directory exists
    if !std::path::Path::new(&lychee_dir).exists() {
        if debug {
            println!("No .lychee directory found");
        }
        return sessions;
    }

    // List subdirectories in .lychee
    if let Ok(entries) = std::fs::read_dir(&lychee_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Some(name) = entry.file_name().to_str() {
                    // Get creation time or use current time
                    let created_at = entry.metadata()
                        .ok()
                        .and_then(|m| m.created().ok())
                        .and_then(|t| {
                            let secs = t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
                            Some(chrono::DateTime::from_timestamp(secs as i64, 0)?)
                        })
                        .unwrap_or_else(chrono::Utc::now)
                        .to_rfc3339();

                    sessions.push(SessionInfo {
                        id: name.to_string(),
                        created_at,
                    });

                    if debug {
                        println!("Found worktree: {}", name);
                    }
                }
            }
        }
    }

    sessions
}

async fn create_worktree(working_dir: &str, debug: bool) -> Option<SessionInfo> {
    use tokio::process::Command;

    // Generate session ID
    let session_id = format!("session-{}", uuid::Uuid::new_v4().to_string().chars().take(8).collect::<String>());
    let branch_name = format!("lychee/{}", session_id);
    let worktree_path = format!("{}/.lychee/{}", working_dir, session_id);

    if debug {
        println!("Creating worktree: {} with branch {}", worktree_path, branch_name);
    }

    // Create .lychee directory if it doesn't exist
    let lychee_dir = format!("{}/.lychee", working_dir);
    if !std::path::Path::new(&lychee_dir).exists() {
        if let Err(e) = std::fs::create_dir(&lychee_dir) {
            if debug {
                eprintln!("Failed to create .lychee directory: {}", e);
            }
            return None;
        }
    }

    // Create worktree
    let output = Command::new("git")
        .args(&["worktree", "add", &worktree_path, "-b", &branch_name])
        .current_dir(working_dir)
        .output()
        .await;

    match output {
        Ok(output) if output.status.success() => {
            if debug {
                println!("✓ Created worktree: {}", session_id);
            }
            Some(SessionInfo {
                id: session_id,
                created_at: chrono::Utc::now().to_rfc3339(),
            })
        }
        Ok(output) => {
            if debug {
                eprintln!("Failed to create worktree: {}", String::from_utf8_lossy(&output.stderr));
            }
            None
        }
        Err(e) => {
            if debug {
                eprintln!("Failed to run git command: {}", e);
            }
            None
        }
    }
}
