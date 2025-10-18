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
use std::io::{stdout, Write as IoWrite, BufRead};
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
    #[serde(rename = "create_worktree_session")]
    CreateWorktreeSession { repo_path: String },
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
        active_session_ids: Option<Vec<String>>,
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
    #[serde(rename = "session_update")]
    SessionUpdate {
        repo_path: String,
        lychee_id: String,
        new_entries: Value,
    },
    #[serde(rename = "stream_start")]
    StreamStart {
        repo_path: String,
        lychee_id: String,
    },
    #[serde(rename = "stream_end")]
    StreamEnd {
        repo_path: String,
        lychee_id: String,
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
    is_worktree: bool,
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
    #[serde(default)]
    is_worktree: bool,
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
            // Get list of currently streaming sessions
            let active_session_ids = {
                let processes = state.active_processes.read().await;
                processes.keys().cloned().collect::<Vec<_>>()
            };

            // Send sessions list with active sessions included in same message
            // This avoids race conditions with separate stream_start messages
            let sessions = list_sessions(repo_path).await;
            let response = Message::SessionsList {
                repo_path: repo_path.to_string(),
                sessions,
                active_session_ids: if active_session_ids.is_empty() {
                    None
                } else {
                    Some(active_session_ids)
                },
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

        Message::CreateWorktreeSession { .. } => {
            if let Some(lychee_id) = create_worktree_session(repo_path, state.debug).await {
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
                lychee_id: lychee_id.clone(),
                messages,
            };
            let _ = tx.send(serde_json::to_string(&response).unwrap());

            // If this session is currently streaming, send stream_start to restore state
            let is_active = {
                let processes = state.active_processes.read().await;
                processes.contains_key(&lychee_id)
            };

            if is_active {
                let start_msg = Message::StreamStart {
                    repo_path: repo_path.to_string(),
                    lychee_id,
                };
                let _ = tx.send(serde_json::to_string(&start_msg).unwrap());
            }
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
                        active_session_ids: None,
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
    let session_info_path = lychee_dir.join(".session-info.json");

    // Load session info file - this is the source of truth
    let session_metadata = if session_info_path.exists() {
        match std::fs::read_to_string(&session_info_path) {
            Ok(content) => serde_json::from_str::<SessionInfoFile>(&content).unwrap_or_default(),
            Err(_) => SessionInfoFile { sessions: HashMap::new() },
        }
    } else {
        SessionInfoFile { sessions: HashMap::new() }
    };

    // Build session list from metadata
    for (lychee_id, metadata) in session_metadata.sessions.iter() {
        sessions.push(SessionInfo {
            lychee_id: lychee_id.clone(),
            claude_session_id: metadata.claude_session_id.clone(),
            created_at: metadata.created_at.clone(),
            last_active: metadata.last_active.clone(),
            is_worktree: metadata.is_worktree,
        });
    }

    // Sort by last_active descending
    sessions.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    sessions
}

async fn create_session(repo_path: &str, debug: bool) -> Option<String> {
    let lychee_id = format!("session-{}", Uuid::new_v4().to_string().split('-').next().unwrap());
    let lychee_dir = PathBuf::from(repo_path).join(".lychee");

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

    // Update session info file (no worktree creation for regular sessions)
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
            is_worktree: false,
        },
    );

    std::fs::write(
        session_info_path,
        serde_json::to_string_pretty(&session_info).unwrap(),
    ).ok()?;

    if debug {
        println!("✅ Created regular session: {}", lychee_id);
    }

    Some(lychee_id)
}

