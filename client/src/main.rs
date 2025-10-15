use clap::{Parser, Subcommand};
use crossterm::{
    ExecutableCommand, cursor,
    style::{Color, Print, ResetColor, SetForegroundColor},
    terminal::{self, ClearType},
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Write as IoWrite, stdout};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{RwLock, mpsc};
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
    RegisterClient {
        repo_path: String,
        repo_name: String,
    },

    // Browser -> Client requests
    #[serde(rename = "list_sessions")]
    ListSessions { repo_path: String },
    #[serde(rename = "create_session")]
    CreateSession { repo_path: String },
    #[serde(rename = "load_session")]
    LoadSession {
        repo_path: String,
        lychee_id: String,
    },
    #[serde(rename = "send_message")]
    SendMessage {
        repo_path: String,
        lychee_id: String,
        content: String,
    },
    #[serde(rename = "checkout_branch")]
    CheckoutBranch {
        repo_path: String,
        lychee_id: String,
    },
    #[serde(rename = "revert_checkout")]
    RevertCheckout {
        repo_path: String,
        lychee_id: String,
    },

    // Client -> Browser responses
    #[serde(rename = "sessions_list")]
    SessionsList {
        repo_path: String,
        sessions: Vec<SessionInfo>,
        checked_out_session: Option<String>,
        main_dir_uncommitted: bool,
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
    ClientCount { count: usize },
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
    #[serde(default)]
    checked_out_session: Option<String>,
    #[serde(default)]
    sessions: HashMap<String, SessionMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionMetadata {
    claude_session_id: Option<String>,
    created_at: String,
    last_active: String,
    #[serde(default)]
    original_branch: Option<String>,
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
    let relay_url =
        std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3001/ws".to_string());
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

    // Ensure .lychee is in .gitignore
    ensure_lychee_ignored(&repo_path);

    let (mut write, mut read) = ws_stream.split();

    // Register as client
    let register_msg = Message::RegisterClient {
        repo_path: repo_path.clone(),
        repo_name: repo_name.clone(),
    };
    write
        .send(WsMessage::Text(
            serde_json::to_string(&register_msg).unwrap(),
        ))
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
            let (sessions, checked_out, uncommitted) = list_sessions(repo_path).await;
            let response = Message::SessionsList {
                repo_path: repo_path.to_string(),
                sessions,
                checked_out_session: checked_out,
                main_dir_uncommitted: uncommitted,
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
            lychee_id, content, ..
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
                    let (sessions, checked_out, uncommitted) = list_sessions(repo_path).await;
                    let update_msg = Message::SessionsList {
                        repo_path: repo_path.to_string(),
                        sessions,
                        checked_out_session: checked_out,
                        main_dir_uncommitted: uncommitted,
                    };
                    let _ = tx.send(serde_json::to_string(&update_msg).unwrap());
                }
            }

            // Spawn Claude in background task
            let tx_clone = tx.clone();
            let repo_path_clone = repo_path.to_string();
            let lychee_id_clone = lychee_id.clone();
            let content_clone = content.clone();
            let state_clone = state.clone();

            tokio::spawn(async move {
                spawn_claude(
                    tx_clone,
                    &repo_path_clone,
                    &lychee_id_clone,
                    &content_clone,
                    &state_clone,
                )
                .await;
            });
        }

        Message::ClientCount { count } => {
            let mut client_count = state.client_count.write().await;
            *client_count = count;
        }

        Message::CheckoutBranch { lychee_id, .. } => {
            checkout_branch(tx.clone(), repo_path, &lychee_id, state.debug).await;
        }

        Message::RevertCheckout { lychee_id, .. } => {
            revert_checkout(tx.clone(), repo_path, &lychee_id, state.debug).await;
        }

        _ => {}
    }
}

