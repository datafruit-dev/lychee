use axum::{
    extract::{ws::WebSocket, State, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, net::SocketAddr, sync::Arc};
use tokio::sync::{broadcast, RwLock};

// Message protocol
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
enum WsMessage {
    // Client messages
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
    #[serde(rename = "sessions_updated")]
    SessionsUpdated {
        repo_path: String,
        sessions: Vec<SessionInfo>,
    },

    // Browser messages
    #[serde(rename = "register_browser")]
    RegisterBrowser,

    // Common messages
    #[serde(rename = "message")]
    Message {
        payload: String,
        repo_path: String,
        session_id: Option<String>,
    },
    #[serde(rename = "claude_stream")]
    ClaudeStream { payload: serde_json::Value },
    #[serde(rename = "load_session")]
    LoadSession {
        session_id: String,
        repo_path: String,
    },
    #[serde(rename = "session_history")]
    SessionHistory {
        session_id: String,
        messages: serde_json::Value,
    },

    // Status messages
    #[serde(rename = "repo_added")]
    RepoAdded {
        repo: RepoInfo,
    },
    #[serde(rename = "repo_removed")]
    RepoRemoved {
        repo_path: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionInfo {
    id: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RepoInfo {
    name: String,
    path: String,
    sessions: Vec<SessionInfo>,
}

struct ClientInfo {
    tx: tokio::sync::mpsc::UnboundedSender<String>,
    working_dir: String,
    repo_name: String,
    sessions: Vec<SessionInfo>,
}

// Shared application state
#[derive(Clone)]
struct AppState {
    // Broadcast channel for sending to all browsers
    browser_tx: broadcast::Sender<String>,
    // Map of repo_path -> ClientInfo
    clients: Arc<RwLock<HashMap<String, ClientInfo>>>,
}

#[tokio::main]
async fn main() {
    let (browser_tx, _) = broadcast::channel(100);

    let state = AppState {
        browser_tx,
        clients: Arc::new(RwLock::new(HashMap::new())),
    };

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 3001));
    println!("Relay server listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_connection(socket, state))
}

async fn handle_connection(socket: WebSocket, state: AppState) {
    let (sender, mut receiver) = socket.split();

    // First message determines client type
    let client_type = match receiver.next().await {
        Some(Ok(axum::extract::ws::Message::Text(text))) => {
            match serde_json::from_str::<WsMessage>(&text) {
                Ok(WsMessage::ClientConnected { working_dir, repo_name, sessions }) => {
                    println!("✓ Client connected: {} ({})", repo_name, working_dir);
                    Some(ClientType::Client { working_dir, repo_name, sessions })
                }
                Ok(WsMessage::RegisterBrowser) => {
                    println!("✓ Browser connected");
                    Some(ClientType::Browser)
                }
                _ => None,
            }
        }
        _ => None,
    };

    match client_type {
        Some(ClientType::Client { working_dir, repo_name, sessions }) => {
            handle_client(sender, receiver, state, working_dir, repo_name, sessions).await;
        }
        Some(ClientType::Browser) => {
            handle_browser(sender, receiver, state).await;
        }
        None => {
            println!("✗ Invalid connection - no registration");
        }
    }
}

async fn handle_client(
    mut sender: futures_util::stream::SplitSink<WebSocket, axum::extract::ws::Message>,
    mut receiver: futures_util::stream::SplitStream<WebSocket>,
    state: AppState,
    working_dir: String,
    repo_name: String,
    sessions: Vec<SessionInfo>,
) {
    // Check if client already exists for this working_dir
    {
        let clients = state.clients.read().await;
        if clients.contains_key(&working_dir) {
            println!("✗ Client already connected for {}", working_dir);
            let _ = sender.send(axum::extract::ws::Message::Text(
                r#"{"type":"error","message":"Client already connected for this directory"}"#.to_string()
            )).await;
            return;
        }
    }

    // Create channel for this client
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // Register this client
    {
        let mut clients = state.clients.write().await;
        clients.insert(
            working_dir.clone(),
            ClientInfo {
                tx,
                working_dir: working_dir.clone(),
                repo_name: repo_name.clone(),
                sessions: sessions.clone(),
            },
        );
    }

    // Broadcast repo added to all browsers
    let repo_msg = WsMessage::RepoAdded {
        repo: RepoInfo {
            name: repo_name.clone(),
            path: working_dir.clone(),
            sessions: sessions.clone(),
        },
    };
    let _ = state.browser_tx.send(serde_json::to_string(&repo_msg).unwrap());

    // Task 1: Send messages to client
    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender
                .send(axum::extract::ws::Message::Text(msg))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    // Task 2: Receive output from client, broadcast to browsers
    let browser_tx = state.browser_tx.clone();
    let clients = state.clients.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(axum::extract::ws::Message::Text(text))) = receiver.next().await {
            println!("Client → Browsers: {}", text.chars().take(100).collect::<String>());

            // Handle specific message types
            if let Ok(ws_msg) = serde_json::from_str::<WsMessage>(&text) {
                match ws_msg {
                    WsMessage::SessionCreated { repo_path, session } => {
                        println!("📦 Received SessionCreated for {} - {}", repo_path, session.id);
                        // Update stored sessions
                        {
                            let mut clients_guard = clients.write().await;
                            if let Some(client_info) = clients_guard.get_mut(&repo_path) {
                                client_info.sessions.push(session.clone());
                            }
                        }

                        // Forward the SessionCreated message as-is first
                        println!("📡 Broadcasting SessionCreated to browsers");
                        if browser_tx.send(text.clone()).is_err() {
                            println!("⚠️  Failed to broadcast SessionCreated - no browsers listening?");
                        }

                        // Then broadcast session update for other browsers
                        let clients_guard = clients.read().await;
                        if let Some(client_info) = clients_guard.get(&repo_path) {
                            let update_msg = WsMessage::SessionsUpdated {
                                repo_path,
                                sessions: client_info.sessions.clone(),
                            };
                            let _ = browser_tx.send(serde_json::to_string(&update_msg).unwrap());
                        }
                    }
                    _ => {
                        // Forward all other messages as-is
                        let _ = browser_tx.send(text);
                    }
                }
            } else {
                // Forward non-JSON messages as-is
                let _ = browser_tx.send(text);
            }
        }
    });

    // Wait for disconnect
    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }

    // Cleanup
    {
        let mut clients = state.clients.write().await;
        clients.remove(&working_dir);
    }

    // Broadcast repo removed to all browsers
    let remove_msg = WsMessage::RepoRemoved {
        repo_path: working_dir,
    };
    let _ = state.browser_tx.send(serde_json::to_string(&remove_msg).unwrap());

    println!("✗ Client disconnected: {}", repo_name);
}

