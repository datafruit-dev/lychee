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
use std::collections::HashMap;
use std::io::{stdout, Write as IoWrite};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};
use uuid::Uuid;

#[derive(Parser)]
#[command(name = "lychee")]
#[command(about = "Browser-based Claude Code client", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the client and connect to relay
    Up {
        #[arg(short, long, help = "Enable debug output")]
        debug: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
enum Message {
    // Registration
    #[serde(rename = "register_client")]
    RegisterClient { repo_path: String, repo_name: String },

    // Browser -> Client requests
    #[serde(rename = "list_sessions")]
    ListSessions { repo_path: String },
    #[serde(rename = "create_session")]
    CreateSession { repo_path: String },
    #[serde(rename = "load_session")]
    LoadSession { repo_path: String, lychee_id: String },
    #[serde(rename = "send_message")]
    SendMessage {
        repo_path: String,
        lychee_id: String,
        content: String,
        model: String,
    },

    // Client -> Browser responses
    #[serde(rename = "sessions_list")]
    SessionsList {
        repo_path: String,
        sessions: Vec<SessionInfo>,
    },
    #[serde(rename = "session_created")]
    SessionCreated {
        repo_path: String,
        lychee_id: String,
    },
    #[serde(rename = "session_history")]
    SessionHistory {
        repo_path: String,
        lychee_id: String,
        messages: Value,
    },
    #[serde(rename = "claude_stream")]
    ClaudeStream {
        repo_path: String,
        lychee_id: String,
        data: Value,
    },
    #[serde(rename = "error")]
    Error {
        repo_path: Option<String>,
        message: String,
    },
    #[serde(rename = "client_count")]
    ClientCount {
        count: usize,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionInfo {
    lychee_id: String,
    claude_session_id: Option<String>,
    created_at: String,
    last_active: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SessionInfoFile {
    #[serde(flatten)]
    sessions: HashMap<String, SessionMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionMetadata {
    claude_session_id: Option<String>,
    created_at: String,
    last_active: String,
}

#[derive(Clone)]
struct AppState {
    active_processes: Arc<RwLock<HashMap<String, Child>>>,
    start_time: Instant,
    animation_frame: Arc<RwLock<u8>>,
    client_count: Arc<RwLock<usize>>,
    debug: bool,
}

// Cat animation frames
const CAT_SLEEP_FRAME_1: &str = r#"
                       ▄▄          ▄▄
        z             █ ░█        █ ░█
   Z          z      █    ▀▀▀▀▀▀▀▀    ▀▄▄▄▄▄▄▄▄
                     █                        ▒█▄▄
                     █ ▄  ▄     ▄  ▄             ▒█
                     █  ▀▀       ▀▀              ▒█
    No agents      ▀▀█       ▄       ▀▀           ▒█
    currently       ▀█      ▀ ▀      ▀▀      ▄▄▄▄  ▒█
    running          █      ░░░             █      ▒█
                      █    ░░░░░           █        █
                       ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
"#;

const CAT_SLEEP_FRAME_2: &str = r#"

        Z              ▄▄          ▄▄
   z          z       █ ░█        █ ░█
                     █    ▀▀▀▀▀▀▀▀    ▀▄▄▄▄▄▄▄▄
                     █                        ▒█▄▄
                     █ ▄  ▄     ▄  ▄             ▒█
    No agents        █  ▀▀       ▀▀              ▒█
    currently      ▀▀█       ▄       ▀▀           ▒█
    running         ▀█      ▀ ▀      ▀▀     ▄▀▀▀▀  ▒█
                     █▄     ░░░            ▄▀      ▒█
                       ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
"#;

const CAT_SLEEP_FRAME_3: &str = r#"

        z              ▄▄          ▄▄
   z          Z       █ ░█        █ ░█
                     █    ▀▀▀▀▀▀▀▀    ▀▄▄▄▄▄▄▄▄
                     █                        ▒█▄▄
                     █ ▄  ▄     ▄  ▄             ▒█
    No agents        █  ▀▀       ▀▀              ▒█
    currently      ▀▀█       ▄       ▀▀           ▒█
    running         ▀█      ▀ ▀      ▀▀     ▄▀▀▀▀  ▒█
                     █▄     ░░░            ▄▀      ▒█
                       ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
"#;

const CAT_AWAKE_FRAME_1: &str = r#"

                       ▄▄          ▄▄
                      █ ░█        █ ░█
                     █    ▀▀▀▀▀▀▀▀    ▀▄▄▄▄▄▄▄▄
                     █                        ▒█▄▄
                     █   ▄▄       ▄▄             ▒█
    Claude is        █  ▀  ▀     ▀  ▀            ▒█
     working       ▀▀█        ▄       ▀▀          ▒█
       •..          ▀█       ▀ ▀      ▀▀     ▄▀▀▀▀ ▒█
                     █▄     ░░░            ▄▀      ▒█
                       ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
"#;

const CAT_AWAKE_FRAME_2: &str = r#"

                       ▄▄          ▄▄
                      █ ░█        █ ░█
                     █    ▀▀▀▀▀▀▀▀    ▀▄▄▄▄▄▄▄▄
                     █                        ▒█▄▄
                     █   ▄▄       ▄▄             ▒█
    Claude is        █  ▀  ▀     ▀  ▀            ▒█
     working       ▀▀█        ▄       ▀▀          ▒█
       .•.          ▀█       ▀ ▀      ▀▀     ▄▀▀▀▀ ▒█
                     █▄     ░░░            ▄▀      ▒█
                       ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
"#;

const CAT_AWAKE_FRAME_3: &str = r#"

                       ▄▄          ▄▄
                      █ ░█        █ ░█
                     █    ▀▀▀▀▀▀▀▀    ▀▄▄▄▄▄▄▄▄
                     █                        ▒█▄▄
                     █   ▄▄       ▄▄             ▒█
    Claude is        █  ▀  ▀     ▀  ▀            ▒█
     working       ▀▀█        ▄       ▀▀          ▒█
       ..•          ▀█       ▀ ▀      ▀▀     ▄▀▀▀▀ ▒█
                     █▄     ░░░            ▄▀      ▒█
                       ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
"#;

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
    let relay_url = std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3001/ws".to_string());
    let repo_path = std::env::current_dir().unwrap().display().to_string();
    let repo_name = std::env::current_dir()
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();

    let state = Arc::new(AppState {
        active_processes: Arc::new(RwLock::new(HashMap::new())),
        start_time: Instant::now(),
        animation_frame: Arc::new(RwLock::new(0)),
        client_count: Arc::new(RwLock::new(1)),
        debug,
    });

    // Clear screen and hide cursor for TUI
    if !debug {
        let mut stdout = stdout();
        stdout.execute(terminal::Clear(ClearType::All)).ok();
        stdout.execute(cursor::Hide).ok();
        stdout.execute(cursor::MoveTo(0, 0)).ok();
    }

    // Connect to relay
    let (ws_stream, _) = match connect_async(&relay_url).await {
        Ok(conn) => conn,
        Err(e) => {
            eprintln!("❌ Failed to connect to relay: {}", e);
            return;
        }
    };

    if debug {
        println!("✅ Connected to relay at {}", relay_url);
    }

    let (mut write, mut read) = ws_stream.split();

    // Register as client
    let register_msg = Message::RegisterClient {
        repo_path: repo_path.clone(),
        repo_name: repo_name.clone(),
    };
    write
        .send(WsMessage::Text(serde_json::to_string(&register_msg).unwrap()))
        .await
        .unwrap();

    // Create channel for outgoing messages
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // Spawn TUI animation task
    let state_clone = state.clone();
    let tui_task = if !debug {
        Some(tokio::spawn(async move {
            loop {
                render_tui(&state_clone).await;
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }))
    } else {
        None
    };

    // Spawn task to send messages
    let mut write_clone = write;
    let _send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let _ = write_clone.send(WsMessage::Text(msg)).await;
        }
    });

    // Handle incoming messages
    while let Some(Ok(WsMessage::Text(text))) = read.next().await {
        if let Ok(msg) = serde_json::from_str::<Message>(&text) {
            handle_message(msg, tx.clone(), &repo_path, &state).await;
        }
    }

    // Cleanup
    if let Some(tui) = tui_task {
        tui.abort();
    }

    if !debug {
        let mut stdout = stdout();
        stdout.execute(cursor::Show).ok();
        stdout.execute(terminal::Clear(ClearType::All)).ok();
    }

    println!("❌ Disconnected from relay");
}

async fn handle_message(
    msg: Message,
    tx: mpsc::UnboundedSender<String>,
    repo_path: &str,
    state: &AppState,
) {
    match msg {
        Message::ListSessions { .. } => {
            let sessions = list_sessions(repo_path).await;
            let response = Message::SessionsList {
                repo_path: repo_path.to_string(),
                sessions,
            };
            let _ = tx.send(serde_json::to_string(&response).unwrap());
        }

        Message::CreateSession { .. } => {
            if let Some(lychee_id) = create_session(repo_path, state.debug).await {
                let response = Message::SessionCreated {
                    repo_path: repo_path.to_string(),
                    lychee_id,
                };
                let _ = tx.send(serde_json::to_string(&response).unwrap());
            }
        }

        Message::LoadSession { lychee_id, .. } => {
            let messages = load_session_history(repo_path, &lychee_id, state.debug).await;
            let response = Message::SessionHistory {
                repo_path: repo_path.to_string(),
                lychee_id,
                messages,
            };
            let _ = tx.send(serde_json::to_string(&response).unwrap());
        }

        Message::SendMessage {
            lychee_id, content, model, ..
        } => {
            // Check if already running
            {
                let processes = state.active_processes.read().await;
                if processes.contains_key(&lychee_id) {
                    let error = Message::Error {
                        repo_path: Some(repo_path.to_string()),
                        message: format!("Claude already running for session {}", lychee_id),
                    };
                    let _ = tx.send(serde_json::to_string(&error).unwrap());
                    return;
                }
            }

            // Update last_active immediately when message is sent
            let lychee_dir = PathBuf::from(repo_path).join(".lychee");
            let session_info_path = lychee_dir.join(".session-info.json");
            if let Some(mut info) = std::fs::read_to_string(&session_info_path)
                .ok()
                .and_then(|s| serde_json::from_str::<SessionInfoFile>(&s).ok())
            {
                if let Some(metadata) = info.sessions.get_mut(&lychee_id) {
                    metadata.last_active = chrono::Utc::now().to_rfc3339();
                    let _ = std::fs::write(
                        &session_info_path,
                        serde_json::to_string_pretty(&info).unwrap(),
                    );

                    // Send updated sessions list to frontend immediately
                    let sessions = list_sessions(repo_path).await;
                    let update_msg = Message::SessionsList {
                        repo_path: repo_path.to_string(),
                        sessions,
                    };
                    let _ = tx.send(serde_json::to_string(&update_msg).unwrap());
                }
            }

            // Spawn Claude in background task
            let tx_clone = tx.clone();
            let repo_path_clone = repo_path.to_string();
            let lychee_id_clone = lychee_id.clone();
            let content_clone = content.clone();
            let model_clone = model.clone();
            let state_clone = state.clone();

            tokio::spawn(async move {
                spawn_claude(
                    tx_clone,
                    &repo_path_clone,
                    &lychee_id_clone,
                    &content_clone,
                    &model_clone,
                    &state_clone,
                )
                .await;
            });
        }

        Message::ClientCount { count } => {
            let mut client_count = state.client_count.write().await;
            *client_count = count;
        }

        _ => {}
    }
}

async fn list_sessions(repo_path: &str) -> Vec<SessionInfo> {
    let mut sessions = Vec::new();
    let lychee_dir = PathBuf::from(repo_path).join(".lychee");

    // Load session info file
    let session_info_path = lychee_dir.join(".session-info.json");
    let session_metadata = if session_info_path.exists() {
        match std::fs::read_to_string(&session_info_path) {
            Ok(content) => serde_json::from_str::<SessionInfoFile>(&content).unwrap_or_default(),
            Err(_) => SessionInfoFile { sessions: HashMap::new() },
        }
    } else {
        SessionInfoFile { sessions: HashMap::new() }
    };

    // Scan for session directories
    if let Ok(entries) = std::fs::read_dir(&lychee_dir) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with("session-") {
                        let metadata = session_metadata.sessions.get(name);
                        sessions.push(SessionInfo {
                            lychee_id: name.to_string(),
                            claude_session_id: metadata.and_then(|m| m.claude_session_id.clone()),
                            created_at: metadata
                                .map(|m| m.created_at.clone())
                                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
                            last_active: metadata
                                .map(|m| m.last_active.clone())
                                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
                        });
                    }
                }
            }
        }
    }

    // Sort by last_active descending
    sessions.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    sessions
}

