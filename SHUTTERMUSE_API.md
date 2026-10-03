# ShutterMuse 4-Bit HTTP Inference Server Guide

The **ShutterMuse 4-bit Server** provides real-time vision-language generation and COCO-17 human pose recommendation. It is optimized for NVIDIA GPUs with 6GB VRAM (such as the RTX 4050 Laptop GPU) by offloading visual embedding layers to the CPU while executing the language model and LM head on the GPU.

---

## 1. Quick Start

### Starting the Server
From `/home/fahim/projects/ladducam`:
```bash
./start_shuttermuse.sh
```

Or run directly with Python:
```bash
/home/fahim/miniconda3/bin/python shuttermuse_server.py --host 0.0.0.0 --port 8000
```

### Environment Variables
| Variable | Default | Description |
|---|---|---|
| `SHUTTERMUSE_MODEL_PATH` | `/home/fahim/projects/ladducam/ShutterMuse-4bit` | Path to model folder or HF repo |
| `SHUTTERMUSE_HOST` | `0.0.0.0` | Host interface |
| `SHUTTERMUSE_PORT` | `8000` | Port to bind |
| `PYTORCH_CUDA_ALLOC_CONF` | `expandable_segments:True` | Mitigates CUDA fragmentation |

---

## 2. API Endpoints Overview

| Method | Endpoint | Description | Typical Use Case |
|---|---|---|---|
| **GET** | `/health` | Server and GPU VRAM health status | Liveness checks, monitoring |
| **GET** | `/docs` | Interactive OpenAPI Swagger UI | Testing in browser |
| **POST** | `/api/text` | Text & multimodal vision-language generation | Photography advice, image critique |
| **POST** | `/api/pose-coco17` | Base64 image in $\rightarrow$ COCO-17 pose out | JSON payloads in automation pipelines |
| **POST** | `/api/pose-upload` | Multipart file upload in $\rightarrow$ rendered image/JSON out | Direct file uploads, n8n binary nodes |

---

## 3. Detailed Endpoint Reference

### Endpoint 1: `GET /health`
Returns server readiness and GPU memory utilization.

#### Response:
```json
{
  "status": "healthy",
  "model_loaded": true,
  "model_path": "/home/fahim/projects/ladducam/ShutterMuse-4bit",
  "gpu": {
    "device_name": "NVIDIA GeForce RTX 4050 Laptop GPU",
    "allocated_mb": 4911.39,
    "reserved_mb": 4928.0,
    "total_capacity_mb": 5770.81
  }
}
```

---

### Endpoint 2: `POST /api/text` (Text & Multimodal Chat)
Generate photography critique, composition tips, or answers to general prompts. Optionally accepts an `image_base64` field to perform vision-language analysis.

#### Request Headers:
`Content-Type: application/json`

#### Request Body Schema:
```json
{
  "prompt": "Give 3 quick tips for portrait photography lighting.",
  "system_prompt": "You are a professional photography tutor.",
  "image_base64": "<optional_base64_string>",
  "max_new_tokens": 512,
  "temperature": 0.7
}
```

#### Response Body:
```json
{
  "status": "success",
  "response": "1. Use the Rule of Thirds...\n2. Try 3-Point Lighting...",
  "latency_seconds": 6.84
}
```

#### cURL Example:
```bash
curl -X POST http://127.0.0.1:8000/api/text \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "How should I pose a subject standing near a window?",
    "max_new_tokens": 256
  }'
```

---

### Endpoint 3: `POST /api/pose-coco17` (COCO-17 Keypoint & Rendered Image)
Accepts a base64 encoded image, evaluates the subject and background, recommends a flattering pose, predicts the 17 standard COCO keypoint coordinates (`keypoints_xyn`), and renders the skeleton directly onto the image canvas.

#### Request Headers:
`Content-Type: application/json`