async fn create_worktree_session(repo_path: &str, debug: bool) -> Option<String> {
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
            is_worktree: true,
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

    // Get session metadata
    let metadata = if session_info_path.exists() {
        std::fs::read_to_string(&session_info_path)
            .ok()
            .and_then(|s| serde_json::from_str::<SessionInfoFile>(&s).ok())
            .and_then(|info| info.sessions.get(lychee_id).cloned())
    } else {
        None
    };

    if let Some(ref meta) = metadata {
        if let Some(ref claude_id) = meta.claude_session_id {
            // Determine working directory based on session type
            let is_worktree = meta.is_worktree;
            let working_dir = if is_worktree {
                lychee_dir.join(lychee_id)
            } else {
                PathBuf::from(repo_path)
            };

            // Find the Claude session file
            let session_file = find_claude_session_file(&working_dir, claude_id);

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
                                    // Extract the nested message object
                                    if let Some(message) = entry.get("message") {
                                        let mut enriched = message.clone();

                                        // Preserve isSidechain flag from the entry
                                        if let Some(is_sidechain) = entry.get("isSidechain") {
                                            if let Some(obj) = enriched.as_object_mut() {
                                                obj.insert("isSidechain".to_string(), is_sidechain.clone());
                                            }
                                        }

                                        messages.push(enriched);
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
            } else if debug {
                println!("⚠️  No Claude session file found for session {}", lychee_id);
            }
            }
        }
    }

    // Return empty array if no history
    serde_json::json!([])
}

/**
 * Spawn Claude and watch the JSONL file for updates
 *
 * Strategy: Use Claude's stdout events as triggers to check the JSONL file
 * The file is the source of truth - we only read from disk, never parse stdout content
 * This eliminates streaming/loading collisions
 */