async fn create_session(repo_path: &str, debug: bool) -> Option<String> {
    let lychee_id = format!("session-{}", Uuid::new_v4().to_string().split('-').next().unwrap());
    let lychee_dir = PathBuf::from(repo_path).join(".lychee");
    let session_dir = lychee_dir.join(&lychee_id);

    // Create .lychee directory if it doesn't exist
    if !lychee_dir.exists() {
        std::fs::create_dir(&lychee_dir).ok()?;

        // Add .lychee to git exclude
        let git_exclude_path = PathBuf::from(repo_path).join(".git").join("info").join("exclude");
        if let Ok(mut exclude_content) = std::fs::read_to_string(&git_exclude_path) {
            if !exclude_content.contains("/.lychee") {
                exclude_content.push_str("\n/.lychee\n");
                let _ = std::fs::write(&git_exclude_path, exclude_content);
            }
        }
    }

    // Create git worktree
    let output = Command::new("git")
        .arg("worktree")
        .arg("add")
        .arg(&session_dir)
        .current_dir(repo_path)
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        if debug {
            eprintln!("❌ Failed to create worktree: {}", String::from_utf8_lossy(&output.stderr));
        }
        return None;
    }

    // Update session info file
    let session_info_path = lychee_dir.join(".session-info.json");
    let mut session_info = if session_info_path.exists() {
        std::fs::read_to_string(&session_info_path)
            .ok()
            .and_then(|s| serde_json::from_str::<SessionInfoFile>(&s).ok())
            .unwrap_or_default()
    } else {
        SessionInfoFile { sessions: HashMap::new() }
    };

    session_info.sessions.insert(
        lychee_id.clone(),
        SessionMetadata {
            claude_session_id: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            last_active: chrono::Utc::now().to_rfc3339(),
        },
    );

    std::fs::write(
        session_info_path,
        serde_json::to_string_pretty(&session_info).unwrap(),
    ).ok()?;

    if debug {
        println!("✅ Created session: {}", lychee_id);
    }

    Some(lychee_id)
}

