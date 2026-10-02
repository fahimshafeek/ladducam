use std::sync::Arc;
use tokio::net::TcpListener;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;
use futures_util::{StreamExt, SinkExt};
use tokio::sync::broadcast;
use serde_json::{json, Value};

fn get_host_lan_ip() -> String {
    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                let ip = addr.ip();
                if !ip.is_loopback() {
                    return ip.to_string();
                }
            }
        }
    }
    "127.0.0.1".to_string()
}

#[tauri::command]
fn get_local_ip() -> String {
    get_host_lan_ip()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_local_ip])
        .setup(|app| {
            if cfg!(debug_assertions) {
                let _ = app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                );
            }

            let lan_ip = get_host_lan_ip();
            log::info!("Detected workstation LAN IP: {}", lan_ip);

            // Create broadcast channel for inter-client communication
            let (tx, _rx) = broadcast::channel::<String>(100);
            let tx = Arc::new(tx);

            // Spawn Tokio WebSocket server on 0.0.0.0:8080
            tauri::async_runtime::spawn(async move {
                let addr = "0.0.0.0:8080";
                let listener = match TcpListener::bind(addr).await {
                    Ok(l) => {
                        log::info!("WebSocket server listening on {}", addr);
                        l
                    }
                    Err(e) => {
                        log::error!("Failed to bind WebSocket server on {}: {}", addr, e);
                        return;
                    }
                };

                while let Ok((stream, peer_addr)) = listener.accept().await {
                    let tx_clone = Arc::clone(&tx);
                    let mut rx = tx_clone.subscribe();

                    tokio::spawn(async move {
                        let mut ws_stream = match accept_async(stream).await {
                            Ok(ws) => ws,
                            Err(e) => {
                                log::error!("WebSocket handshake error from {}: {}", peer_addr, e);
                                return;
                            }
                        };

                        log::info!("New WebSocket client connected from: {}", peer_addr);

                        let is_loopback = peer_addr.ip().is_loopback();
                        let client_ip = peer_addr.ip().to_string();

                        if !is_loopback {
                            let state_msg = json!({
                                "type": "client_state",
                                "connected": true,
                                "client_ip": client_ip,
                                "device": "PoseCam Mobile"
                            }).to_string();
                            let _ = tx_clone.send(state_msg);
                        }

                        // Send welcome handshake with server LAN IP
                        let welcome = json!({
                            "type": "welcome",
                            "status": "connected",
                            "server": "PoseCam Server (Rust)",
                            "client_ip": client_ip,
                            "lan_ip": get_host_lan_ip()
                        }).to_string();
                        let _ = ws_stream.send(Message::Text(welcome.into())).await;

                        loop {
                            tokio::select! {
                                Ok(bcast_msg) = rx.recv() => {
                                    if ws_stream.send(Message::Text(bcast_msg.into())).await.is_err() {
                                        break;
                                    }
                                }
                                msg_option = ws_stream.next() => {
                                    match msg_option {
                                        Some(Ok(Message::Text(text))) => {
                                            let parsed: Result<Value, _> = serde_json::from_str(&text);
                                            let mut rtt_ts = None;
                                            let mut is_mobile_msg = false;

                                            if let Ok(ref json_val) = parsed {
                                                if json_val.get("role").and_then(|r| r.as_str()) == Some("mobile") {
                                                    is_mobile_msg = true;
                                                }
                                                if let Some(ts) = json_val.get("timestamp").and_then(|t| t.as_u64()) {
                                                    rtt_ts = Some(ts);
                                                }
                                            }

                                            if is_mobile_msg || !is_loopback {
                                                let notify = json!({
                                                    "type": "client_state",
                                                    "connected": true,
                                                    "client_ip": client_ip,
                                                    "device": "PoseCam Mobile"
                                                }).to_string();
                                                let _ = tx_clone.send(notify);
                                            }

                                            let response = json!({
                                                "type": "pong",
                                                "timestamp": rtt_ts.unwrap_or(0),
                                                "server": "PoseCam Server",
                                                "status": "connected"
                                            }).to_string();

                                            if ws_stream.send(Message::Text(response.into())).await.is_err() {
                                                break;
                                            }
                                        }
                                        Some(Ok(Message::Ping(payload))) => {
                                            if ws_stream.send(Message::Pong(payload)).await.is_err() {
                                                break;
                                            }
                                        }
                                        Some(Ok(Message::Close(_))) | None => break,
                                        Some(Err(_)) => break,
                                        _ => {}
                                    }
                                }
                            }
                        }

                        log::info!("WebSocket client disconnected: {}", peer_addr);

                        if !is_loopback {
                            let state_msg = json!({
                                "type": "client_state",
                                "connected": false,
                                "client_ip": client_ip
                            }).to_string();
                            let _ = tx_clone.send(state_msg);
                        }
                    });
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
