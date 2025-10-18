use axum::{
    extract::{ws::WebSocket, State, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, net::SocketAddr, sync::Arc};
use tokio::sync::{mpsc, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
enum Message {
    // Registration
    #[serde(rename = "register_client")]
    RegisterClient { repo_path: String, repo_name: String },
    #[serde(rename = "register_browser")]
    RegisterBrowser,

    // Client status
    #[serde(rename = "client_connected")]
    ClientConnected { repo_path: String, repo_name: String },
    #[serde(rename = "client_disconnected")]
    ClientDisconnected { repo_path: String },

    // Browser -> Client (via relay)
    #[serde(rename = "list_sessions")]
    ListSessions { repo_path: String },
    #[serde(rename = "create_session")]
    CreateSession { repo_path: String },
    #[serde(rename = "create_worktree_session")]
    CreateWorktreeSession { repo_path: String },
    #[serde(rename = "load_session")]
    LoadSession { repo_path: String, lychee_id: String },
    #[serde(rename = "send_message")]
    SendMessage { repo_path: String, lychee_id: String, content: String, model: String },

    // Client -> Browser (via relay)
    #[serde(rename = "sessions_list")]
    SessionsList {
        repo_path: String,
        sessions: Vec<SessionInfo>,
        active_session_ids: Option<Vec<String>>
    },
    #[serde(rename = "client_count")]
    ClientCount {
        count: usize,
    },
    #[serde(rename = "session_created")]
    SessionCreated {
        repo_path: String,
        lychee_id: String
    },
    #[serde(rename = "session_history")]
    SessionHistory {
        repo_path: String,
        lychee_id: String,
        messages: serde_json::Value
    },
    #[serde(rename = "session_update")]
    SessionUpdate {
        repo_path: String,
        lychee_id: String,
        new_entries: serde_json::Value
    },
    #[serde(rename = "stream_start")]
    StreamStart {
        repo_path: String,
        lychee_id: String
    },
    #[serde(rename = "stream_end")]
    StreamEnd {
        repo_path: String,
        lychee_id: String
    },
    #[serde(rename = "claude_stream")]
    ClaudeStream {
        repo_path: String,
        lychee_id: String,
        data: serde_json::Value
    },
    #[serde(rename = "error")]
    Error {
        repo_path: Option<String>,
        message: String
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

#[derive(Clone)]
struct AppState {
    clients: Arc<RwLock<HashMap<String, mpsc::UnboundedSender<String>>>>,
    browsers: Arc<RwLock<Vec<mpsc::UnboundedSender<String>>>>,
}

#[tokio::main]
async fn main() {
    let state = AppState {
        clients: Arc::new(RwLock::new(HashMap::new())),
        browsers: Arc::new(RwLock::new(Vec::new())),
    };

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 3001));
    println!("🚀 Relay server listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_connection(socket, state))
}

async fn handle_connection(socket: WebSocket, state: AppState) {
    let (sender, mut receiver) = socket.split();

    // Wait for registration message
    let registration = match receiver.next().await {
        Some(Ok(axum::extract::ws::Message::Text(text))) => {
            serde_json::from_str::<Message>(&text).ok()
        }
        _ => None,
    };

    match registration {
        Some(Message::RegisterClient { repo_path, repo_name }) => {
            handle_client(sender, receiver, state, repo_path, repo_name).await;
        }
        Some(Message::RegisterBrowser) => {
            handle_browser(sender, receiver, state).await;
        }
        _ => {
            println!("❌ Invalid registration message");
        }
    }
}

async fn handle_client(
    mut sender: futures_util::stream::SplitSink<WebSocket, axum::extract::ws::Message>,
    mut receiver: futures_util::stream::SplitStream<WebSocket>,
    state: AppState,
    repo_path: String,
    repo_name: String,
) {
    println!("✅ Client connected: {} ({})", repo_name, repo_path);

    // Check if already connected
    {
        let clients = state.clients.read().await;
        if clients.contains_key(&repo_path) {
            let _ = sender.send(axum::extract::ws::Message::Text(
                serde_json::to_string(&Message::Error {
                    repo_path: Some(repo_path.clone()),
                    message: "Client already connected for this directory".to_string(),
                }).unwrap()
            )).await;
            return;
        }
    }

    // Create channel for this client
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // Register client
    {
        let mut clients = state.clients.write().await;
        clients.insert(repo_path.clone(), tx);
    }

    // Notify all browsers
    broadcast_to_browsers(&state, Message::ClientConnected {
        repo_path: repo_path.clone(),
        repo_name: repo_name.clone(),
    }).await;

    // Send client count to ALL clients (including this one)
    {
        let clients = state.clients.read().await;
        let count = clients.len();
        let count_msg = serde_json::to_string(&Message::ClientCount { count }).unwrap();
        for client_tx in clients.values() {
            let _ = client_tx.send(count_msg.clone());
        }
    }

    // Task 1: Forward messages from browsers to this client
    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(axum::extract::ws::Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    // Task 2: Forward messages from this client to browsers
    let state_clone = state.clone();
    let repo_path_clone = repo_path.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(axum::extract::ws::Message::Text(text))) = receiver.next().await {
            // Parse and add repo_path if needed
            if let Ok(mut msg) = serde_json::from_str::<Message>(&text) {
                // Ensure repo_path is set for client->browser messages
                match &mut msg {
                    Message::SessionsList { repo_path: rp, .. } |
                    Message::SessionCreated { repo_path: rp, .. } |
                    Message::SessionHistory { repo_path: rp, .. } |
                    Message::SessionUpdate { repo_path: rp, .. } |
                    Message::StreamStart { repo_path: rp, .. } |
                    Message::StreamEnd { repo_path: rp, .. } |
                    Message::ClaudeStream { repo_path: rp, .. } => {
                        *rp = repo_path_clone.clone();
                    }
                    Message::Error { repo_path: rp, .. } => {
                        *rp = Some(repo_path_clone.clone());
                    }
                    _ => {}
                }

                broadcast_to_browsers(&state_clone, msg).await;
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
        clients.remove(&repo_path);
    }

    // Notify browsers
    broadcast_to_browsers(&state, Message::ClientDisconnected {
        repo_path: repo_path.clone(),
    }).await;

    // Send updated client count to all remaining clients
    {
        let clients = state.clients.read().await;
        let count = clients.len();
        let count_msg = serde_json::to_string(&Message::ClientCount { count }).unwrap();
        for client_tx in clients.values() {
            let _ = client_tx.send(count_msg.clone());
        }
    }

    println!("❌ Client disconnected: {}", repo_name);
}

async fn handle_browser(
    mut sender: futures_util::stream::SplitSink<WebSocket, axum::extract::ws::Message>,
    mut receiver: futures_util::stream::SplitStream<WebSocket>,
    state: AppState,
) {
    println!("✅ Browser connected");

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // Register browser
    {
        let mut browsers = state.browsers.write().await;
        browsers.push(tx);
    }

    // Send current connected clients
    {
        let clients = state.clients.read().await;
        for repo_path in clients.keys() {
            let repo_name = repo_path.split('/').last().unwrap_or("unknown");
            let msg = Message::ClientConnected {
                repo_path: repo_path.clone(),
                repo_name: repo_name.to_string(),
            };
            let _ = sender.send(axum::extract::ws::Message::Text(
                serde_json::to_string(&msg).unwrap()
            )).await;
        }
    }

    // Task 1: Forward broadcasts to this browser
    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(axum::extract::ws::Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    // Task 2: Forward browser requests to appropriate clients
    let clients = state.clients.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(axum::extract::ws::Message::Text(text))) = receiver.next().await {
            if let Ok(msg) = serde_json::from_str::<Message>(&text) {
                // Route to appropriate client based on repo_path
                let repo_path = match &msg {
                    Message::ListSessions { repo_path } |
                    Message::CreateSession { repo_path } |
                    Message::CreateWorktreeSession { repo_path } |
                    Message::LoadSession { repo_path, .. } |
                    Message::SendMessage { repo_path, .. } => Some(repo_path.clone()),
                    _ => None,
                };

                if let Some(rp) = repo_path {
                    let clients_guard = clients.read().await;
                    if let Some(client_tx) = clients_guard.get(&rp) {
                        let _ = client_tx.send(text);
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

    // Cleanup - remove this browser from the list
    // Note: This is inefficient but browsers list should be small
    {
        let mut browsers = state.browsers.write().await;
        browsers.retain(|b| !b.is_closed());
    }

    println!("❌ Browser disconnected");
}

async fn broadcast_to_browsers(state: &AppState, msg: Message) {
    let browsers = state.browsers.read().await;
    let msg_text = serde_json::to_string(&msg).unwrap();

    for browser_tx in browsers.iter() {
        let _ = browser_tx.send(msg_text.clone());
    }
}