async fn load_session_history(repo_path: &str, lychee_id: &str, debug: bool) -> Value {
    let lychee_dir = PathBuf::from(repo_path).join(".lychee");
    let session_info_path = lychee_dir.join(".session-info.json");

    // Get Claude session ID from mapping
    let claude_session_id = if session_info_path.exists() {
        std::fs::read_to_string(&session_info_path)
            .ok()
            .and_then(|s| serde_json::from_str::<SessionInfoFile>(&s).ok())
            .and_then(|info| info.sessions.get(lychee_id).cloned())
            .and_then(|metadata| metadata.claude_session_id)
    } else {
        None
    };

    if let Some(claude_id) = claude_session_id {
        // Claude stores conversations in .claude/projects/ with path-based naming
        let home_dir = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());

        // Try to find the session file by searching for it
        // Claude's path sanitization can be complex, so let's search for the file
        let projects_dir = PathBuf::from(&home_dir).join(".claude").join("projects");
        let session_filename = format!("{}.jsonl", claude_id);

        // Search for the session file in any project directory
        let mut session_file = None;

        if let Ok(entries) = std::fs::read_dir(&projects_dir) {
            for entry in entries.filter_map(Result::ok) {
                let dir_path = entry.path();
                if dir_path.is_dir() {
                    let possible_file = dir_path.join(&session_filename);
                    if possible_file.exists() {
                        // Check if this is related to our lychee session
                        let dir_name = dir_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                        if dir_name.contains(&lychee_id) {
                            session_file = Some(possible_file);
                            break;
                        }
                    }
                }
            }
        }

        // If we couldn't find it by searching, try the expected path
        if session_file.is_none() {
            // Claude sanitizes paths by replacing / with - and handling . specially
            let session_dir_path = PathBuf::from(repo_path).join(".lychee").join(lychee_id);
            let path_str = session_dir_path.display().to_string();

            // Replace slashes with dashes, and handle the .lychee part
            let sanitized = path_str
                .trim_start_matches('/')
                .replace("/.", "/-.")  // Preserve dots after slashes
                .replace('/', "-");
            let sanitized_path = format!("-{}", sanitized);

            let expected_file = projects_dir.join(&sanitized_path).join(&session_filename);
            if expected_file.exists() {
                session_file = Some(expected_file);
            }
        }

        if let Some(file_path) = session_file {
            if debug {
                println!("Looking for Claude history at: {:?}", file_path);
            }

            // Read JSONL file - each line is a JSON object
            if let Ok(content) = std::fs::read_to_string(&file_path) {
                let mut messages = Vec::new();

                // Parse each line as a separate JSON message
                for line in content.lines() {
                    if !line.trim().is_empty() {
                        if let Ok(entry) = serde_json::from_str::<Value>(line) {
                            // Check if this is a user or assistant message
                            if let Some(msg_type) = entry.get("type").and_then(|t| t.as_str()) {
                                if msg_type == "user" || msg_type == "assistant" {
                                    // Extract the nested message object and pass as-is
                                    if let Some(message) = entry.get("message") {
                                        messages.push(message.clone());
                                    }
                                }
                            }
                        }
                    }
                }

                if debug {
                    println!("📖 Loaded {} messages for session {}", messages.len(), lychee_id);
                    println!("   Messages: {:?}", messages);
                }

                return serde_json::json!(messages);
            }
        } else if debug {
            println!("⚠️  No Claude session file found for session {}", lychee_id);
        }
    }

    // Return empty array if no history
    serde_json::json!([])
}