async fn checkout_branch(
    tx: mpsc::UnboundedSender<String>,
    repo_path: &str,
    lychee_id: &str,
    debug: bool,
) {
    let lychee_dir = PathBuf::from(repo_path).join(".lychee");
    let session_dir = lychee_dir.join(lychee_id);
    let session_info_path = lychee_dir.join(".session-info.json");

    // Load session info
    let mut session_info = match std::fs::read_to_string(&session_info_path)
        .ok()
        .and_then(|s| serde_json::from_str::<SessionInfoFile>(&s).ok())
    {
        Some(info) => info,
        None => {
            send_error(&tx, "Session info not found");
            return;
        }
    };

    // Check if another session is already checked out
    // But first verify the stored state matches reality
    let current_branch = get_current_branch(repo_path)
        .await
        .unwrap_or_else(|| "main".to_string());

    if let Some(stored_checkout) = session_info.checked_out_session.clone() {
        // Verify the stored checkout matches actual git state
        let worktree_exists = session_dir.exists();

        if worktree_exists && current_branch == stored_checkout {
            // Mismatch: JSON says checked out but worktree exists
            // User must have manually recreated it - fix the state
            if debug {
                println!("   Detected mismatch: fixing checked_out_session state");
            }
            session_info.checked_out_session = None;
            let _ = std::fs::write(
                &session_info_path,
                serde_json::to_string_pretty(&session_info).unwrap(),
            );
        } else if !worktree_exists && current_branch != stored_checkout {
            // Mismatch: JSON says checked out but we're on different branch
            // User manually switched - clear the state
            if debug {
                println!("   Detected mismatch: user switched branches manually");
            }
            session_info.checked_out_session = None;
            if let Some(metadata) = session_info.sessions.get_mut(&stored_checkout) {
                metadata.original_branch = None;
            }
            let _ = std::fs::write(
                &session_info_path,
                serde_json::to_string_pretty(&session_info).unwrap(),
            );
        } else if stored_checkout != lychee_id {
            // Another session is legitimately checked out
            send_error(
                &tx,
                &format!(
                    "Session {} is already checked out. Revert it first.",
                    stored_checkout
                ),
            );
            return;
        }
    }

    // Check main directory for uncommitted changes
    if has_uncommitted_changes(repo_path).await {
        send_error(
            &tx,
            "Main directory has uncommitted changes. Commit them first.",
        );
        return;
    }

    if debug {
        println!("🔄 Checking out session {} to main directory", lychee_id);
        println!("   Current branch: {}", current_branch);
    }

    // Make temp commit in worktree
    if debug {
        println!("   Creating temp commit in worktree...");
    }

    let add_output = Command::new("git")
        .args(&["add", "-A"])
        .current_dir(&session_dir)
        .output()
        .await;

    if debug {
        if let Ok(out) = &add_output {
            println!(
                "   git add output: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
    }

    let commit_output = Command::new("git")
        .args(&[
            "commit",
            "-m",
            &format!(
                "Lychee checkpoint: {} at {}",
                lychee_id,
                chrono::Utc::now().to_rfc3339()
            ),
            "--allow-empty",
        ])
        .current_dir(&session_dir)
        .output()
        .await;

    if debug {
        if let Ok(out) = &commit_output {
            println!("   git commit: {}", String::from_utf8_lossy(&out.stdout));
        }
    }

    // Remove worktree
    let output = Command::new("git")
        .args(&[
            "worktree",
            "remove",
            &session_dir.display().to_string(),
            "--force",
        ])
        .current_dir(repo_path)
        .output()
        .await;

    if let Ok(out) = output {
        if !out.status.success() {
            send_error(
                &tx,
                &format!(
                    "Failed to remove worktree: {}",
                    String::from_utf8_lossy(&out.stderr)
                ),
            );
            return;
        }
    }

    // Checkout the session branch in main directory
    let output = Command::new("git")
        .args(&["checkout", lychee_id])
        .current_dir(repo_path)
        .output()
        .await;

    if let Ok(out) = output {
        if !out.status.success() {
            send_error(
                &tx,
                &format!(
                    "Failed to checkout branch: {}",
                    String::from_utf8_lossy(&out.stderr)
                ),
            );
            return;
        }
    }

    // Reset the temp commit to keep changes uncommitted
    if debug {
        println!("   Resetting temp commit...");
    }

    let reset_output = Command::new("git")
        .args(&["reset", "--soft", "HEAD~1"])
        .current_dir(repo_path)
        .output()
        .await;

    if debug {
        if let Ok(out) = &reset_output {
            if !out.status.success() {
                println!(
                    "   git reset error: {}",
                    String::from_utf8_lossy(&out.stderr)
                );
            } else {
                println!("   Reset successful - changes are now uncommitted");
            }
        }
    }

    // Update session info
    session_info.checked_out_session = Some(lychee_id.to_string());
    if let Some(metadata) = session_info.sessions.get_mut(lychee_id) {
        metadata.original_branch = Some(current_branch);
    }

    let _ = std::fs::write(
        session_info_path,
        serde_json::to_string_pretty(&session_info).unwrap(),
    );

    if debug {
        println!("✅ Checked out session {} to main directory", lychee_id);
    }

    // Send updated sessions list
    let (sessions, checked_out, uncommitted) = list_sessions(repo_path).await;
    let update_msg = Message::SessionsList {
        repo_path: repo_path.to_string(),
        sessions,
        checked_out_session: checked_out,
        main_dir_uncommitted: uncommitted,
    };
    let _ = tx.send(serde_json::to_string(&update_msg).unwrap());
}

async fn revert_checkout(
    tx: mpsc::UnboundedSender<String>,
    repo_path: &str,
    lychee_id: &str,
    debug: bool,
) {
    let lychee_dir = PathBuf::from(repo_path).join(".lychee");
    let session_dir = lychee_dir.join(lychee_id);
    let session_info_path = lychee_dir.join(".session-info.json");

    // Load session info
    let mut session_info = match std::fs::read_to_string(&session_info_path)
        .ok()
        .and_then(|s| serde_json::from_str::<SessionInfoFile>(&s).ok())
    {
        Some(info) => info,
        None => {
            send_error(&tx, "Session info not found");
            return;
        }
    };

    // Verify this session is checked out
    if session_info.checked_out_session.as_ref() != Some(&lychee_id.to_string()) {
        send_error(&tx, "This session is not checked out");
        return;
    }

    // Get original branch
    let original_branch = session_info
        .sessions
        .get(lychee_id)
        .and_then(|m| m.original_branch.clone())
        .unwrap_or_else(|| "main".to_string());

    if debug {
        println!("🔄 Reverting checkout for session {}", lychee_id);
        println!("   Will checkout: {}", original_branch);
    }

    // Make temp commit in main directory
    let _ = Command::new("git")
        .args(&["add", "-A"])
        .current_dir(repo_path)
        .output()
        .await;

    let _ = Command::new("git")
        .args(&[
            "commit",
            "-m",
            &format!(
                "Lychee checkpoint: {} at {}",
                lychee_id,
                chrono::Utc::now().to_rfc3339()
            ),
            "--allow-empty",
        ])
        .current_dir(repo_path)
        .output()
        .await;

    // Checkout original branch
    let output = Command::new("git")
        .args(&["checkout", &original_branch])
        .current_dir(repo_path)
        .output()
        .await;

    if let Ok(out) = output {
        if !out.status.success() {
            send_error(
                &tx,
                &format!(
                    "Failed to checkout {}: {}",
                    original_branch,
                    String::from_utf8_lossy(&out.stderr)
                ),
            );
            return;
        }
    }

    // Recreate worktree
    let output = Command::new("git")
        .args(&[
            "worktree",
            "add",
            &session_dir.display().to_string(),
            lychee_id,
        ])
        .current_dir(repo_path)
        .output()
        .await;

    if let Ok(out) = output {
        if !out.status.success() {
            send_error(
                &tx,
                &format!(
                    "Failed to recreate worktree: {}",
                    String::from_utf8_lossy(&out.stderr)
                ),
            );
            return;
        }
    }

    // Reset the temp commit in the worktree
    let _ = Command::new("git")
        .args(&["reset", "--soft", "HEAD~1"])
        .current_dir(&session_dir)
        .output()
        .await;

    // Update session info
    session_info.checked_out_session = None;
    if let Some(metadata) = session_info.sessions.get_mut(lychee_id) {
        metadata.original_branch = None;
    }

    let _ = std::fs::write(
        session_info_path,
        serde_json::to_string_pretty(&session_info).unwrap(),
    );

    if debug {
        println!("✅ Reverted checkout for session {}", lychee_id);
    }

    // Send updated sessions list
    let (sessions, checked_out, uncommitted) = list_sessions(repo_path).await;
    let update_msg = Message::SessionsList {
        repo_path: repo_path.to_string(),
        sessions,
        checked_out_session: checked_out,
        main_dir_uncommitted: uncommitted,
    };
    let _ = tx.send(serde_json::to_string(&update_msg).unwrap());
}

async fn has_uncommitted_changes(repo_path: &str) -> bool {
    Command::new("git")
        .arg("status")
        .arg("--porcelain")
        .current_dir(repo_path)
        .output()
        .await
        .ok()
        .map(|output| !output.stdout.is_empty())
        .unwrap_or(false)
}

async fn get_current_branch(repo_path: &str) -> Option<String> {
    Command::new("git")
        .args(&["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(repo_path)
        .output()
        .await
        .ok()
        .and_then(|output| {
            if output.status.success() {
                String::from_utf8(output.stdout)
                    .ok()
                    .map(|s| s.trim().to_string())
            } else {
                None
            }
        })
}

fn send_error(tx: &mpsc::UnboundedSender<String>, message: &str) {
    let error = Message::Error {
        repo_path: None,
        message: message.to_string(),
    };
    let _ = tx.send(serde_json::to_string(&error).unwrap());
}

fn ensure_lychee_ignored(repo_path: &str) {
    let exclude_path = PathBuf::from(repo_path)
        .join(".git")
        .join("info")
        .join("exclude");

    // Read existing exclude file
    let content = std::fs::read_to_string(&exclude_path).unwrap_or_else(|_| String::new());

    // Check if .lychee is already excluded
    if content.lines().any(|line| {
        line.trim() == "/.lychee" || line.trim() == ".lychee" || line.trim() == "/.lychee/"
    }) {
        return;
    }

    // Append .lychee to exclude file
    let new_content = if content.ends_with('\n') || content.is_empty() {
        format!("{}/.lychee\n", content)
    } else {
        format!("{}\n/.lychee\n", content)
    };

    if std::fs::write(exclude_path, new_content).is_ok() {
        println!("📝 Automatically added .lychee to .git/info/exclude");
    }
}

async fn list_sessions(repo_path: &str) -> (Vec<SessionInfo>, Option<String>, bool) {
    let mut sessions = Vec::new();
    let lychee_dir = PathBuf::from(repo_path).join(".lychee");

    // Load session info file
    let session_info_path = lychee_dir.join(".session-info.json");
    let session_metadata = if session_info_path.exists() {
        match std::fs::read_to_string(&session_info_path) {
            Ok(content) => serde_json::from_str::<SessionInfoFile>(&content).unwrap_or_default(),
            Err(_) => SessionInfoFile::default(),
        }
    } else {
        SessionInfoFile::default()
    };

    // Scan for session directories (worktrees)
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

    // Also include sessions that are checked out (no worktree but in metadata)
    for (session_id, metadata) in &session_metadata.sessions {
        if !sessions.iter().any(|s| &s.lychee_id == session_id) {
            // Session exists in metadata but not in worktrees - must be checked out or deleted
            sessions.push(SessionInfo {
                lychee_id: session_id.clone(),
                claude_session_id: metadata.claude_session_id.clone(),
                created_at: metadata.created_at.clone(),
                last_active: metadata.last_active.clone(),
            });
        }
    }

    // Sort by last_active descending
    sessions.sort_by(|a, b| b.last_active.cmp(&a.last_active));

    // Check if main directory has uncommitted changes
    let main_dir_uncommitted = Command::new("git")
        .arg("status")
        .arg("--porcelain")
        .current_dir(repo_path)
        .output()
        .await
        .ok()
        .map(|output| !output.stdout.is_empty())
        .unwrap_or(false);

    (
        sessions,
        session_metadata.checked_out_session,
        main_dir_uncommitted,
    )
}

async fn create_session(repo_path: &str, debug: bool) -> Option<String> {
    let lychee_id = format!(
        "session-{}",
        Uuid::new_v4().to_string().split('-').next().unwrap()
    );
    let lychee_dir = PathBuf::from(repo_path).join(".lychee");
    let session_dir = lychee_dir.join(&lychee_id);

    // Create .lychee directory if it doesn't exist
    if !lychee_dir.exists() {
        std::fs::create_dir(&lychee_dir).ok()?;
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
            eprintln!(
                "❌ Failed to create worktree: {}",
                String::from_utf8_lossy(&output.stderr)
            );
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
        SessionInfoFile::default()
    };

    session_info.sessions.insert(
        lychee_id.clone(),
        SessionMetadata {
            claude_session_id: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            last_active: chrono::Utc::now().to_rfc3339(),
            original_branch: None,
        },
    );

    std::fs::write(
        session_info_path,
        serde_json::to_string_pretty(&session_info).unwrap(),
    )
    .ok()?;

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
                .replace("/.", "/-.") // Preserve dots after slashes
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
                    println!(
                        "📖 Loaded {} messages for session {}",
                        messages.len(),
                        lychee_id
                    );
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
    state: &AppState,
) {
    let lychee_dir = PathBuf::from(repo_path).join(".lychee");
    let session_dir = lychee_dir.join(lychee_id);
    let session_info_path = lychee_dir.join(".session-info.json");

    // Load session info to check if checked out
    let session_info = std::fs::read_to_string(&session_info_path)
        .ok()
        .and_then(|s| serde_json::from_str::<SessionInfoFile>(&s).ok())
        .unwrap_or_default();

    // Determine working directory
    let working_dir = if session_info.checked_out_session.as_ref() == Some(&lychee_id.to_string()) {
        // Session is checked out - use main directory
        PathBuf::from(repo_path)
    } else {
        // Normal - use worktree
        session_dir.clone()
    };

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
    cmd.current_dir(&working_dir);
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
    cmd.arg("--output-format");
    cmd.arg("stream-json");
    cmd.arg("--verbose");
    cmd.arg("--dangerously-skip-permissions");

    if state.debug {
        println!("🚀 Spawning Claude for session {}", lychee_id);
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
            if data.get("type") == Some(&serde_json::json!("system"))
                || data.get("type") == Some(&serde_json::json!("init"))
            {
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
        let (sessions, checked_out, uncommitted) = list_sessions(&repo_path_str).await;
        let update_msg = Message::SessionsList {
            repo_path: repo_path_str.clone(),
            sessions,
            checked_out_session: checked_out,
            main_dir_uncommitted: uncommitted,
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
    let uptime_str = format!(
        "{}:{:02}:{:02}",
        uptime / 3600,
        (uptime / 60) % 60,
        uptime % 60
    );
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
    stdout
        .execute(Print("  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"))
        .ok();
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
        stdout
            .execute(Print(format!(
                "● Active ({} session{})\n",
                processes.len(),
                if processes.len() == 1 { "" } else { "s" }
            )))
            .ok();
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
    stdout
        .execute(Print(format!(
            "{} connected on this machine\n",
            *client_count
        )))
        .ok();
    stdout.execute(ResetColor).ok();

    stdout.execute(Print("\n")).ok();
    stdout.execute(SetForegroundColor(Color::DarkGrey)).ok();
    stdout.execute(Print("  Press Ctrl+C to exit\n")).ok();
    stdout.execute(ResetColor).ok();

    stdout.flush().ok();
}