#### Request Body Schema:
```json
{
  "image_base64": "<base64_encoded_jpeg_or_png>",
  "custom_prompt": "Optional custom guidance (defaults to portrait pose recommendation)",
  "max_new_tokens": 512,
  "return_format": "json"
}
```
*Note: `return_format` can be either `"json"` or `"image"`.*

#### Response Body (`return_format='json'`):
```json
{
  "status": "success",
  "reason": "Natural standing pose with hands relaxed in pockets...",
  "keypoints_xyn": [
    [0.483, 0.344],
    [0.545, 0.278],
    [0.406, 0.296],
    ...
  ],
  "visibility": [1, 1, 1, 1, ...],
  "rendered_image_base64": "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
  "latency_seconds": 18.42
}
```

#### Raw Image Mode (`return_format='image'`):
When `return_format` is set to `"image"`, the endpoint responds with `Content-Type: image/jpeg` containing the raw JPEG image bytes with the COCO-17 skeleton plotted.
- Header `X-Latency-Seconds`: e.g. `18.42`
- Header `X-Keypoint-Count`: e.g. `17`

#### cURL Example (Return JSON):
```bash
IMAGE_B64=$(base64 -w 0 cat.jpg)
curl -X POST http://127.0.0.1:8000/api/pose-coco17 \
  -H "Content-Type: application/json" \
  -d "{
    \"image_base64\": \"$IMAGE_B64\",
    \"return_format\": \"json\"
  }"
```

#### cURL Example (Save Rendered Skeleton Image directly):
```bash
IMAGE_B64=$(base64 -w 0 cat.jpg)
curl -X POST http://127.0.0.1:8000/api/pose-coco17 \
  -H "Content-Type: application/json" \
  -d "{
    \"image_base64\": \"$IMAGE_B64\",
    \"return_format\": \"image\"
  }" \
  --output rendered_pose.jpg
```

---

### Endpoint 4: `POST /api/pose-upload` (Multipart File Upload)
Ideal for direct file uploads from forms, tools, or n8n binary nodes without needing prior base64 conversion.

#### Parameters:
- Form field `file`: Binary image file (JPEG, PNG, WebP)
- Query param `return_format`: `"image"` (default) or `"json"`
- Form field `custom_prompt`: (Optional) Custom pose guidance prompt

#### cURL Example (Save Output JPEG):
```bash
curl -X POST "http://127.0.0.1:8000/api/pose-upload?return_format=image" \
  -F "file=@cat.jpg" \
  --output pose_output.jpg
```

#### cURL Example (Get JSON with Base64 Image):
```bash
curl -X POST "http://127.0.0.1:8000/api/pose-upload?return_format=json" \
  -F "file=@cat.jpg"
```

---

## 4. Setting up with n8n

### Scenario A: Text & Multimodal Critique (`/api/text`)
1. Add an **HTTP Request** node in n8n.
2. Set **Method** to `POST`.
3. Set **URL** to `http://<your-host-ip>:8000/api/text`.
4. In **Body Parameters**:
   - Send Body: `JSON`
   - Specify:
     ```json
     {
       "prompt": "Evaluate this portrait composition and lighting.",
       "image_base64": "={{ $json.imageBase64 }}"
     }
     ```
5. The output item will contain `response` with the model's critique.

### Scenario B: COCO-17 Pose Recommendation with n8n Binary File
1. In n8n, when receiving an incoming image (e.g. from Telegram, Webhook, Google Drive, or LadduCam):
2. Add an **HTTP Request** node:
   - **Method**: `POST`
   - **URL**: `http://<your-host-ip>:8000/api/pose-upload?return_format=image`
   - **Send Body**: `Form-Data (Multipart)`
   - **Parameter Type**: `Binary Data`
   - **Input Data Field Name**: e.g., `data`
   - **Name**: `file`
   - **Response Format**: `File`
3. The next node receives the binary image with the 17-point COCO skeleton rendered directly on it, ready to be sent to Telegram, Discord, or saved to disk.