async fn spawn_claude(
    tx: mpsc::UnboundedSender<String>,
    repo_path: &str,
    lychee_id: &str,
    content: &str,
    model: &str,
    state: &AppState,
) {
    let lychee_dir = PathBuf::from(repo_path).join(".lychee");
    let session_dir = lychee_dir.join(lychee_id);
    let session_info_path = lychee_dir.join(".session-info.json");

    // Get Claude session ID if it exists
    let claude_session_id = if session_info_path.exists() {
        std::fs::read_to_string(&session_info_path)
            .ok()
            .and_then(|s| serde_json::from_str::<SessionInfoFile>(&s).ok())
            .and_then(|info| info.sessions.get(lychee_id).cloned())
            .and_then(|metadata| metadata.claude_session_id)
    } else {
        None
    };

    // Build command
    let mut cmd = Command::new("claude");
    cmd.current_dir(&session_dir);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // If we have a Claude session, use --resume with the session ID
    // --continue won't work because each worktree is a different directory
    if let Some(ref claude_id) = claude_session_id {
        cmd.arg("--resume");
        cmd.arg(claude_id);
    }

    cmd.arg("-p");
    cmd.arg(content);
    cmd.arg("--model");
    cmd.arg(model);
    cmd.arg("--output-format");
    cmd.arg("stream-json");

    if state.debug {
        println!("🚀 Spawning Claude for session {}", lychee_id);
        println!("   Model: {}", model);
        if let Some(ref id) = claude_session_id {
            println!("   Resuming Claude session: {}", id);
        } else {
            println!("   Starting new Claude conversation");
        }
    }

    // Spawn process
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            let error = Message::Error {
                repo_path: Some(repo_path.to_string()),
                message: format!("Failed to spawn Claude: {}", e),
            };
            let _ = tx.send(serde_json::to_string(&error).unwrap());
            return;
        }
    };

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let error = Message::Error {
                repo_path: Some(repo_path.to_string()),
                message: "Failed to capture stdout".to_string(),
            };
            let _ = tx.send(serde_json::to_string(&error).unwrap());
            return;
        }
    };
    let mut reader = BufReader::new(stdout).lines();

    // Store process
    {
        let mut processes = state.active_processes.write().await;
        processes.insert(lychee_id.to_string(), child);
    }

    let lychee_id_str = lychee_id.to_string();
    let repo_path_str = repo_path.to_string();
    let mut new_claude_id = None;

    // Stream output (not spawned, handle inline)
    while let Ok(Some(line)) = reader.next_line().await {
        if line.trim().is_empty() {
            continue;
        }

        if let Ok(data) = serde_json::from_str::<Value>(&line) {
            // Extract session ID from system or init message
            if data.get("type") == Some(&serde_json::json!("system")) ||
               data.get("type") == Some(&serde_json::json!("init")) {
                if let Some(session_id) = data.get("session_id").and_then(|v| v.as_str()) {
                    new_claude_id = Some(session_id.to_string());
                    if state.debug {
                        println!("📝 Got Claude session ID: {}", session_id);
                    }
                }
            }

            // Forward to browser
            let msg = Message::ClaudeStream {
                repo_path: repo_path_str.clone(),
                lychee_id: lychee_id_str.clone(),
                data,
            };
            let _ = tx.send(serde_json::to_string(&msg).unwrap());
        }
    }

    // Update session info when Claude finishes
    let mut sessions_updated = false;
    if let Some(mut info) = std::fs::read_to_string(&session_info_path)
        .ok()
        .and_then(|s| serde_json::from_str::<SessionInfoFile>(&s).ok())
    {
        if let Some(metadata) = info.sessions.get_mut(&lychee_id_str) {
            // Update Claude session ID if we got a new one
            if let Some(claude_id) = new_claude_id {
                metadata.claude_session_id = Some(claude_id);
            }
            // Update last_active when response completes
            metadata.last_active = chrono::Utc::now().to_rfc3339();

            let _ = std::fs::write(
                &session_info_path,
                serde_json::to_string_pretty(&info).unwrap(),
            );
            sessions_updated = true;
        }
    }

    // Send updated sessions list to frontend
    if sessions_updated {
        let sessions = list_sessions(&repo_path_str).await;
        let update_msg = Message::SessionsList {
            repo_path: repo_path_str.clone(),
            sessions,
        };
        let _ = tx.send(serde_json::to_string(&update_msg).unwrap());
    }

    // Remove from active processes
    {
        let mut processes = state.active_processes.write().await;
        processes.remove(&lychee_id_str);
    }

    if state.debug {
        println!("✅ Claude finished for session {}", lychee_id_str);
    }
}