async fn spawn_claude(
    tx: mpsc::UnboundedSender<String>,
    repo_path: &str,
    lychee_id: &str,
    content: &str,
    model: &str,
    state: &AppState,
) {
    let lychee_dir = PathBuf::from(repo_path).join(".lychee");
    let session_info_path = lychee_dir.join(".session-info.json");

    // Get session metadata to determine working directory
    let metadata = if session_info_path.exists() {
        std::fs::read_to_string(&session_info_path)
            .ok()
            .and_then(|s| serde_json::from_str::<SessionInfoFile>(&s).ok())
            .and_then(|info| info.sessions.get(lychee_id).cloned())
    } else {
        None
    };

    let is_worktree = metadata.as_ref().map(|m| m.is_worktree).unwrap_or(false);
    let working_dir = if is_worktree {
        lychee_dir.join(lychee_id)
    } else {
        PathBuf::from(repo_path)
    };

    let is_resuming_session = metadata.as_ref().and_then(|m| m.claude_session_id.as_ref()).is_some();
    let mut claude_session_id = metadata.as_ref().and_then(|m| m.claude_session_id.clone());

    // Build Claude command
    let mut cmd = Command::new("claude");
    cmd.current_dir(&working_dir);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());

    if let Some(ref claude_id) = claude_session_id {
        cmd.arg("--resume").arg(claude_id);
    }

    cmd.arg("-p").arg(content);
    cmd.arg("--model").arg(model);
    cmd.arg("--output-format").arg("stream-json");
    cmd.arg("--dangerously-skip-permissions");

    if state.debug {
        println!("🚀 Spawning Claude for session {}", lychee_id);
        println!("   Model: {}", model);
        if let Some(ref id) = claude_session_id {
            println!("   Resuming Claude session: {}", id);
        }
    }

    // Spawn Claude
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

    // Store process in active list
    {
        let mut processes = state.active_processes.write().await;
        processes.insert(lychee_id.to_string(), child);
    }

    let lychee_id_str = lychee_id.to_string();
    let repo_path_str = repo_path.to_string();

    // Notify frontend that streaming has started
    let start_msg = Message::StreamStart {
        repo_path: repo_path_str.clone(),
        lychee_id: lychee_id_str.clone(),
    };
    let _ = tx.send(serde_json::to_string(&start_msg).unwrap());

    // File watching setup: Use stdout events as triggers to check the JSONL file
    // We don't parse stdout content - just use it to know when to check the file
    let mut jsonl_file_path: Option<PathBuf> = None;
    let mut last_line_count: usize = 0;

    // Watch stdout for events - each event triggers a file check
    while let Ok(Some(line)) = reader.next_line().await {
        if line.trim().is_empty() {
            continue;
        }

        // New sessions need to extract the session ID from Claude's first message
        if claude_session_id.is_none() {
            if let Ok(data) = serde_json::from_str::<Value>(&line) {
                if let Some(session_id) = data.get("session_id").and_then(|v| v.as_str()) {
                    claude_session_id = Some(session_id.to_string());

                    // Save session ID to metadata
                    if let Some(mut info) = std::fs::read_to_string(&session_info_path)
                        .ok()
                        .and_then(|s| serde_json::from_str::<SessionInfoFile>(&s).ok())
                    {
                        if let Some(metadata) = info.sessions.get_mut(&lychee_id_str) {
                            metadata.claude_session_id = Some(session_id.to_string());
                            let _ = std::fs::write(
                                &session_info_path,
                                serde_json::to_string_pretty(&info).unwrap(),
                            );
                        }
                    }

                    if state.debug {
                        println!("📝 Got Claude session ID: {}", session_id);
                    }
                }
            }
        }

        // Locate the JSONL file once we have a session ID
        if claude_session_id.is_some() && jsonl_file_path.is_none() {
            if let Some(file) = find_claude_session_file(&working_dir, claude_session_id.as_ref().unwrap()) {
                jsonl_file_path = Some(file);

                // Set baseline: where to start reading from
                // Resuming: skip old messages (start from current file size)
                // New session: send everything (start from line 0)
                if is_resuming_session {
                    if let Ok(count) = count_file_lines(&jsonl_file_path.as_ref().unwrap()) {
                        last_line_count = count;
                    }
                } else {
                    last_line_count = 0;
                }

                if state.debug {
                    println!("📁 Found JSONL file, baseline: {} lines (resuming: {})", last_line_count, is_resuming_session);
                }
            }
        }

        // Stdout event triggered - check if file has new content
        if let Some(ref file_path) = jsonl_file_path {
            send_incremental_update(
                file_path,
                &mut last_line_count,
                &tx,
                &repo_path_str,
                &lychee_id_str,
                state.debug
            );
        }
    }

    // Final check after Claude exits (file might have buffered writes)
    tokio::time::sleep(Duration::from_millis(200)).await;

    if let Some(ref file_path) = jsonl_file_path {
        send_incremental_update(
            file_path,
            &mut last_line_count,
            &tx,
            &repo_path_str,
            &lychee_id_str,
            state.debug
        );
    }

    // Update metadata
    if let Some(mut info) = std::fs::read_to_string(&session_info_path)
        .ok()
        .and_then(|s| serde_json::from_str::<SessionInfoFile>(&s).ok())
    {
        if let Some(metadata) = info.sessions.get_mut(&lychee_id_str) {
            metadata.last_active = chrono::Utc::now().to_rfc3339();
            let _ = std::fs::write(
                &session_info_path,
                serde_json::to_string_pretty(&info).unwrap(),
            );
        }
    }

    // Send updated sessions list
    let sessions = list_sessions(&repo_path_str).await;
    let update_msg = Message::SessionsList {
        repo_path: repo_path_str.clone(),
        sessions,
        active_session_ids: None,
    };
    let _ = tx.send(serde_json::to_string(&update_msg).unwrap());

    // Notify frontend that streaming has ended
    let end_msg = Message::StreamEnd {
        repo_path: repo_path_str.clone(),
        lychee_id: lychee_id_str.clone(),
    };
    let _ = tx.send(serde_json::to_string(&end_msg).unwrap());

    // Remove from active processes
    {
        let mut processes = state.active_processes.write().await;
        processes.remove(&lychee_id_str);
    }

    if state.debug {
        println!("✅ Claude finished for session {}", lychee_id_str);
    }
}

/**
 * Count number of lines in a file
 */
