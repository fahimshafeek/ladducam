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
                                "device": "LadduCam Mobile"
                            }).to_string();
                            let _ = tx_clone.send(state_msg);
                        }

                        // Send welcome handshake with server LAN IP
                        let welcome = json!({
                            "type": "welcome",
                            "status": "connected",
                            "server": "LadduCam Server (Rust)",
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

                                                if json_val.get("type").and_then(|t| t.as_str()) == Some("voice_note") {
                                                    if let Some(audio_base64) = json_val.get("audio").and_then(|a| a.as_str()) {
                                                        use base64::Engine;
                                                        let wav_bytes = base64::engine::general_purpose::STANDARD.decode(audio_base64).unwrap_or_default();
                                                        if !wav_bytes.is_empty() {
                                                            let temp_id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
                                                            let wav_path = format!("/tmp/voice_tauri_{}.wav", temp_id);
                                                            let mp3_path = format!("/tmp/voice_tauri_{}.mp3", temp_id);
                                                            let _ = tokio::fs::write(&wav_path, &wav_bytes).await;

                                                            let log_msg = json!({
                                                                "type": "log_entry",
                                                                "level": "info",
                                                                "message": format!("Received voice note ({} KB). Forwarding to n8n...", wav_bytes.len() / 1024),
                                                                "time": ""
                                                            }).to_string();
                                                            let _ = tx_clone.send(log_msg);

                                                            let status_msg = json!({
                                                                "type": "voice_status",
                                                                "status": "processing",
                                                                "message": "Workstation compute: Processing voice with n8n..."
                                                            }).to_string();
                                                            let _ = ws_stream.send(Message::Text(status_msg.into())).await;

                                                            let test_url = "http://localhost:5678/webhook-test/getvoice";
                                                            let prod_url = "http://localhost:5678/webhook/getvoice";

                                                            let mut success = false;
                                                            let cmd_test = tokio::process::Command::new("curl")
                                                                .args(["-s", "-w", "%{http_code}", "-X", "POST", "-F", &format!("file=@{}", wav_path), test_url, "-o", &mp3_path])
                                                                .output().await;

                                                            if let Ok(out) = cmd_test {
                                                                let code = String::from_utf8_lossy(&out.stdout);
                                                                if code.trim() == "200" {
                                                                    success = true;
                                                                }
                                                            }

                                                            if !success {
                                                                let _ = tokio::process::Command::new("curl")
                                                                    .args(["-s", "-X", "POST", "-F", &format!("file=@{}", wav_path), prod_url, "-o", &mp3_path])
                                                                    .output().await;
                                                            }

                                                            if let Ok(mp3_bytes) = tokio::fs::read(&mp3_path).await {
                                                                if !mp3_bytes.is_empty() {
                                                                    let mp3_b64 = base64::engine::general_purpose::STANDARD.encode(&mp3_bytes);
                                                                    let resp = json!({
                                                                        "type": "voice_response",
                                                                        "audio": mp3_b64,
                                                                        "format": "mp3",
                                                                        "timestamp": temp_id
                                                                    }).to_string();
                                                                    let _ = ws_stream.send(Message::Text(resp.into())).await;

                                                                    let success_log = json!({
                                                                        "type": "log_entry",
                                                                        "level": "success",
                                                                        "message": format!("Voice pipeline completed: Generated {} KB MP3. Sent to mobile.", mp3_bytes.len() / 1024),
                                                                        "time": ""
                                                                    }).to_string();
                                                                    let _ = tx_clone.send(success_log);
                                                                }
                                                            }

                                                            let _ = tokio::fs::remove_file(&wav_path).await;
                                                            let _ = tokio::fs::remove_file(&mp3_path).await;
                                                            continue;
                                                        }
                                                    }
                                                }
                                            }

                                            if is_mobile_msg || !is_loopback {
                                                let notify = json!({
                                                    "type": "client_state",
                                                    "connected": true,
                                                    "client_ip": client_ip,
                                                    "device": "LadduCam Mobile"
                                                }).to_string();
                                                let _ = tx_clone.send(notify);
                                            }

                                            let response = json!({
                                                "type": "pong",
                                                "timestamp": rtt_ts.unwrap_or(0),
                                                "server": "LadduCam Server",
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