async fn render_tui(state: &Arc<AppState>) {
    let mut stdout = stdout();
    stdout.execute(cursor::MoveTo(0, 0)).ok();
    stdout.execute(terminal::Clear(ClearType::All)).ok();

    let processes = state.active_processes.read().await;
    let is_active = !processes.is_empty();

    // Update and get animation frame
    let frame = {
        let mut frame = state.animation_frame.write().await;
        *frame = (*frame + 1) % 3;
        *frame
    };

    // Choose cat frame
    let cat = if is_active {
        match frame {
            0 => CAT_AWAKE_FRAME_1,
            1 => CAT_AWAKE_FRAME_2,
            _ => CAT_AWAKE_FRAME_3,
        }
    } else {
        match frame {
            0 => CAT_SLEEP_FRAME_1,
            1 => CAT_SLEEP_FRAME_2,
            _ => CAT_SLEEP_FRAME_3,
        }
    };

    let uptime = state.start_time.elapsed().as_secs();
    let uptime_str = format!("{}:{:02}:{:02}", uptime / 3600, (uptime / 60) % 60, uptime % 60);
    let repo_path = std::env::current_dir().unwrap().display().to_string();
    let repo_name = std::env::current_dir()
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();

    // Display the cat
    stdout.execute(SetForegroundColor(Color::Cyan)).ok();
    for line in cat.lines() {
        stdout.execute(Print(format!("{}\n", line))).ok();
    }
    stdout.execute(ResetColor).ok();

    stdout.execute(Print("\n")).ok();

    // Title
    stdout.execute(SetForegroundColor(Color::Magenta)).ok();
    stdout.execute(Print("  LYCHEE CLIENT\n")).ok();
    stdout.execute(ResetColor).ok();

    stdout.execute(SetForegroundColor(Color::DarkGrey)).ok();
    stdout.execute(Print("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")).ok();
    stdout.execute(ResetColor).ok();

    stdout.execute(Print("\n")).ok();

    // Repository info
    stdout.execute(SetForegroundColor(Color::Blue)).ok();
    stdout.execute(Print(format!("  Repository: "))).ok();
    stdout.execute(ResetColor).ok();
    stdout.execute(Print(format!("{}\n", repo_name))).ok();

    stdout.execute(SetForegroundColor(Color::Blue)).ok();
    stdout.execute(Print(format!("  Path:       "))).ok();
    stdout.execute(ResetColor).ok();
    stdout.execute(SetForegroundColor(Color::DarkGrey)).ok();
    stdout.execute(Print(format!("{}\n", repo_path))).ok();
    stdout.execute(ResetColor).ok();

    stdout.execute(Print("\n")).ok();

    // Status
    stdout.execute(SetForegroundColor(Color::Blue)).ok();
    stdout.execute(Print("  Status:     ")).ok();
    stdout.execute(ResetColor).ok();

    if is_active {
        stdout.execute(SetForegroundColor(Color::Green)).ok();
        stdout.execute(Print(format!("● Active ({} session{})\n",
            processes.len(),
            if processes.len() == 1 { "" } else { "s" }))).ok();
    } else {
        stdout.execute(SetForegroundColor(Color::Yellow)).ok();
        stdout.execute(Print("● Waiting for messages\n")).ok();
    }
    stdout.execute(ResetColor).ok();

    stdout.execute(Print("\n")).ok();

    // Uptime
    stdout.execute(SetForegroundColor(Color::Blue)).ok();
    stdout.execute(Print("  Uptime:     ")).ok();
    stdout.execute(ResetColor).ok();
    stdout.execute(Print(format!("{}\n", uptime_str))).ok();

    stdout.execute(Print("\n")).ok();

    // Client count
    let client_count = state.client_count.read().await;
    stdout.execute(SetForegroundColor(Color::Blue)).ok();
    stdout.execute(Print("  Clients:    ")).ok();
    stdout.execute(ResetColor).ok();
    stdout.execute(SetForegroundColor(Color::Cyan)).ok();
    stdout.execute(Print(format!("{} connected on this machine\n", *client_count))).ok();
    stdout.execute(ResetColor).ok();

    stdout.execute(Print("\n")).ok();
    stdout.execute(SetForegroundColor(Color::DarkGrey)).ok();
    stdout.execute(Print("  Press Ctrl+C to exit\n")).ok();
    stdout.execute(ResetColor).ok();

    stdout.flush().ok();
}