fn count_file_lines(file_path: &PathBuf) -> std::io::Result<usize> {
    let file = std::fs::File::open(file_path)?;
    let reader = std::io::BufReader::new(file);
    Ok(reader.lines().count())
}

/**
 * Send incremental update with new JSONL entries since last check
 */
fn send_incremental_update(
    file_path: &PathBuf,
    last_line_count: &mut usize,
    tx: &mpsc::UnboundedSender<String>,
    repo_path: &str,
    lychee_id: &str,
    debug: bool,
) {
    // Read all lines from file
    let file = match std::fs::File::open(file_path) {
        Ok(f) => f,
        Err(_) => return, // File not ready yet
    };

    let all_lines: Vec<String> = std::io::BufReader::new(file)
        .lines()
        .filter_map(Result::ok)
        .collect();

    let current_count = all_lines.len();

    // No new lines
    if current_count <= *last_line_count {
        return;
    }

    if debug {
        println!("📥 Reading {} new lines (total: {})", current_count - *last_line_count, current_count);
    }

    // Parse new entries
    let new_entries: Vec<Value> = all_lines[*last_line_count..]
        .iter()
        .filter_map(|line| parse_jsonl_entry(line))
        .collect();

    if !new_entries.is_empty() {
        let update = Message::SessionUpdate {
            repo_path: repo_path.to_string(),
            lychee_id: lychee_id.to_string(),
            new_entries: serde_json::json!(new_entries),
        };
        let _ = tx.send(serde_json::to_string(&update).unwrap());
    }

    *last_line_count = current_count;
}

/**
 * Parse a single JSONL line into a message entry
 * Preserves isSidechain flag for frontend filtering
 */
fn parse_jsonl_entry(line: &str) -> Option<Value> {
    let entry: Value = serde_json::from_str(line).ok()?;

    // Only include user and assistant messages
    let msg_type = entry.get("type")?.as_str()?;
    if msg_type != "user" && msg_type != "assistant" {
        return None;
    }

    // Extract message object
    let message = entry.get("message")?;
    let mut enriched = message.clone();

    // Preserve isSidechain flag from entry
    if let Some(is_sidechain) = entry.get("isSidechain") {
        if let Some(obj) = enriched.as_object_mut() {
            obj.insert("isSidechain".to_string(), is_sidechain.clone());
        }
    }

    Some(enriched)
}

/**
 * Find Claude's JSONL file for a session
 * Searches in ~/.claude/projects/ directories
 */
fn find_claude_session_file(working_dir: &PathBuf, claude_session_id: &str) -> Option<PathBuf> {
    let home_dir = std::env::var("HOME").ok()?;
    let projects_dir = PathBuf::from(&home_dir).join(".claude").join("projects");
    let session_filename = format!("{}.jsonl", claude_session_id);

    // Sanitize the working directory path to match Claude's project directory naming
    let path_str = working_dir.display().to_string();
    let sanitized = path_str
        .trim_start_matches('/')
        .replace('/', "-")
        .replace('.', "-");
    let sanitized_path = format!("-{}", sanitized);

    // Try the expected sanitized path first
    let expected_file = projects_dir.join(&sanitized_path).join(&session_filename);
    if expected_file.exists() {
        return Some(expected_file);
    }

    eprintln!("⚠️  Expected path not found: {:?}", expected_file);
    eprintln!("🔍 Searching all project directories for session file...");

    // If not found, search through all project directories for a match
    // This handles cases where Claude's path sanitization differs from ours
    if let Ok(entries) = std::fs::read_dir(&projects_dir) {
        for entry in entries.filter_map(Result::ok) {
            let dir_path = entry.path();
            if !dir_path.is_dir() {
                continue;
            }

            let possible_file = dir_path.join(&session_filename);
            if possible_file.exists() {
                eprintln!("✅ Found session file via fallback search: {:?}", possible_file);
                return Some(possible_file);
            }
        }
    }

    eprintln!("❌ Session file not found after exhaustive search");
    None
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