async fn handle_browser(
    sender: futures_util::stream::SplitSink<WebSocket, axum::extract::ws::Message>,
    receiver: futures_util::stream::SplitStream<WebSocket>,
    state: AppState,
) {
    use tokio::sync::mpsc;

    let (response_tx, mut response_rx) = mpsc::unbounded_channel::<String>();

    // Send current repos immediately
    {
        let clients = state.clients.read().await;
        for client_info in clients.values() {
            let repo_msg = WsMessage::RepoAdded {
                repo: RepoInfo {
                    name: client_info.repo_name.clone(),
                    path: client_info.working_dir.clone(),
                    sessions: client_info.sessions.clone(),
                },
            };
            let _ = response_tx.send(serde_json::to_string(&repo_msg).unwrap());
        }
    }

    // Subscribe to broadcasts
    let mut browser_rx = state.browser_tx.subscribe();

    // Task 1: Send output to browser (from broadcasts + direct responses)
    let mut sender_clone = sender;
    let mut send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                // From broadcast
                msg = browser_rx.recv() => {
                    if let Ok(msg) = msg {
                        if sender_clone.send(axum::extract::ws::Message::Text(msg)).await.is_err() {
                            break;
                        }
                    }
                }
                // From direct responses
                Some(msg) = response_rx.recv() => {
                    if sender_clone.send(axum::extract::ws::Message::Text(msg)).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Task 2: Receive commands from browser
    let clients = state.clients.clone();
    let mut recv_task = tokio::spawn(async move {
        let mut receiver = receiver;
        while let Some(Ok(axum::extract::ws::Message::Text(text))) = receiver.next().await {
            if let Ok(ws_msg) = serde_json::from_str::<WsMessage>(&text) {
                match ws_msg {
                    WsMessage::Message { repo_path, .. } |
                    WsMessage::CreateSession { repo_path } |
                    WsMessage::LoadSession { repo_path, .. } => {
                        // Forward to specific client
                        let clients_guard = clients.read().await;
                        if let Some(client_info) = clients_guard.get(&repo_path) {
                            println!("Browser → Client ({}): {}",
                                client_info.repo_name,
                                text.chars().take(50).collect::<String>()
                            );
                            let _ = client_info.tx.send(text);
                        } else {
                            println!("✗ No client connected for {}", repo_path);
                            let error_msg = serde_json::json!({
                                "type": "error",
                                "message": format!("No client connected for {}", repo_path)
                            });
                            let _ = response_tx.send(error_msg.to_string());
                        }
                    }
                    _ => {
                        println!("Browser: Unknown message type");
                    }
                }
            }
        }
    });

    // Wait for disconnect
    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }

    println!("✗ Browser disconnected");
}

enum ClientType {
    Client { working_dir: String, repo_name: String, sessions: Vec<SessionInfo> },
    Browser,
}